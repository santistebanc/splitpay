import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, getErrorMessage, json } from "../_shared/cors.ts";
import { DUPLICATE_MEMBER_NAME_ERROR, memberDisplayNameTaken } from "../_shared/member-names.ts";
import { verifyPassword } from "../_shared/password.ts";
import { recordAttempt, tooManyAttempts } from "../_shared/rate-limit.ts";

type JoinRequest = {
  code?: string;
  displayName?: string;
  deviceId?: string;
  password?: string;
  // When set, the caller claims this existing (unclaimed) member slot instead
  // of creating a brand-new member.
  memberId?: string;
  // When true, only return the slot list (taken/available) without joining.
  preview?: boolean;
};

// Returned to clients so the UI can prompt for a password without leaking
// whether a given code exists.
const GENERIC_DENIED = "Wrong code or password";

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

  const authClient = createClient(supabaseUrl, serviceRoleKey, {
    global: { headers: { Authorization: authHeader } }
  });
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data: userData, error: userError } = await authClient.auth.getUser();

  if (userError || !userData.user) {
    return json({ error: "Unauthorized" }, 401);
  }
  const userId = userData.user.id;

  const body = (await request.json().catch(() => null)) as JoinRequest | null;
  const code = body?.code?.trim().toUpperCase() ?? "";
  const displayName = body?.displayName?.trim() || "Member";
  const deviceId = body?.deviceId?.trim() || null;
  const password = typeof body?.password === "string" ? body.password : "";
  const requestedMemberId = body?.memberId?.trim() || null;
  const preview = body?.preview === true;

  if (!code) {
    return json({ error: "Group code is required" }, 400);
  }

  const { data: group, error: groupError } = await supabase
    .from("groups")
    .select("*")
    .eq("code", code)
    .is("deleted_at", null)
    .maybeSingle();

  if (groupError) return json({ error: groupError.message }, 400);
  // Generic message so attackers can't enumerate which codes exist.
  if (!group) return json({ error: GENERIC_DENIED, needsPassword: false }, 404);

  // Password gate for protected groups (applies to preview as well, so the
  // slot list is only revealed to someone who knows the password).
  if (group.has_password) {
    try {
      if (await tooManyAttempts(supabase, group.id, userId)) {
        return json({ error: "Too many attempts. Try again later." }, 429);
      }
      if (!password) {
        return json({ error: "This group is password protected", needsPassword: true }, 401);
      }
      const { data: secret, error: secretError } = await supabase
        .from("group_secrets")
        .select("password_hash")
        .eq("group_id", group.id)
        .maybeSingle();
      if (secretError) throw secretError;

      const ok = secret ? await verifyPassword(password, secret.password_hash) : false;
      await recordAttempt(supabase, group.id, userId, ok);
      if (!ok) {
        return json({ error: GENERIC_DENIED, needsPassword: true }, 401);
      }
    } catch (error) {
      return json({ error: getErrorMessage(error) }, 400);
    }
  }

  // Preview mode: return the slot list without assigning anything.
  if (preview) {
    try {
      const slots = await loadSlots(supabase, group.id);
      return json({ members: slots, hasPassword: Boolean(group.has_password) });
    } catch (error) {
      return json({ error: getErrorMessage(error) }, 400);
    }
  }

  const now = new Date().toISOString();

  // Already a member? Re-joining the same slot is idempotent. Picking a different
  // slot or "someone else" releases the old claim first.
  const { data: existingMember, error: existingMemberError } = await supabase
    .from("members")
    .select("*")
    .eq("group_id", group.id)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();

  if (existingMemberError) return json({ error: existingMemberError.message }, 400);

  if (existingMember) {
    const rejoiningSameSlot =
      requestedMemberId !== null && requestedMemberId === existingMember.id;

    if (rejoiningSameSlot) {
      const { error: updateError } = await supabase
        .from("members")
        .update({
          device_id: deviceId,
          display_name: displayName,
          updated_at: now
        })
        .eq("id", existingMember.id);
      if (updateError) return json({ error: updateError.message }, 400);

      try {
        const snapshot = await loadSnapshot(supabase, group.id);
        return json({ ...snapshot, claimedMemberId: existingMember.id });
      } catch (error) {
        return json({ error: getErrorMessage(error) }, 400);
      }
    }

    const { error: releaseError } = await supabase
      .from("members")
      .update({
        user_id: null,
        device_id: null,
        updated_at: now
      })
      .eq("id", existingMember.id)
      .eq("group_id", group.id);
    if (releaseError) return json({ error: releaseError.message }, 400);
  }

  let claimedMemberId: string;

  if (requestedMemberId) {
    // Claim an existing unclaimed slot. The WHERE clause is the atomic guard:
    // it only succeeds if the slot is still unclaimed, so two racing joiners
    // can never both win the same slot.
    const { data: claimed, error: claimError } = await supabase
      .from("members")
      .update({
        user_id: userId,
        device_id: deviceId,
        display_name: displayName,
        updated_at: now
      })
      .eq("id", requestedMemberId)
      .eq("group_id", group.id)
      .is("user_id", null)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle();

    if (claimError) return json({ error: claimError.message }, 400);
    if (!claimed) {
      // Slot was taken (or doesn't exist) — hand back a fresh list so the UI
      // can re-render which slots are still available.
      try {
        const slots = await loadSlots(supabase, group.id);
        return json(
          { error: "That member was just taken. Pick another.", members: slots },
          409
        );
      } catch (error) {
        return json({ error: getErrorMessage(error) }, 400);
      }
    }
    claimedMemberId = claimed.id;
  } else {
    // No slot chosen — create a brand-new claimed member.
    if (await memberDisplayNameTaken(supabase, group.id, displayName)) {
      return json({ error: DUPLICATE_MEMBER_NAME_ERROR }, 409);
    }
    claimedMemberId = crypto.randomUUID();
    const { error: memberError } = await supabase.from("members").insert({
      id: claimedMemberId,
      group_id: group.id,
      display_name: displayName,
      device_id: deviceId,
      user_id: userId,
      created_at: now,
      updated_at: now,
      deleted_at: null
    });
    if (memberError) return json({ error: memberError.message }, 400);
  }

  const { error: activityError } = await supabase.from("activity_logs").insert({
    id: crypto.randomUUID(),
    group_id: group.id,
    type: "member.joined",
    actor_member_id: claimedMemberId,
    actor_name: displayName,
    summary: `${displayName} joined`,
    metadata_json: JSON.stringify({ displayName, claimedExisting: Boolean(requestedMemberId) }),
    created_at: now
  });

  if (activityError) return json({ error: activityError.message }, 400);

  try {
    const snapshot = await loadSnapshot(supabase, group.id);
    return json({ ...snapshot, claimedMemberId });
  } catch (error) {
    return json({ error: getErrorMessage(error) }, 400);
  }
});

// Lightweight slot list for the join picker: name + whether it's already taken.
async function loadSlots(supabase: ReturnType<typeof createClient>, groupId: string) {
  const { data, error } = await supabase
    .from("members")
    .select("id, display_name, user_id")
    .eq("group_id", groupId)
    .is("deleted_at", null)
    .order("created_at");
  if (error) throw error;
  return (data ?? []).map((member) => ({
    id: member.id as string,
    name: member.display_name as string,
    claimed: member.user_id != null
  }));
}

async function loadSnapshot(supabase: ReturnType<typeof createClient>, groupId: string) {
  const [groupResult, membersResult, expensesResult, splitsResult, logsResult] = await Promise.all([
    supabase.from("groups").select("*").eq("id", groupId).single(),
    supabase.from("members").select("*").eq("group_id", groupId).is("deleted_at", null).order("created_at"),
    supabase.from("expenses").select("*").eq("group_id", groupId).is("deleted_at", null).order("created_at", { ascending: false }),
    supabase
      .from("expense_splits")
      .select("*, expenses!inner(group_id)")
      .eq("expenses.group_id", groupId)
      .is("deleted_at", null),
    supabase.from("activity_logs").select("*").eq("group_id", groupId).order("created_at", { ascending: false }).limit(100)
  ]);

  for (const result of [groupResult, membersResult, expensesResult, splitsResult, logsResult]) {
    if (result.error) throw result.error;
  }

  return {
    group: groupResult.data,
    members: membersResult.data ?? [],
    expenses: expensesResult.data ?? [],
    expense_splits: (splitsResult.data ?? []).map(({ expenses: _expenses, ...split }) => split),
    activity_logs: logsResult.data ?? []
  };
}
