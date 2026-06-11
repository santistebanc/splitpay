import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, getErrorMessage, json } from "../_shared/cors.ts";
import { verifyPassword } from "../_shared/password.ts";
import { recordAttempt, tooManyAttempts } from "../_shared/rate-limit.ts";

type JoinRequest = {
  code?: string;
  displayName?: string;
  deviceId?: string;
  password?: string;
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

  const body = (await request.json().catch(() => null)) as JoinRequest | null;
  const code = body?.code?.trim().toUpperCase() ?? "";
  const displayName = body?.displayName?.trim() || "Friend";
  const deviceId = body?.deviceId?.trim() || null;
  const password = typeof body?.password === "string" ? body.password : "";

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

  // Password gate for protected groups.
  if (group.has_password) {
    try {
      if (await tooManyAttempts(supabase, group.id, userData.user.id)) {
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
      await recordAttempt(supabase, group.id, userData.user.id, ok);
      if (!ok) {
        return json({ error: GENERIC_DENIED, needsPassword: true }, 401);
      }
    } catch (error) {
      return json({ error: getErrorMessage(error) }, 400);
    }
  }

  const now = new Date().toISOString();
  const { data: existingMember, error: existingMemberError } = await supabase
    .from("members")
    .select("*")
    .eq("group_id", group.id)
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (existingMemberError) return json({ error: existingMemberError.message }, 400);

  const memberId = existingMember?.id ?? crypto.randomUUID();
  const memberPayload = {
    id: memberId,
    group_id: group.id,
    display_name: displayName,
    device_id: deviceId,
    user_id: userData.user.id,
    created_at: existingMember?.created_at ?? now,
    updated_at: now,
    deleted_at: null
  };

  const { error: memberError } = await supabase
    .from("members")
    .upsert(memberPayload, { onConflict: "id" });

  if (memberError) return json({ error: memberError.message }, 400);

  const activityId = crypto.randomUUID();
  const { error: activityError } = await supabase.from("activity_logs").insert({
    id: activityId,
    group_id: group.id,
    type: existingMember?.deleted_at ? "member.rejoined" : "member.joined",
    actor_member_id: memberId,
    actor_name: displayName,
    summary: existingMember?.deleted_at ? `${displayName} rejoined` : `${displayName} joined`,
    metadata_json: JSON.stringify({ displayName }),
    created_at: now
  });

  if (activityError) return json({ error: activityError.message }, 400);

  try {
    const snapshot = await loadSnapshot(supabase, group.id);
    return json(snapshot);
  } catch (error) {
    return json({ error: getErrorMessage(error) }, 400);
  }
});

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
