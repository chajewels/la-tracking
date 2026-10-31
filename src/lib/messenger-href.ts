// H-07 (security audit 2026-10-31): a customer's Messenger link is shown to
// staff as a clickable link (customer card, directory, account pages,
// monitoring, dashboards). Customers can type it themselves (website profile,
// portal profile, portal sign-up), so a stored "javascript:..." value would run
// in the staff member's signed-in Hub session when clicked.
//
// Every Messenger link the Hub renders or opens goes through messengerHref():
// it returns an https/http URL built by the shared DISPLAY rule
// (safeMessengerHref in supabase/functions/_shared/profile-messenger-link.ts —
// safety only, no length cap, so long links staff saved still open), or null —
// in which case no link or button is rendered. A link saved without a scheme ("m.me/username",
// the forms' own hint) becomes https://m.me/username, so it now opens instead
// of resolving as a broken relative link.
import { normalizeMessengerLink, safeMessengerHref, customerProfileMessengerLink } from '../../supabase/functions/_shared/profile-messenger-link.ts';

export { normalizeMessengerLink, customerProfileMessengerLink };

export function messengerHref(link: string | null | undefined): string | null {
  return safeMessengerHref(link);
}

/**
 * Open a customer's Messenger link in a new tab only when messengerHref
 * accepts it. Returns whether a tab was opened, so callers can say so when the
 * saved link is not a web address (screens gate their buttons on
 * messengerHref, so this is the fallback, not the normal path).
 */
export function openMessenger(link: string | null | undefined): boolean {
  const href = messengerHref(link);
  if (!href) return false;
  window.open(href, '_blank', 'noopener,noreferrer');
  return true;
}

/**
 * Staff forms (Edit / New customer, customer page edit, CSV import, AI command)
 * and bulk-import: the value to store. Same safety as display; a value that
 * would not be clickable is refused (ok:false) so the form can say so.
 */
export function staffMessengerLink(raw: string | null | undefined): { ok: true; value: string | null } | { ok: false } {
  if (raw === null || raw === undefined || !raw.trim()) return { ok: true, value: null };
  const href = safeMessengerHref(raw);
  return href ? { ok: true, value: href } : { ok: false };
}
