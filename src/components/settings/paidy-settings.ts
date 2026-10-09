/**
 * Website → Settings → Paidy: the pure parts of the card (labels, effect
 * sentences, refusals, key check), kept out of the component so the test can
 * pin them. docs/PAIDY.md.
 */
export type PaidyMode = "off" | "test" | "on";

export const PAIDY_KEY = ["paidy-settings"] as const;

export interface PaidySettingsState {
  found: boolean;
  mode: PaidyMode;
  raw_mode: unknown;
  public_key: string;
  updated_at: string | null;
  updated_by_user_id: string | null;
  updated_by_name: string | null;
  can_change: boolean;
  authorized_now: number;
  captured_30d: number;
}

export const PAIDY_MODE_LABEL: Record<PaidyMode, string> = {
  off: "Off",
  test: "Test (test customers only)",
  on: "On",
};

export function paidyEffect(mode: PaidyMode): string {
  switch (mode) {
    // M7 (Paidy QC 2026-10-09): who actually sees it — the order ships to
    // Japan AND her own details are complete (paidyNotOfferedReason).
    case "on": return "Customers with a yen order shipped to Japan, whose own Paidy details are complete, see 『あと払い（ペイディ）』 on a confirmed order (live keys).";
    case "test": return "Only customers flagged is_test see 『あと払い（ペイディ）』, with Paidy's test keys — nothing real is charged.";
    default: return "Paidy is not offered anywhere on the website.";
  }
}

/** Mirrors set_paidy_settings: a public key only, in the family the mode needs. */
export function paidyPublicKeyProblem(key: string): string | null {
  if (key === "") return null;
  if (/^sk_/.test(key)) return "That is a SECRET key — it is never stored here. Enter it only in the Lovable secret box as PAIDY_SECRET_KEY.";
  if (!/^pk_(test|live)_[A-Za-z0-9]{8,}$/.test(key)) return "Not a Paidy public key (pk_test_… or pk_live_…).";
  return null;
}

export function paidyRefusal(code: string): string {
  switch (code) {
    case "permission_denied": return "Only an admin can change Paidy settings.";
    case "stale": return "Someone else changed this just now — the page has refreshed; please look again.";
    case "invalid_mode": return "Unknown mode.";
    case "invalid_public_key": return "Not a Paidy public key (pk_test_… or pk_live_…). A secret key is refused.";
    case "test_key_required": return "Test mode needs a pk_test_ public key saved first.";
    case "live_key_required": return "On needs a pk_live_ public key saved first.";
    case "setting_missing": return "The Paidy settings rows are missing — the migration has not been applied.";
    case "user_identity_required": return "Please sign in again.";
    default: return code;
  }
}
