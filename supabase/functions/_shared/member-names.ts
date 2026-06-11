import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const DUPLICATE_MEMBER_NAME_ERROR = "That name is already in this group";

export function normalizeMemberName(name: string): string {
  return name.trim().toLowerCase();
}

export async function memberDisplayNameTaken(
  supabase: SupabaseClient,
  groupId: string,
  displayName: string,
  excludeMemberId?: string
): Promise<boolean> {
  const normalized = normalizeMemberName(displayName);
  if (!normalized) return false;

  const { data, error } = await supabase
    .from("members")
    .select("id, display_name")
    .eq("group_id", groupId)
    .is("deleted_at", null);
  if (error) throw error;

  return (data ?? []).some(
    (member) =>
      member.id !== excludeMemberId && normalizeMemberName(String(member.display_name)) === normalized
  );
}
