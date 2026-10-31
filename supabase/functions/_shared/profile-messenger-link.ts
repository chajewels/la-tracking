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
 * Rule:
 *  - empty after trimming → no link (null);
 *  - written with a scheme → only http: or https: is accepted;
 *  - written without one (the forms' hint is "m.me/username") → https:// is
 *    added, exactly as a person typing it means;
 *  - the result must parse as a URL with a dotted host and no user/password,
 *    contain no whitespace or control character, and be at most 200 characters.
 * Anything else is refused (`ok: false`).
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
  return { ok: true, value: candidate };
}
