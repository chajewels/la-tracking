/**
 * Duplicate-customer prevention — shared types for public.find_customer_matches
 * (migration 20260924000000_find_customer_matches.sql, owner rules 2026-09-23).
 *
 * A customer is a duplicate if ANY of these match an existing (non-test)
 * customer: full name, Facebook name, mobile number, email.
 *   - full name / Facebook name: exact after lower-case, trim, collapse spaces
 *   - mobile: last 10 digits, only when the number has >= 10 digits
 *   - email: exact, case-insensitive
 * In the Hub there is NO "create anyway": a match blocks the save.
 *
 * The RPC is not in the generated types.ts yet, and types.ts is never
 * hand-edited (CLAUDE.md "GENERATED FILES"), so every call site casts:
 *
 *   const { data, error } = await (supabase.rpc as unknown as FindCustomerMatchesRpc)(
 *     'find_customer_matches', { ... });
 *
 * Keep the cast in parentheses around `supabase.rpc` — detaching it into a
 * variable loses `this`. Remove the casts once the RPC lands in types.ts.
 */

export type CustomerMatchField = 'full_name' | 'facebook_name' | 'mobile' | 'email';

/** One row of public.find_customer_matches. */
export interface CustomerMatch {
  customer_id: string;
  customer_code: string | null;
  full_name: string | null;
  facebook_name: string | null;
  mobile_number: string | null;
  email: string | null;
  location: string | null;
  has_login: boolean;
  matched_on: CustomerMatchField[];
}

export interface FindCustomerMatchesArgs {
  p_full_name?: string | null;
  p_facebook_name?: string | null;
  p_mobile?: string | null;
  p_email?: string | null;
  p_exclude_customer_id?: string | null;
}

export type FindCustomerMatchesRpc = (
  fn: 'find_customer_matches',
  args: FindCustomerMatchesArgs,
) => PromiseLike<{ data: CustomerMatch[] | null; error: { message: string; code?: string } | null }>;

export const MATCH_FIELD_LABELS: Record<CustomerMatchField, string> = {
  full_name: 'Full name',
  facebook_name: 'Facebook name',
  mobile: 'Mobile',
  email: 'Email',
};

/** Trimmed value, or null when empty — what the RPC receives. */
export const blankToNull = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t ? t : null;
};

// ── Client-side mirrors of the SQL normalisation ──
// Used ONLY to compare rows of one import file against each other (rows not
// yet in the database). Matching against existing customers always goes
// through the RPC. Each helper returns null when the value cannot match,
// exactly as the SQL does. btrim() strips SPACES only (not tabs/newlines), so
// the mirrors do the same before collapsing whitespace.

const btrimSpaces = (v: string) => v.replace(/^ +| +$/g, '');

export function normalizeMatchName(v: string | null | undefined): string | null {
  const t = btrimSpaces(v ?? '').replace(/\s+/g, ' ').toLowerCase();
  return t || null;
}

export function normalizeMatchMobile(v: string | null | undefined): string | null {
  const digits = (v ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

export function normalizeMatchEmail(v: string | null | undefined): string | null {
  const t = btrimSpaces(v ?? '').toLowerCase();
  return t || null;
}
