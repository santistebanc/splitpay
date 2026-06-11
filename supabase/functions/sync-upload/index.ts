import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, getErrorMessage, json } from "../_shared/cors.ts";
import { DUPLICATE_MEMBER_NAME_ERROR, memberDisplayNameTaken } from "../_shared/member-names.ts";
import { isActiveMember, memberBelongsToGroup } from "../_shared/membership.ts";

// sync-upload is the authorization boundary for all generic writes. It runs with
// the service role (bypassing RLS), so every operation must be explicitly
// authorized here:
//   - group creation and the *claiming* of a member (binding a user_id) are NOT
//     allowed through this path (use the create-group / join-group Edge
//     Functions instead). user_id is never client-writable here.
//   - members: an active member may create UNCLAIMED slots (PUT, insert-only),
//     rename their own claimed slot or any unclaimed slot (PATCH), and remove a
//     slot they're allowed to remove (soft-delete via PATCH deleted_at).
//   - groups may be PATCHed (e.g. rename) only by an active member; code and
//     has_password can never be changed from the client.
//   - expenses/splits/activity require the caller to be an active member of the
//     target group, and member references are validated against the group.

type Operation = {
  table: string;
  op: "PUT" | "PATCH" | "DELETE";
  id: string;
  data: Record<string, unknown> | null;
};

const safeColumns: Record<string, string[]> = {
  groups: ["name", "currency", "updated_at", "deleted_at"],
  members: ["display_name", "device_id", "updated_at"],
  expenses: ["group_id", "description", "amount_cents", "paid_by_member_id", "created_at", "updated_at", "deleted_at"],
  expense_splits: ["expense_id", "member_id", "created_at", "deleted_at"],
  activity_logs: ["group_id", "type", "actor_member_id", "actor_name", "summary", "metadata_json", "created_at"]
};

const dataTables = new Set(["expenses", "expense_splits", "activity_logs"]);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authHeader = request.headers.get("Authorization") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Missing Supabase function environment" }, 500);
  }

  const userClient = createClient(supabaseUrl, serviceRoleKey, {
    global: { headers: { Authorization: authHeader } }
  });
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) {
    return json({ error: "Unauthorized" }, 401);
  }
  const userId = userData.user.id;

  const body = (await request.json().catch(() => null)) as { operations?: Operation[] } | null;
  const operations = body?.operations;
  if (!Array.isArray(operations)) {
    return json({ error: "operations must be an array" }, 400);
  }

  try {
    for (const operation of operations) {
      const failure = await applyOperation(supabase, operation, userId);
      if (failure) return failure;
    }
  } catch (error) {
    return json({ error: getErrorMessage(error) }, 400);
  }

  return json({ ok: true });
});

async function applyOperation(
  supabase: SupabaseClient,
  operation: Operation,
  userId: string
): Promise<Response | null> {
  switch (operation.table) {
    case "groups":
      return applyGroupOperation(supabase, operation, userId);
    case "members":
      return applyMemberOperation(supabase, operation, userId);
    case "expenses":
    case "expense_splits":
    case "activity_logs":
      return applyDataOperation(supabase, operation, userId);
    default:
      return json({ error: `Unsupported table ${operation.table}` }, 400);
  }
}

async function applyGroupOperation(supabase: SupabaseClient, operation: Operation, userId: string) {
  // Group creation only happens via create-group.
  if (operation.op === "PUT") {
    return json({ error: "Groups must be created through create-group" }, 403);
  }
  if (operation.op === "DELETE") {
    return json({ error: "Groups cannot be deleted this way" }, 403);
  }
  // PATCH (e.g. rename) — must be an active member; code/has_password are never client-writable.
  if (!(await isActiveMember(supabase, operation.id, userId))) {
    return json({ error: "Not authorized for this group" }, 403);
  }
  const data = pick(operation.data ?? {}, safeColumns.groups);
  const { error } = await supabase.from("groups").update(data).eq("id", operation.id);
  if (error) return json({ error: error.message }, 400);
  return null;
}

async function applyMemberOperation(supabase: SupabaseClient, operation: Operation, userId: string) {
  const data = operation.data ?? {};

  if (operation.op === "PUT") {
    return createUnclaimedSlot(supabase, operation, userId);
  }

  if (operation.op === "DELETE") {
    // PowerSync uses PATCH (deleted_at) for soft-deletes; a hard DELETE op
    // would mean a true row removal, which we never do for members.
    return json({ error: "Members are removed via soft-delete" }, 403);
  }

  // PATCH. Load the target row so we can authorize against its current state.
  const { data: member, error: memberError } = await supabase
    .from("members")
    .select("id, group_id, user_id, deleted_at")
    .eq("id", operation.id)
    .maybeSingle();
  if (memberError) return json({ error: memberError.message }, 400);
  if (!member) return json({ error: "Member not found" }, 404);

  // Claiming (assigning/changing user_id) is server-only.
  if ("user_id" in data && data.user_id !== member.user_id) {
    return json({ error: "Claiming a member is done through join-group" }, 403);
  }

  const isOwner = member.user_id === userId;
  const isUnclaimed = member.user_id == null;
  const callerIsMember = await isActiveMember(supabase, member.group_id as string, userId);

  // Removal: PATCH that sets deleted_at. Owner may leave; any active member may
  // remove an unclaimed slot. A slot with history must be settled first.
  const removing = "deleted_at" in data && data.deleted_at != null && member.deleted_at == null;
  if (removing) {
    if (!(isOwner || (isUnclaimed && callerIsMember))) {
      return json({ error: "You can't remove this member" }, 403);
    }
    if (await hasLedgerHistory(supabase, operation.id)) {
      return json(
        { error: "This member has expenses. Settle and remove them first." },
        409
      );
    }
    const { error } = await supabase
      .from("members")
      .update({ deleted_at: data.deleted_at, updated_at: new Date().toISOString() })
      .eq("id", operation.id);
    if (error) return json({ error: error.message }, 400);
    return null;
  }

  // Rename / profile edit. Owner edits their own slot; an active member may
  // rename an unclaimed slot. device_id may only be set by the owner.
  if (!(isOwner || (isUnclaimed && callerIsMember))) {
    return json({ error: "You can only edit your own profile or an unclaimed member" }, 403);
  }
  const editable = isOwner ? safeColumns.members : ["display_name", "updated_at"];
  const update = pick(data, editable);
  if (Object.keys(update).length === 0) return null;
  if (typeof update.display_name === "string") {
    if (await memberDisplayNameTaken(supabase, member.group_id as string, update.display_name, operation.id)) {
      return json({ error: DUPLICATE_MEMBER_NAME_ERROR }, 409);
    }
  }
  const { error } = await supabase.from("members").update(update).eq("id", operation.id);
  if (error) return json({ error: error.message }, 400);
  return null;
}

// Creates an unclaimed member slot. Insert-only and never sets user_id, so it
// cannot overwrite an existing (possibly claimed) row — e.g. the creator's slot
// that create-group already bound. Any active member of the group may add slots.
async function createUnclaimedSlot(supabase: SupabaseClient, operation: Operation, userId: string) {
  const data = operation.data ?? {};
  if (data.user_id != null) {
    return json({ error: "New members are created unclaimed; use join-group to claim" }, 403);
  }
  const groupId = typeof data.group_id === "string" ? data.group_id : null;
  if (!groupId) return json({ error: "Could not resolve group for member" }, 400);
  if (!(await isActiveMember(supabase, groupId, userId))) {
    return json({ error: "Not authorized for this group" }, 403);
  }

  // Idempotent / safe against the creator-slot redundancy: if the row already
  // exists we leave it untouched (it may already be claimed server-side).
  const { data: existing, error: existingError } = await supabase
    .from("members")
    .select("id")
    .eq("id", operation.id)
    .maybeSingle();
  if (existingError) return json({ error: existingError.message }, 400);
  if (existing) return null;

  const displayName = typeof data.display_name === "string" ? data.display_name : "Member";
  if (await memberDisplayNameTaken(supabase, groupId, displayName)) {
    return json({ error: DUPLICATE_MEMBER_NAME_ERROR }, 409);
  }

  const now = new Date().toISOString();
  const { error } = await supabase.from("members").insert({
    id: operation.id,
    group_id: groupId,
    display_name: displayName,
    device_id: null,
    user_id: null,
    created_at: typeof data.created_at === "string" ? data.created_at : now,
    updated_at: now,
    deleted_at: null
  });
  if (error) return json({ error: error.message }, 400);
  return null;
}

// True if the member is referenced by any live expense (as payer) or split.
async function hasLedgerHistory(supabase: SupabaseClient, memberId: string): Promise<boolean> {
  const { count: payerCount, error: payerError } = await supabase
    .from("expenses")
    .select("id", { count: "exact", head: true })
    .eq("paid_by_member_id", memberId)
    .is("deleted_at", null);
  if (payerError) throw payerError;
  if ((payerCount ?? 0) > 0) return true;

  const { count: splitCount, error: splitError } = await supabase
    .from("expense_splits")
    .select("id", { count: "exact", head: true })
    .eq("member_id", memberId)
    .is("deleted_at", null);
  if (splitError) throw splitError;
  return (splitCount ?? 0) > 0;
}

async function applyDataOperation(supabase: SupabaseClient, operation: Operation, userId: string) {
  if (!dataTables.has(operation.table)) {
    return json({ error: `Unsupported table ${operation.table}` }, 400);
  }

  const groupId = await resolveGroupId(supabase, operation);
  if (!groupId) {
    return json({ error: "Could not resolve group for operation" }, 400);
  }
  if (!(await isActiveMember(supabase, groupId, userId))) {
    return json({ error: "Not authorized for this group" }, 403);
  }

  const data = pick(operation.data ?? {}, safeColumns[operation.table]);

  // Validate member references belong to the target group.
  if (operation.table === "expenses" && operation.op !== "DELETE") {
    const payer = data.paid_by_member_id;
    if (typeof payer === "string" && !(await memberBelongsToGroup(supabase, groupId, payer))) {
      return json({ error: "Payer is not a member of this group" }, 400);
    }
  }
  if (operation.table === "expense_splits" && operation.op !== "DELETE") {
    const splitMember = data.member_id;
    if (typeof splitMember === "string" && !(await memberBelongsToGroup(supabase, groupId, splitMember))) {
      return json({ error: "Split member is not in this group" }, 400);
    }
  }

  if (operation.op === "DELETE") {
    const { error } = await supabase
      .from(operation.table)
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", operation.id);
    if (error) return json({ error: error.message }, 400);
    return null;
  }

  if (operation.op === "PUT") {
    const { error } = await supabase
      .from(operation.table)
      .upsert({ id: operation.id, ...data }, { onConflict: "id" });
    if (error) return json({ error: error.message }, 400);
    return null;
  }

  // PATCH
  const { error } = await supabase.from(operation.table).update(data).eq("id", operation.id);
  if (error) return json({ error: error.message }, 400);
  return null;
}

// Determines which group an op belongs to, from its data (inserts) or by
// looking up the existing row (updates/deletes).
async function resolveGroupId(supabase: SupabaseClient, operation: Operation): Promise<string | null> {
  const data = operation.data ?? {};

  if (operation.table === "expenses") {
    if (operation.op === "PUT" && typeof data.group_id === "string") return data.group_id;
    const { data: row } = await supabase.from("expenses").select("group_id").eq("id", operation.id).maybeSingle();
    return (row?.group_id as string | undefined) ?? null;
  }

  if (operation.table === "activity_logs") {
    if (operation.op === "PUT" && typeof data.group_id === "string") return data.group_id;
    const { data: row } = await supabase.from("activity_logs").select("group_id").eq("id", operation.id).maybeSingle();
    return (row?.group_id as string | undefined) ?? null;
  }

  if (operation.table === "expense_splits") {
    const expenseId =
      operation.op === "PUT" && typeof data.expense_id === "string"
        ? data.expense_id
        : await lookupSplitExpenseId(supabase, operation.id);
    if (!expenseId) return null;
    const { data: expense } = await supabase.from("expenses").select("group_id").eq("id", expenseId).maybeSingle();
    return (expense?.group_id as string | undefined) ?? null;
  }

  return null;
}

async function lookupSplitExpenseId(supabase: SupabaseClient, splitId: string): Promise<string | null> {
  const { data } = await supabase.from("expense_splits").select("expense_id").eq("id", splitId).maybeSingle();
  return (data?.expense_id as string | undefined) ?? null;
}

function pick(data: Record<string, unknown>, columns: string[]) {
  const result: Record<string, unknown> = {};
  for (const key of columns) {
    if (key in data) result[key] = data[key];
  }
  return result;
}
