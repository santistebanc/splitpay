import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// Coarse server-side rate limiting for password-gated join attempts, backed by
// the server-only `join_attempts` table. Keyed by (group_id, user_id) so a
// single anonymous user can't brute force a group's password. Window + ceiling
// are intentionally conservative; combined with the slow PBKDF2 hash this makes
// guessing expensive.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

export async function tooManyAttempts(
  supabase: SupabaseClient,
  groupId: string,
  userId: string
): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { count, error } = await supabase
    .from("join_attempts")
    .select("id", { count: "exact", head: true })
    .eq("group_id", groupId)
    .eq("user_id", userId)
    .gte("created_at", since);
  if (error) throw error;
  return (count ?? 0) >= MAX_ATTEMPTS;
}

export async function recordAttempt(
  supabase: SupabaseClient,
  groupId: string,
  userId: string,
  success: boolean
) {
  await supabase.from("join_attempts").insert({
    id: crypto.randomUUID(),
    group_id: groupId,
    user_id: userId,
    success,
    created_at: new Date().toISOString()
  });
}
