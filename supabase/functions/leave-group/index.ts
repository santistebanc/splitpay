import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, getErrorMessage, json } from "../_shared/cors.ts";

type LeaveRequest = {
  groupId?: string;
};

// Releases the caller's claimed member slot so someone else can claim it on join.
// The member row stays (name and expense history remain); only user_id and
// device_id are cleared. Idempotent if the caller already left.
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

  const body = (await request.json().catch(() => null)) as LeaveRequest | null;
  const groupId = body?.groupId?.trim() ?? "";
  if (!groupId) {
    return json({ error: "groupId is required" }, 400);
  }

  try {
    const { data: member, error: memberError } = await supabase
      .from("members")
      .select("id, display_name")
      .eq("group_id", groupId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (memberError) throw memberError;

    if (!member) {
      return json({ ok: true, released: false });
    }

    const now = new Date().toISOString();
    const { error: releaseError } = await supabase
      .from("members")
      .update({
        user_id: null,
        device_id: null,
        updated_at: now
      })
      .eq("id", member.id)
      .eq("group_id", groupId);
    if (releaseError) throw releaseError;

    const { error: activityError } = await supabase.from("activity_logs").insert({
      id: crypto.randomUUID(),
      group_id: groupId,
      type: "member.left",
      actor_member_id: member.id,
      actor_name: member.display_name,
      summary: `${member.display_name} left`,
      metadata_json: JSON.stringify({ displayName: member.display_name, memberId: member.id }),
      created_at: now
    });
    if (activityError) throw activityError;

    return json({ ok: true, released: true, memberId: member.id });
  } catch (error) {
    return json({ error: getErrorMessage(error) }, 400);
  }
});
