import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonResponse } from "./cors.ts";
import { isServiceRole } from "./jwt-claims.ts";
import { checkPermission } from "./check-permission.ts";

export interface AuthContext {
  supabase: ReturnType<typeof createClient>;
  user: { id: string; email?: string } | null;
  token: string;
  isService: boolean;
}

/**
 * Mandatory-auth gate for edge functions.
 * Encodes CLAUDE.md locked rules verbatim:
 *  - Bug #170: the Authorization header is MANDATORY — reject 401 when
 *    missing or malformed BEFORE any other work. `if (authHeader) {…}`
 *    wrappers are NOT gates. Never accept the anon key as an
 *    internal-bypass credential.
 *  - Bug #168: service-role detection ONLY via isServiceRole() from
 *    _shared/jwt-claims.ts — never token === SUPABASE_SERVICE_ROLE_KEY
 *    string equality as the sole check.
 * Service-role callers are accepted ONLY when the function opts in via
 * allowServiceRole: true; otherwise a service token falls through to
 * auth.getUser() and is rejected 401, preserving current per-function
 * behavior for functions that never expect cron callers.
 */
export async function requireAuth(
  req: Request,
  opts: { allowServiceRole?: boolean } = {}
): Promise<AuthContext | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const token = authHeader.replace("Bearer ", "");
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  if (opts.allowServiceRole === true && isServiceRole(token)) {
    return { supabase, user: null, token, isService: true };
  }
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  return {
    supabase,
    user: { id: data.user.id, email: data.user.email ?? undefined },
    token,
    isService: false,
  };
}

/**
 * Permission gate on top of requireAuth. Uses the existing
 * _shared/check-permission.ts resolution order (admin → user override →
 * role_permissions). Service callers (isService) bypass the permission
 * check — they only exist when the function explicitly opted in.
 * Returns null when allowed, or a 403 Response to return as-is.
 */
export async function requirePermission(
  ctx: AuthContext,
  permissionKey: string
): Promise<Response | null> {
  if (ctx.isService) return null;
  if (!ctx.user) return jsonResponse({ error: "Unauthorized" }, 401);
  const allowed = await checkPermission(ctx.supabase, ctx.user.id, permissionKey);
  if (!allowed) return jsonResponse({ error: "Access denied" }, 403);
  return null;
}
