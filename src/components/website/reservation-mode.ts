/**
 * Reserve-first switch (Website → Settings): the words and shapes the card
 * uses, kept out of ReservationModeCard.tsx so the component file exports only
 * components.
 */

export const RESERVATION_MODE_KEY = ["web-reservation-mode"] as const;

export interface ReservationModeState {
  enabled: boolean;
  updated_at: string | null;
  updated_by_name: string | null;
  updated_by_user_id: string | null;
  can_change: boolean;
  awaiting_total: number;
}

/** What turning the switch to `next` does, in the words the dialog shows. */
export function reservationModeEffect(next: boolean): string {
  return next
    ? "Customers reserve at checkout; bank details are sent only after staff confirm."
    : "Customers see bank details at checkout, as before. Reservations already placed still need confirming.";
}

/** Words for a refusal from set_web_reservation_mode. */
export function reservationModeRefusal(code: string): string {
  switch (code) {
    case "permission_denied": return "Only an admin can change reserve-first checkout.";
    case "user_identity_required": return "Your session has expired. Sign in again.";
    case "stale": return "Someone else changed this a moment ago. The card now shows the current state.";
    case "setting_missing": return "The switch is missing from system settings. Ask Claude Code to check the reserve-first migration.";
    default: return code || "Could not change reserve-first checkout.";
  }
}

/** Words for a failed read of get_web_reservation_mode. */
export function reservationModeReadError(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  if (code === "permission_denied") return "you do not have access to this setting.";
  if (code === "user_identity_required") return "your session has expired. Sign in again.";
  return "the server did not answer. Try again in a moment.";
}
