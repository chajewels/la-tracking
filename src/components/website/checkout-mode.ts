/**
 * Website orders switch (Website → Settings, website-orders PR 8): the words
 * and shapes CheckoutModeCard uses, kept out of the component file so it
 * exports only components. Rules: docs/WEB-ORDER-DRAFTS.md "PR 8".
 *
 * system_settings.web_checkout_mode: 'order' (a checkout creates the order at
 * once — today) or 'draft' (a checkout waits in Sales → Website orders → To
 * confirm until staff confirm it). Only CREATING a draft reads the switch:
 * drafts already waiting can still be confirmed or declined, and still lapse
 * at 72 hours, whichever way it is set.
 */

export type CheckoutMode = "order" | "draft";

export const CHECKOUT_MODE_KEY = ["web-checkout-mode"] as const;

export interface CheckoutModeState {
  found: boolean;
  mode: CheckoutMode;
  updated_at: string | null;
  updated_by_user_id: string | null;
  updated_by_name: string | null;
  can_change: boolean;
  drafts_to_confirm: number;
}

export const CHECKOUT_MODE_LABEL: Record<CheckoutMode, string> = {
  order: "Off — orders are created at checkout",
  draft: "On — staff confirm every website order first",
};

/** What each mode does, in the words the card and the dialog show. */
export function checkoutModeEffect(mode: CheckoutMode): string {
  return mode === "draft"
    ? "Every website checkout waits in Sales → Website orders → To confirm. The piece is held, the customer is not shown bank details and pays nothing until staff confirm it. Staff add the shipping when the country has no published rate."
    : "A website checkout creates the order straight away, as before. Reserve first (above) still applies when it is on.";
}

/** The dialog line about drafts already waiting. */
export function draftsWaitingLine(n: number, next: CheckoutMode): string {
  if (n === 0) return "No website orders are waiting in To confirm.";
  const lead = `${n} website order${n === 1 ? " is" : "s are"} waiting in To confirm.`;
  return next === "order"
    ? `${lead} They stay there — staff can still confirm or decline them, and any left lapse after 72 hours.`
    : lead;
}

/** Words for a refusal from set_web_checkout_mode. */
export function checkoutModeRefusal(code: string): string {
  switch (code) {
    case "permission_denied": return "Only an admin can change this.";
    case "user_identity_required": return "Your session has expired. Sign in again.";
    case "stale": return "Someone else changed this a moment ago. The card now shows the current state.";
    case "setting_missing": return "The setting is missing. Ask Claude Code to check the website-orders migration.";
    case "invalid_mode": return "That is not one of the two settings.";
    default: return code || "Could not change the setting.";
  }
}

/** Words for a failed read of get_web_checkout_mode. */
export function checkoutModeReadError(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  if (code === "permission_denied") return "you do not have access to this setting.";
  if (code === "user_identity_required") return "your session has expired. Sign in again.";
  return "the server did not answer. Try again in a moment.";
}
