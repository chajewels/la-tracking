export function parseJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length < 2) {
    return null
  }

  try {
    const payload = parts[1]
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=')

    return JSON.parse(atob(payload)) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Format-proof service-caller detection.
 *
 * Internal function-to-function calls authenticate with
 * Bearer ${SUPABASE_SERVICE_ROLE_KEY}. When the injected key happens to be
 * in non-JWT format (e.g. the sb_secret_* rollout), parseJwtClaims() returns
 * null and a strict `role === "service_role"` claims gate denies the caller
 * with 401. To stay correct across formats:
 *
 *   1. If the bearer matches SUPABASE_SERVICE_ROLE_KEY verbatim, accept.
 *   2. Otherwise fall back to the JWT claims check so legitimate vault-JWT
 *      cron invocations (which carry a real service-role JWT) still pass.
 */
export function isServiceRole(token: string): boolean {
  const envKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (envKey && token === envKey) return true;
  return parseJwtClaims(token)?.role === "service_role";
}
