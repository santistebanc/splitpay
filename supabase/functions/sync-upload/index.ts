import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, getErrorMessage, json } from "../_shared/cors.ts";
import { isActiveMember, memberBelongsToGroup } from "../_shared/membership.ts";

// sync-upload is the authorization boundary for all generic writes. It runs with
// the service role (bypassing RLS), so every operation must be explicitly
// authorized here:
//   - groups/members lifecycle is NOT allowed through this path (use the
//     create-group / join-group / set-password Edge Functions instead).
//   - members may PATCH only their own row's safe fields.
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
  // Membership is created server-side only (create-group / join-group).
  if (operation.op === "PUT") {
    return json({ error: "Membership is managed by create-group / join-group" }, 403);
  }
  if (operation.op === "DELETE") {
    return json({ error: "Removing members is not supported" }, 403);
  }
  // PATCH: a member may only edit their own row's safe fields.
  const { data: member, error: memberError } = await supabase
    .from("members")
    .select("id, user_id")
    .eq("id", operation.id)
    .maybeSingle();
  if (memberError) return json({ error: memberError.message }, 400);
  if (!member || member.user_id !== userId) {
    return json({ error: "You can only edit your own member profile" }, 403);
  }
  const data = pick(operation.data ?? {}, safeColumns.members);
  const { error } = await supabase.from("members").update(data).eq("id", operation.id);
  if (error) return json({ error: error.message }, 400);
  return null;
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
