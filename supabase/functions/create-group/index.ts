import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, getErrorMessage, json } from "../_shared/cors.ts";
import { findActiveMembership } from "../_shared/membership.ts";
import { hashPassword } from "../_shared/password.ts";

const MIN_PASSWORD_LENGTH = 4;

// Ratifies a locally-created (offline) group on the server. This is the only
// way a group + its initial members come into existence server-side; the
// generic sync-upload path only allows *unclaimed* member slots, never the
// creator's claimed binding. Idempotent: safe to retry. Cannot be used to join
// an existing group (that path is join-group).
//
// A group is created with a list of named member "slots". Exactly one of them
// is the creator, identified by `creatorMemberId`; that slot is bound to the
// caller's user_id (it is "claimed"). Every other slot is created unclaimed
// (user_id NULL) so anyone can later claim it via join-group.

type IncomingMember = {
  id?: string;
  name?: string;
  displayName?: string;
  deviceId?: string | null;
  createdAt?: string;
};

type CreateRequest = {
  groupId?: string;
  code?: string;
  name?: string;
  currency?: string;
  createdAt?: string;
  creatorMemberId?: string;
  members?: IncomingMember[];
  password?: string | null;
  // Back-compat: the old single-member shape.
  member?: {
    id?: string;
    displayName?: string;
    deviceId?: string | null;
  };
};

type NormalizedMember = {
  id: string;
  name: string;
  deviceId: string | null;
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

  const { members, creatorMemberId } = normalizeMembers(body);

  if (!groupId || !code || !name || members.length === 0 || !creatorMemberId) {
    return json(
      { error: "groupId, code, name, members and creatorMemberId are required" },
      400
    );
  }
  if (!members.some((member) => member.id === creatorMemberId)) {
    return json({ error: "creatorMemberId must be one of the members" }, 400);
  }

  try {
    const { data: existingGroup, error: existingError } = await supabase
      .from("groups")
      .select("id, code")
      .eq("id", groupId)
      .maybeSingle();
    if (existingError) throw existingError;

    if (existingGroup) {
      // Group already ratified. Only an existing active member may "re-ratify"
      // (idempotent retry). Reject anyone else so this can't be used to join.
      const membership = await findActiveMembership(supabase, groupId, userId);
      if (!membership) {
        return json({ error: "Group already exists" }, 409);
      }
      await applyOptionalPassword(supabase, groupId, body?.password);
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

    // Insert every slot. Only the creator's slot is claimed (bound to the
    // caller's user_id and device); all others are unclaimed (user_id NULL).
    const rows = members.map((member) => ({
      id: member.id,
      group_id: groupId,
      display_name: member.name,
      device_id: member.id === creatorMemberId ? member.deviceId : null,
      user_id: member.id === creatorMemberId ? userId : null,
      created_at: createdAt,
      updated_at: now,
      deleted_at: null
    }));

    const { error: memberError } = await supabase.from("members").insert(rows);
    if (memberError) throw memberError;

    await applyOptionalPassword(supabase, groupId, body?.password);

    return json({ code: finalCode, creatorMemberId });
  } catch (error) {
    return json({ error: getErrorMessage(error) }, 400);
  }
});

// Accepts either the new `members[]` + `creatorMemberId` shape or the legacy
// single `member` shape, and returns a normalized member list.
function normalizeMembers(body: CreateRequest | null): {
  members: NormalizedMember[];
  creatorMemberId: string;
} {
  if (body?.members && body.members.length > 0) {
    const members = body.members
      .map((member) => ({
        id: member.id?.trim() ?? "",
        name: (member.name ?? member.displayName)?.trim() || "Member",
        deviceId: member.deviceId?.trim() || null
      }))
      .filter((member) => member.id);
    const creatorMemberId = body.creatorMemberId?.trim() || members[0]?.id || "";
    return { members, creatorMemberId };
  }

  const legacy = body?.member;
  if (legacy?.id?.trim()) {
    const id = legacy.id.trim();
    return {
      members: [
        {
          id,
          name: legacy.displayName?.trim() || "Member",
          deviceId: legacy.deviceId?.trim() || null
        }
      ],
      creatorMemberId: id
    };
  }

  return { members: [], creatorMemberId: "" };
}

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

async function applyOptionalPassword(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  groupId: string,
  rawPassword: string | null | undefined
) {
  const password = typeof rawPassword === "string" ? rawPassword.trim() : "";
  if (!password) return;
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const now = new Date().toISOString();
  const passwordHash = await hashPassword(password);
  const { error: upsertError } = await supabase
    .from("group_secrets")
    .upsert({ group_id: groupId, password_hash: passwordHash, updated_at: now }, { onConflict: "group_id" });
  if (upsertError) throw upsertError;

  const { error: groupError } = await supabase
    .from("groups")
    .update({ has_password: true, updated_at: now })
    .eq("id", groupId);
  if (groupError) throw groupError;
}
