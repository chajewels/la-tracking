/**
 * A customer's Messenger link — the ONE rule, applied on every customer save
 * path and to every Messenger link the Hub renders.
 *
 * Why (security audit 2026-10-31, H-07): customers could save messenger_link
 * as typed (website profile step via `website` POST /auth/customer, portal
 * profile via customer-portal, portal sign-up via setup-customer-account), and
 * the Hub renders it to staff as a clickable link (customer card, directory,
 * account pages, monitoring). A "javascript:..." value would run in the staff
 * member's signed-in Hub session when clicked.
 *
 * Twin copy (identical rule) on the storefront: cha-jewels-web
 * lib/profile-messenger-link.ts, so the form can say what is wrong. The Hub is
 * the authority. PURE (no Deno APIs): src/lib/messenger-href.ts imports it too.
 *
 * SAVE rule (normalizeMessengerLink — customer save paths):
 *  - empty after trimming → no link (null);
 *  - written with a scheme → only http: or https: is accepted;
 *  - written without one (the forms' hint is "m.me/username") → https:// is
 *    added, exactly as a person typing it means;
 *  - the result must parse as a URL with a dotted host and no user/password,
 *    contain no whitespace or control character, and be at most 200 characters.
 * Anything else is refused (`ok: false`). The stored value is the parsed URL's
 * canonical form (url.href), so "https:m.me/x" is stored as "https://m.me/x".
 *
 * DISPLAY rule (safeMessengerHref — every Messenger link the Hub renders or
 * opens, whoever saved it): only SAFETY, not tidiness — no control character
 * or backslash, http(s) only (https:// added when there is no scheme), a dotted
 * host, no user/password; no length cap and no whitespace refusal, so a long
 * Facebook link a staff member saved still opens. Returns url.href or null.
 */
export const MESSENGER_LINK_MAX = 200;

export type MessengerLinkResult = { ok: true; value: string | null } | { ok: false };

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// deno-lint-ignore no-control-regex
const BAD_CHARS = /[\s\u0000-\u001f\u007f]/;

export function normalizeMessengerLink(raw: unknown): MessengerLinkResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (BAD_CHARS.test(trimmed) || trimmed.includes("\\")) return { ok: false };
  const candidate = HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, "")}`;
  if (candidate.length > MESSENGER_LINK_MAX) return { ok: false };
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false };
  if (url.username || url.password) return { ok: false };
  if (!url.hostname.includes(".") || url.hostname.startsWith(".") || url.hostname.endsWith(".")) return { ok: false };
  if (url.href.length > MESSENGER_LINK_MAX) return { ok: false };
  return { ok: true, value: url.href };
}

/**
 * A customer re-saving her profile: the SAVE rule, except that a link she did
 * not change (the value already stored, e.g. a long link staff saved) is kept
 * when the DISPLAY rule accepts it — so an untouched field never blocks her
 * from updating anything else.
 */
export function customerProfileMessengerLink(raw: unknown, stored: string | null | undefined): MessengerLinkResult {
  const r = normalizeMessengerLink(raw);
  if (r.ok) return r;
  if (typeof raw === "string" && typeof stored === "string" && raw.trim() === stored.trim()) {
    const kept = safeMessengerHref(stored);
    if (kept) return { ok: true, value: kept };
  }
  return { ok: false };
}

// deno-lint-ignore no-control-regex
const DISPLAY_BAD_CHARS = /[\u0000-\u001f\u007f]/;

export function safeMessengerHref(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || DISPLAY_BAD_CHARS.test(trimmed) || trimmed.includes("\\")) return null;
  const candidate = HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, "")}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (!url.hostname.includes(".") || url.hostname.startsWith(".") || url.hostname.endsWith(".")) return null;
  return url.href;
}
