/**
 * Page365 import — customer suggestions and the manual customer search.
 *
 * Owner rules (2026-09-26, after invoice 19794 found no customer):
 *   - The Page365 name is checked against BOTH full_name and facebook_name —
 *     Page365 usually carries the customer's Facebook name, while the Hub
 *     full_name is often her real name.
 *   - A phone matches whenever the DIGITS are identical. Dashes, spaces,
 *     brackets, dots or any other character between them never stop a match
 *     ("949-247-9913" = "9492479913" = "(949) 247 9913"). This is compared in
 *     code on digits-only values, never as a text search on the stored number
 *     — a text search for "492479913" cannot see it inside "949-247-9913",
 *     which is exactly how 19794 was missed.
 *   - A phone match is never cut off by a result limit.
 *   - Suggestions only: nothing here selects a customer (docs/PAGE365-IMPORT.md).
 */

export type MatchField = 'name' | 'facebook name' | 'phone';

export interface MatchableCustomer {
  id: string;
  full_name: string | null;
  facebook_name: string | null;
  mobile_number: string | null;
  email: string | null;
  customer_code: string | null;
}

/** Fewer digits than this is not a usable phone number (unchanged from before). */
export const MIN_PHONE_DIGITS = 7;
/** How many name-only suggestions to show. Phone matches are always shown on top. */
export const NAME_SUGGESTION_LIMIT = 10;
/** Manual search needs at least this many characters. */
export const MIN_SEARCH_LENGTH = 2;
/** A typed search is treated as a phone search once it has this many digits. */
export const MIN_SEARCH_DIGITS = 4;
export const SEARCH_RESULT_LIMIT = 20;

/** Digits only: every other character (dash, space, +, brackets, dots…) is dropped. */
export function digitsOnly(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}

/** Lower-case, trimmed, runs of whitespace collapsed to one space. */
export function normName(s: string | null | undefined): string {
  return (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Same phone number, whatever characters separate the digits.
 * Identical digits always match. When both numbers have at least 9 digits the
 * last 9 are compared, so a country code or leading 0 (+63 917… / 0917…) does
 * not defeat the match — the rule the review page already used.
 */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (da.length < MIN_PHONE_DIGITS || db.length < MIN_PHONE_DIGITS) return false;
  if (da === db) return true;
  if (da.length >= 9 && db.length >= 9) return da.slice(-9) === db.slice(-9);
  return false;
}

/** Which fields of this customer match what Page365 sent. Empty = no match. */
export function matchFields(
  c: MatchableCustomer,
  page365Name: string | null | undefined,
  page365Phone: string | null | undefined,
): MatchField[] {
  const want = normName(page365Name);
  const out: MatchField[] = [];
  if (want && normName(c.full_name).includes(want)) out.push('name');
  if (want && normName(c.facebook_name).includes(want)) out.push('facebook name');
  if (samePhone(c.mobile_number, page365Phone)) out.push('phone');
  return out;
}

export interface Suggestion<C extends MatchableCustomer = MatchableCustomer> {
  customer: C;
  basis: MatchField[];
}

/**
 * Suggested customers for a Page365 invoice: every phone match (never cut
 * off), then name / Facebook-name matches up to NAME_SUGGESTION_LIMIT, each
 * group alphabetical by full_name.
 */
export function suggestCustomers<C extends MatchableCustomer>(
  customers: C[],
  page365Name: string | null | undefined,
  page365Phone: string | null | undefined,
): Suggestion<C>[] {
  const byName = (a: Suggestion<C>, b: Suggestion<C>) =>
    normName(a.customer.full_name).localeCompare(normName(b.customer.full_name));
  const hits = customers
    .map((customer) => ({ customer, basis: matchFields(customer, page365Name, page365Phone) }))
    .filter((s) => s.basis.length > 0);
  const phoneHits = hits.filter((s) => s.basis.includes('phone')).sort(byName);
  const nameOnly = hits.filter((s) => !s.basis.includes('phone')).sort(byName);
  return [...phoneHits, ...nameOnly.slice(0, NAME_SUGGESTION_LIMIT)];
}

/**
 * Manual search: full name, Facebook name, email or customer code (contains,
 * case-insensitive), or phone — digits compared digits-only, so typing
 * "9492479913" or "949 247" finds "949-247-9913".
 */
export function searchCustomers<C extends MatchableCustomer>(customers: C[], term: string): C[] {
  const t = normName(term);
  if (t.length < MIN_SEARCH_LENGTH) return [];
  const td = digitsOnly(term);
  const phoneSearch = td.length >= MIN_SEARCH_DIGITS;
  return customers
    .filter((c) =>
      normName(c.full_name).includes(t)
      || normName(c.facebook_name).includes(t)
      || normName(c.email).includes(t)
      || normName(c.customer_code).includes(t)
      || (phoneSearch && digitsOnly(c.mobile_number).includes(td)))
    .sort((a, b) => normName(a.full_name).localeCompare(normName(b.full_name)))
    .slice(0, SEARCH_RESULT_LIMIT);
}
