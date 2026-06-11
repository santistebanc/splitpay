export const DUPLICATE_MEMBER_NAME_ERROR = "That name is already in this group";
export const DEFAULT_MEMBER_NAME = "Member";

export function normalizeMemberName(name: string): string {
  return name.trim().toLowerCase();
}

export function isMemberNameTaken(names: string[], candidate: string, excludeName?: string): boolean {
  const normalized = normalizeMemberName(candidate);
  if (!normalized) return false;
  const excluded = excludeName ? normalizeMemberName(excludeName) : null;
  return names.some((name) => {
    const existing = normalizeMemberName(name);
    if (excluded && existing === excluded) return false;
    return existing === normalized;
  });
}
