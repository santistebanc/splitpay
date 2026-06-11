import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, getErrorMessage, json } from "../_shared/cors.ts";
import { findActiveMembership } from "../_shared/membership.ts";

// Ratifies a locally-created (offline) group on the server. This is the only
// way a group + its first member come into existence server-side; the generic
// sync-upload path rejects client-side group/member inserts. Idempotent: safe
// to retry. Cannot be used to join an existing group (that path is join-group).

type CreateRequest = {
  groupId?: string;
  code?: string;
  name?: string;
  currency?: string;
  createdAt?: string;
  member?: {
    id?: string;
    displayName?: string;
    deviceId?: string;
  };
};

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

  const body = (await request.json().catch(() => null)) as CreateRequest | null;
  const groupId = body?.groupId?.trim() ?? "";
  const code = body?.code?.trim().toUpperCase() ?? "";
  const name = body?.name?.trim() ?? "";
  const currency = body?.currency?.trim() || "EUR";
  const createdAt = body?.createdAt ?? new Date().toISOString();
  const memberId = body?.member?.id?.trim() ?? "";
  const displayName = body?.member?.displayName?.trim() || "Friend";
  const deviceId = body?.member?.deviceId?.trim() || null;

  if (!groupId || !code || !name || !memberId) {
    return json({ error: "groupId, code, name and member.id are required" }, 400);
  }

  try {
    const { data: existingGroup, error: existingError } = await supabase
      .from("groups")
      .select("id, code")
      .eq("id", groupId)
      .maybeSingle();
    if (existingError) throw existingError;

    if (existingGroup) {
      // Group already ratified. Only the existing creator/member may "re-ratify"
      // (idempotent retry). Reject anyone else so this can't be used to join.
      const membership = await findActiveMembership(supabase, groupId, userId);
      if (!membership) {
        return json({ error: "Group already exists" }, 409);
      }
      return json({ code: existingGroup.code });
    }

    const now = new Date().toISOString();
    // Prefer the client's code, but the server is the authority on uniqueness.
    // On the rare collision we mint a fresh code and return it; PowerSync then
    // reconciles the local row on download. This keeps create-group from ever
    // permanently wedging a client's upload queue on a code clash.
    const finalCode = await insertGroupWithUniqueCode(supabase, {
      groupId,
      code,
      name,
      currency,
      createdAt,
      now
    });

    const { error: memberError } = await supabase.from("members").insert({
      id: memberId,
      group_id: groupId,
      display_name: displayName,
      device_id: deviceId,
      user_id: userId,
      created_at: createdAt,
      updated_at: now,
      deleted_at: null
    });
    if (memberError) throw memberError;

    return json({ code: finalCode });
  } catch (error) {
    return json({ error: getErrorMessage(error) }, 400);
  }
});

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode() {
  return Array.from(
    { length: 5 },
    () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  ).join("");
}

// Inserts the group, retrying with a fresh server-generated code if the
// proposed code collides. Returns the code that actually persisted.
async function insertGroupWithUniqueCode(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  input: {
    groupId: string;
    code: string;
    name: string;
    currency: string;
    createdAt: string;
    now: string;
  }
): Promise<string> {
  let candidate = input.code;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { error } = await supabase.from("groups").insert({
      id: input.groupId,
      code: candidate,
      name: input.name,
      currency: input.currency,
      has_password: false,
      created_at: input.createdAt,
      updated_at: input.now,
      deleted_at: null
    });

    if (!error) return candidate;

    // 23505 = unique_violation. Only a code clash is retryable; an id clash
    // means a concurrent ratification we can't resolve here.
    const code = (error as { code?: string }).code;
    const message = (error as { message?: string }).message ?? "";
    const isCodeClash = code === "23505" && message.toLowerCase().includes("code");
    if (!isCodeClash) throw error;

    candidate = generateCode();
  }

  throw new Error("Could not allocate a unique group code");
}
