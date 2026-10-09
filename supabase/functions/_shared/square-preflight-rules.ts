/**
 * D-SQV05 (owner 2026-10-09): the read-only production preflight. While card
 * payments are OFF, an admin proves the production connection before go-live:
 *   token   — GET /v2/locations with the production token;
 *   events  — one Events API search over the last 28 days (Square keeps 28 days
 *             and only while the Events API is enabled — an owner step).
 * Nothing is charged, nothing is shown to customers, the mode never changes.
 *
 * Classification is deliberately strict (fix revalidation SQV05 / SQF08): a
 * first 401/403 is `auth_failed`, never "not enabled"; only a SUCCESSFUL search
 * passes the Events step. Pure, deno-tested.
 */
export type PreflightState = "ok" | "auth_failed" | "not_configured" | "unavailable" | "refused";

/** One Square error (status + code + kind from SquareError) → a preflight state. */
export function preflightStateOf(e: { status?: number | null; code?: string | null; kind?: string | null } | null | undefined): PreflightState {
  if (!e) return "unavailable";
  if (e.kind === "not_configured" || e.code === "square_not_configured") return "not_configured";
  if (e.status === 401 || e.status === 403 || e.kind === "auth") return "auth_failed";
  if (e.kind === "ambiguous" || e.kind === "rate_limited" || (typeof e.status === "number" && (e.status === 0 || e.status >= 500 || e.status === 429))) return "unavailable";
  return "refused";
}

export interface PreflightReport {
  environment: "production" | "sandbox";
  token: { state: PreflightState; status: number | null; code: string | null; secret: string | null };
  locations: string[];
  location_configured: string | null;
  location_match: boolean | null;
  app_id_family: "production" | "sandbox" | null;
  events: { state: PreflightState; status: number | null; code: string | null; first_page: number | null; window_days: number };
  /** M2 (QC 2026-10-09): the configured location as Square reports it (null when not found / not read). */
  location?: { status: string | null; currency: string | null; country: string | null } | null;
  /** F-14: whether the environment's webhook signature key is set (the NAME is checked, never the value). */
  webhook_key?: boolean;
  /** The whole preflight passes only when the token works, the configured location is the token's AND is an active Japanese yen location, the webhook key is set, and an Events search succeeded. */
  passed: boolean;
}

/** M2: the location card payments are taken at must be ACTIVE, in yen, in Japan. */
export function locationUsable(l: PreflightReport["location"]): boolean {
  return !!l && l.status === "ACTIVE" && l.currency === "JPY" && l.country === "JP";
}

export function preflightPassed(r: Omit<PreflightReport, "passed">): boolean {
  return r.token.state === "ok" && r.location_match === true && locationUsable(r.location ?? null)
    && r.webhook_key === true && r.app_id_family === r.environment && r.events.state === "ok";
}

/** F-14: the webhook signature key the environment's subscription is verified with (names only). */
export function webhookKeyNames(env: "production" | "sandbox"): string[] {
  return env === "production" ? ["SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY"] : ["SQUARE_WEBHOOK_SIGNATURE_KEY"];
}

/** Which secret name the client will read for an environment — the NAME only, never the value. */
export function tokenSecretInUse(env: "production" | "sandbox", has: (name: string) => boolean): string | null {
  // F-09 (2026-10-09): production reads ONLY its own token (mirrors accessTokenNames in square.ts).
  const names = env === "production" ? ["SQUARE_PRODUCTION_ACCESS_TOKEN"] : ["SQUARE_SANDBOX_ACCESS_TOKEN", "SQUARE_ACCESS_TOKEN"];
  return names.find(has) ?? null;
}
