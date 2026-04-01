/**
 * Shared permission helper — resolves whether a user can perform an action.
 *
 * Resolution order (per CLAUDE.md):
 *   1. user_permission_overrides WHERE user_id = this_user  → if row exists, use granted
 *   2. role_permissions WHERE role = user's role            → fallback
 *   3. admin role                                           → always allowed
 */
export async function checkPermission(
  supabase: any,
  userId: string,
  permissionKey: string
): Promise<boolean> {
  // Get user's role
  const { data: userRole } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();

  const role = userRole?.role;

  // Admin always allowed
  if (role === "admin") return true;

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

  // Fall back to role_permissions
  const { data: rolePerm } = await supabase
    .from("role_permissions")
    .select("is_allowed")
    .eq("role", role)
    .eq("permission_key", permissionKey)
    .maybeSingle();

  return rolePerm?.is_allowed ?? false;
}
