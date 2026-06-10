/**
 * Shared permission helper — resolves whether a user can perform an action.
 *
 * Resolution order (per CLAUDE.md):
 *   1. admin role (any role row = 'admin')                  → always allowed
 *   2. user_permission_overrides WHERE user_id = this_user  → use `granted` if row exists
 *   3. role_permissions WHERE role IN user's roles          → fallback (true if ANY role allows)
 *
 * Mirrors the UI's usePermissions().can() iteration pattern.
 * Supports users with multiple role rows in user_roles.
 */
export async function checkPermission(
  supabase: any,
  userId: string,
  permissionKey: string
): Promise<boolean> {
  // Fetch ALL of the user's role rows (multi-role users supported)
  const { data: userRoles } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);

  if (!userRoles || userRoles.length === 0) return false;
  const roles = userRoles.map((r: any) => r.role);

  // Admin always allowed (CLAUDE.md rule — overrides everything else)
  if (roles.includes("admin")) return true;

  // Check user_permission_overrides first
  const { data: override } = await supabase
    .from("user_permission_overrides")
    .select("granted")
    .eq("user_id", userId)
    .eq("permission_key", permissionKey)
    .maybeSingle();

  if (override !== null && override !== undefined) {
    return override.granted;
  }

  // Fall back to role_permissions — true if ANY of user's roles allows it
  const { data: rolePerms } = await supabase
    .from("role_permissions")
    .select("role, is_allowed")
    .in("role", roles)
    .eq("permission_key", permissionKey);

  return (rolePerms ?? []).some((rp: any) => rp.is_allowed === true);
}
