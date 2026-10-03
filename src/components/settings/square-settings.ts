/**
 * Website → Settings → Card payments (Square): the pure parts of the card
 * (labels, effect sentences, refusals, id checks), kept out of the component
 * so the test can pin them. docs/SQUARE.md. Twin of paidy-settings.ts.
 */
export type SquareMode = "off" | "test" | "on";

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
}

export const SQUARE_MODE_LABEL: Record<SquareMode, string> = {
  off: "Off",
  test: "Test (test customers only, Square sandbox)",
  on: "On",
};

export function squareEffect(mode: SquareMode): string {
  switch (mode) {
    case "on": return "Every customer sees \"Pay by card\" on a confirmed yen order (production ids and token). Money is held on pay and taken only when a reviewer clicks Confirm.";
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
    default: return code;
  }
}
