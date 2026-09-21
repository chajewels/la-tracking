/**
 * Newsletter subscribers — the storefront's mailing list, read in the Hub.
 *
 * Rows are written by the `website` edge function (`POST /newsletter`, and
 * `GET /newsletter/unsubscribe?token=`). Nothing in the Hub creates one; the
 * Hub reads the list, exports it, and flips a subscriber's state.
 *
 * `newsletter_subscribers` is not in src/integrations/supabase/types.ts — the
 * table was created live and Lovable regenerates that file on its next
 * edge-function deploy. Per CLAUDE.md (GENERATED FILES) the generated file is
 * never hand-edited and the fix is to cast at the call site; this module
 * carries that cast once, and every query in the feature goes through it.
 */

import { supabase } from '@/integrations/supabase/client';

/**
 * The ONE cast in this feature. Delete it when types.ts regenerates with the
 * table, and replace `NewsletterSubscriberRow` with the generated row type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const newsletterSubscribers = () => (supabase as any).from('newsletter_subscribers');

export interface NewsletterSubscriberRow {
  id: string;
  email: string;
  /** Generated column: lower(btrim(email)), unique. Read-only. */
  email_norm: string | null;
  lang: string | null;
  source: string | null;
  customer_id: string | null;
  consented_at: string | null;
  /** The unsubscribed marker. NULL = active. */
  unsubscribed_at: string | null;
  unsubscribe_token: string | null;
  created_at: string;
  /** Embed — carries is_test, which is why it is selected at all. */
  customers?: { id: string; full_name: string | null; is_test: boolean | null } | null;
}

/**
 * `customer_id` is nullable: most subscribers signed up from the storefront
 * without ever being a customer. The embed exists for the is_test exclusion
 * and for showing who a subscriber is when the Hub knows them.
 */
export const NEWSLETTER_SUBSCRIBER_SELECT = `
  *,
  customers:customer_id (id, full_name, is_test)
`;

/** NULL unsubscribed_at is the whole definition of active. */
export const isActive = (r: NewsletterSubscriberRow) => r.unsubscribed_at === null;

/**
 * A test customer's subscription is scaffolding, not a real one. A row with no
 * customer is KEPT — a storefront sign-up from someone the Hub has never sold
 * to is exactly who a newsletter is for, and `is_test` can only exclude people
 * the Hub already knows.
 */
export const isNotTest = (r: NewsletterSubscriberRow) => r.customers?.is_test !== true;

export function langLabel(lang: string | null): string {
  if (lang === 'ja') return 'JA';
  if (lang === 'en') return 'EN';
  return lang ?? '—';
}
