import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, getErrorMessage, json } from "../_shared/cors.ts";
import { isActiveMember } from "../_shared/membership.ts";
import { hashPassword } from "../_shared/password.ts";

// Sets, changes, or removes a group's join password. Any active member may do
// this (flat trust model). Online-only by nature. The hash lives in the
// server-only group_secrets table; the client only ever sees groups.has_password.

type SetPasswordRequest = {
  groupId?: string;
  // A non-empty string sets/changes the password; null or "" removes it.
  password?: string | null;
};

const MIN_PASSWORD_LENGTH = 4;

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

  const body = (await request.json().catch(() => null)) as SetPasswordRequest | null;
  const groupId = body?.groupId?.trim() ?? "";
  const rawPassword = typeof body?.password === "string" ? body.password : null;
  const password = rawPassword && rawPassword.length > 0 ? rawPassword : null;

  if (!groupId) {
    return json({ error: "groupId is required" }, 400);
  }
  if (password !== null && password.length < MIN_PASSWORD_LENGTH) {
    return json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 400);
  }

  try {
    if (!(await isActiveMember(supabase, groupId, userId))) {
      return json({ error: "You are not a member of this group" }, 403);
    }

    const now = new Date().toISOString();

    if (password === null) {
      const { error: deleteError } = await supabase
        .from("group_secrets")
        .delete()
        .eq("group_id", groupId);
      if (deleteError) throw deleteError;
    } else {
      const passwordHash = await hashPassword(password);
      const { error: upsertError } = await supabase
        .from("group_secrets")
        .upsert({ group_id: groupId, password_hash: passwordHash, updated_at: now }, { onConflict: "group_id" });
      if (upsertError) throw upsertError;
    }

    const { error: groupError } = await supabase
      .from("groups")
      .update({ has_password: password !== null, updated_at: now })
      .eq("id", groupId);
    if (groupError) throw groupError;

    return json({ ok: true, hasPassword: password !== null });
  } catch (error) {
    return json({ error: getErrorMessage(error) }, 400);
  }
});
