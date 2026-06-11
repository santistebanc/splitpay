import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Returns the caller's active member row in a group, or null. This is the
// authorization primitive for writes: callers may only mutate group data they
// are an active member of.
export async function findActiveMembership(
  supabase: SupabaseClient,
  groupId: string,
  userId: string
) {
  const { data, error } = await supabase
    .from("members")
    .select("id, group_id, user_id")
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function isActiveMember(supabase: SupabaseClient, groupId: string, userId: string) {
  return (await findActiveMembership(supabase, groupId, userId)) !== null;
}

// Confirms a member id belongs to the given group (used to validate expense
// payer / split references server-side).
export async function memberBelongsToGroup(
  supabase: SupabaseClient,
  groupId: string,
  memberId: string
) {
  const { data, error } = await supabase
    .from("members")
    .select("id")
    .eq("group_id", groupId)
    .eq("id", memberId)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}
