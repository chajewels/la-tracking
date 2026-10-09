/**
 * Website → Settings → Card payments (Square): the pure parts of the card
 * (labels, effect sentences, refusals, id checks), kept out of the component
 * so the test can pin them. docs/SQUARE.md. Twin of paidy-settings.ts.
 */
export type SquareMode = "off" | "test" | "on";
/** D-G04 (owner 2026-10-09): who sees card payment while the mode is On. */
export type SquareAudience = "everyone" | "listed";

export interface SquareCardCustomer { id: string; code: string | null; name: string | null }

/** The last production preflight (square_sync_state 'preflight:production'), D-SQV05. */
export interface SquarePreflight {
  environment?: string;
  passed?: boolean;
  token?: { state?: string; status?: number | null; code?: string | null; secret?: string | null };
  locations?: string[];
  location_configured?: string | null;
  location_match?: boolean | null;
  app_id_family?: string | null;
  events?: { state?: string; status?: number | null; code?: string | null; first_page?: number | null; window_days?: number };
  /** M2 (QC 2026-10-09): the configured location as Square reports it. */
  location?: { status?: string | null; currency?: string | null; country?: string | null; card_processing?: boolean | null } | null;
  /** F-14: whether the environment's webhook signature key is set. */
  webhook_key?: boolean;
  at?: string;
  by?: string;
  updated_at?: string;
}

export const SQUARE_KEY = ["square-settings"] as const;

export interface SquareSettingsState {
  found: boolean;
  mode: SquareMode;
  raw_mode: unknown;
  app_id: string;
  location_id: string;
  agreement_min_jpy: number;
  updated_at: string | null;
  updated_by_user_id: string | null;
  updated_by_name: string | null;
  can_change: boolean;
  authorized_now: number;
  captured_30d: number;
  disputes_open: number;
  audience: SquareAudience;
  card_customers: SquareCardCustomer[];
  preflight: SquarePreflight | null;
}

export const SQUARE_MODE_LABEL: Record<SquareMode, string> = {
  off: "Off",
  test: "Test (test customers only, Square sandbox)",
  on: "On",
};

export function squareEffect(mode: SquareMode, audience: SquareAudience = "everyone", listed = 0): string {
  switch (mode) {
    case "on": return audience === "listed"
      ? `Only the ${listed} listed customer${listed === 1 ? "" : "s"} below see "Pay by card" on a confirmed yen order (production ids and token). Everyone else sees bank transfer only.`
      : "Every customer sees \"Pay by card\" on a confirmed yen order (production ids and token). Money is held on pay and taken only when a reviewer clicks Confirm.";
    case "test": return "Only customers flagged is_test see \"Pay by card\", against Square's SANDBOX — nothing real is charged.";
    default: return "Card payment is not offered anywhere on the website.";
  }
}

/** Mirrors set_square_settings: a PUBLIC Application ID only, in the family the mode needs. */
export function squareAppIdProblem(id: string): string | null {
  if (id === "") return null;
  if (/^EAAA/.test(id) || /sq0atp/.test(id) || /sq0csp/.test(id)) {
    return "That is an ACCESS TOKEN or application secret — it is never stored here. Enter it only in the Lovable secret box as SQUARE_ACCESS_TOKEN.";
  }
  if (!/^(sandbox-sq0idb-|sq0idp-)[A-Za-z0-9_-]{6,}$/.test(id)) return "Not a Square Application ID (sandbox-sq0idb-… or sq0idp-…).";
  return null;
}

export function squareLocationIdProblem(id: string): string | null {
  if (id === "") return null;
  if (!/^[A-Z0-9]{8,}$/.test(id)) return "Not a Square Location ID (capital letters and digits, e.g. L8XXXXXXXXXXX).";
  return null;
}

export function squareAgreementLabel(minJpy: number): string {
  return minJpy <= 0
    ? "Every card payment needs the signed Card Purchase Agreement (owner decision 2026-10-03)."
    : `Card payments of ¥${Math.round(minJpy).toLocaleString("en-US")} and above need the signed Card Purchase Agreement; smaller ones need the terms tick only.`;
}

export function squareRefusal(code: string): string {
  switch (code) {
    case "permission_denied": return "Only an admin can change card payment settings.";
    case "stale": return "Someone else changed this just now — the page has refreshed; please look again.";
    case "invalid_mode": return "Unknown mode.";
    case "invalid_app_id": return "Not a Square Application ID (sandbox-sq0idb-… or sq0idp-…). An access token is refused.";
    case "invalid_location_id": return "Not a Square Location ID.";
    case "invalid_agreement_min": return "The agreement threshold must be a whole yen amount, 0 or more.";
    case "sandbox_app_id_required": return "Test mode needs a sandbox-sq0idb- Application ID saved first.";
    case "production_app_id_required": return "On needs a sq0idp- (production) Application ID saved first.";
    case "location_id_required": return "Save the Location ID before switching on.";
    case "setting_missing": return "The card payment settings rows are missing — the migration has not been applied.";
    case "user_identity_required": return "Please sign in again.";
    case "invalid_audience": return "Unknown audience (everyone or listed customers).";
    case "unknown_customer_code": return "One or more customer codes do not exist.";
    default: return code;
  }
}

export const SQUARE_AUDIENCE_LABEL: Record<SquareAudience, string> = {
  listed: "Listed customers only",
  everyone: "Everyone",
};

/** Customer codes typed one per line / comma separated → trimmed, upper-cased, de-duplicated. */
export function parseCustomerCodes(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const c = raw.trim().toUpperCase();
    if (c !== "" && !out.includes(c)) out.push(c);
  }
  return out;
}

export function customerCodesProblem(codes: string[]): string | null {
  const bad = codes.filter((c) => !/^[A-Z0-9][A-Z0-9-]*$/.test(c));
  return bad.length ? `Not a customer code (e.g. CJ-2026-00008): ${bad.join(", ")}` : null;
}

/** One line per preflight step, in plain words. Never shows a token value — only the secret NAME. */
export function preflightLines(p: SquarePreflight | null): Array<{ ok: boolean; text: string }> {
  if (!p) return [];
  const st = (s?: string) => s === "ok" ? "works" : s === "auth_failed" ? "refused by Square (401/403 — wrong token or missing permission)" : s === "not_configured" ? "not set" : s === "unavailable" ? "Square did not answer — run it again" : s ?? "unknown";
  return [
    { ok: p.token?.state === "ok", text: `Production token${p.token?.secret ? ` (${p.token.secret})` : ""}: ${st(p.token?.state)}` },
    { ok: p.location_match === true, text: p.location_match === true ? `Location ${p.location_configured} belongs to this token` : `Location ${p.location_configured ?? "(none saved)"} is NOT one of the token's locations${p.locations?.length ? ` (${p.locations.join(", ")})` : ""}` },
    {
      ok: p.location?.status === "ACTIVE" && p.location?.currency === "JPY" && p.location?.country === "JP",
      text: p.location
        ? `Location is ${p.location.status ?? "?"}, ${p.location.currency ?? "?"}, ${p.location.country ?? "?"} (must be ACTIVE, JPY, JP)`
        : "Location status, currency and country not read — run the check again",
    },
    {
      /* DOC-7 (go-live counter-check 2026-10-09): Square must have activated the location for card payments. */
      ok: p.location?.card_processing === true,
      text: p.location?.card_processing === true
        ? "Square has activated this location for card payments"
        : p.location
          ? "Square has NOT activated this location for card payments (CREDIT_CARD_PROCESSING) — ask Square to activate it"
          : "Card-payment activation not read — run the check again",
    },
    { ok: p.webhook_key === true, text: p.webhook_key === true ? "Production webhook signature key is set" : "Production webhook signature key (SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY) is NOT set" },
    { ok: p.app_id_family === "production", text: p.app_id_family === "production" ? "Application ID is a production id (sq0idp-)" : `Application ID is ${p.app_id_family ?? "missing"}, not production` },
    { ok: p.events?.state === "ok", text: p.events?.state === "ok" ? `Events API search works (${p.events.first_page ?? 0} event(s) on the first page, last ${p.events.window_days ?? 28} days)` : `Events API search: ${st(p.events?.state)}` },
  ];
}
