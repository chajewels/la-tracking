// H-07 (security audit 2026-10-31): a customer's Messenger link is shown to
// staff as a clickable link (customer card, directory, account pages,
// monitoring, dashboards). Customers can type it themselves (website profile,
// portal profile, portal sign-up), so a stored "javascript:..." value would run
// in the staff member's signed-in Hub session when clicked.
//
// Every Messenger link the Hub renders or opens goes through messengerHref():
// it returns an https/http URL built by the ONE shared rule
// (supabase/functions/_shared/profile-messenger-link.ts), or null — in which
// case no link is rendered. A link saved without a scheme ("m.me/username",
// the forms' own hint) becomes https://m.me/username, so it now opens instead
// of resolving as a broken relative link.
import { normalizeMessengerLink } from '../../supabase/functions/_shared/profile-messenger-link.ts';

export { normalizeMessengerLink };

export function messengerHref(link: string | null | undefined): string | null {
  const r = normalizeMessengerLink(link);
  return r.ok ? r.value : null;
}

/** Open a customer's Messenger link in a new tab only when messengerHref accepts it. */
export function openMessenger(link: string | null | undefined): void {
  const href = messengerHref(link);
  if (href) window.open(href, '_blank', 'noopener,noreferrer');
}
