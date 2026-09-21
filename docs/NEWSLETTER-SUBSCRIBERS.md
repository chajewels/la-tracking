# Newsletter subscribers

The storefront's mailing list. Rows are written by the `website` edge function;
the Hub reads the list, exports it, and flips a subscriber's state.

**Nothing in the Hub sends to this list.** §5 says what a send would actually
require — read it before promising anyone a newsletter.

## 1. The table

`public.newsletter_subscribers`

| column | notes |
|---|---|
| `id` | uuid PK |
| `email` | text, as the subscriber typed it |
| `email_norm` | text, **generated** `lower(btrim(email))`, unique — never written |
| `lang` | text, `'en'` or `'ja'`, default `'en'` |
| `source` | text — where the sign-up came from |
| `customer_id` | uuid NULL → `public.customers(id)` |
| `consented_at` | timestamptz |
| `unsubscribed_at` | timestamptz NULL — **the unsubscribed marker; NULL = active** |
| `unsubscribe_token` | uuid, the token in the unsubscribe link |
| `created_at` | timestamptz |

`email_norm` being generated and unique is what stops the same address landing
twice in different casings. It is read-only.

**`customer_id` is nullable, and usually null.** Most subscribers signed up from
the storefront without ever buying anything. That matters for the test-account
rule below.

### RLS (live)

    SELECT, ALL      is_staff
    SELECT, UPDATE   has_permission(auth.uid(), 'manage_website_catalog')

The Hub's unsubscribe / re-subscribe button is gated on
`can('manage_website_catalog')` — the same key the UPDATE policy names, so the
button is absent exactly when the write would be refused.

## 2. Where subscribers come from

The `website` edge function:

- `POST /newsletter` — creates the row.
- `GET /newsletter/unsubscribe?token=` — the customer unsubscribing themselves,
  through the link in an email.

It also fires `staff_notifications` type `newsletter_subscribed` with metadata
`{ id, lang, source }`.

Nothing in the Hub creates a subscriber. Per CLAUDE.md DOMAIN ARCHITECTURE,
customer-facing writes go through the service-role edge function, never straight
to the table.

## 3. Where it lives in the Hub

**Website Catalog → Subscribers** (`/website-catalog#subscribers`), between
Testimonials and Wholesale inquiries. Built on `DataTable`, so it has sort,
per-column filter, search, column show/hide and density.

Two exports, and they are not the same thing:

- **DataTable's own CSV button** — the visible columns of whatever is on screen,
  filters and all. Useful for a question you are answering right now.
- **"Export active"** — always every active subscriber, always `email`, `lang`,
  `consented_at`. This is the one you hand a mailing tool. It does not depend on
  how the table happened to be sorted or filtered when you clicked it.

`downloadCsv` lives in `src/lib/csv.ts`, extracted from DataTable's own
`exportCsv` so both go through one escaping rule and one filename shape.

**The bell**: a `newsletter_subscribed` notification shows a Mail icon in the
primary accent (not the red of `email_send_refused` / `email_delivery_outage` —
a sign-up is not a failure) and opens
`/website-catalog?subscriber=<id>#subscribers`. The card consumes `?subscriber`
once, narrowing the table to that person; a chip clears back to the full list.

## 4. Rules

**Test customers are excluded via `customers.is_test`** — the embed exists for
that. A row with **no** customer is KEPT: `is_test` can only exclude people the
Hub already knows, and a storefront sign-up from someone who has never bought is
exactly who a newsletter is for. Dropping null-customer rows would empty the
list.

**Active is `unsubscribed_at IS NULL`.** That column is the whole definition —
there is no status enum.

**Re-subscribing does NOT touch `consented_at`.** It clears `unsubscribed_at`
and nothing else. `consented_at` records when the person actually consented, and
a staff member putting them back on the list is not a fresh act of consent by
them. Rewriting it would launder a staff action into the customer's own, and
consent is the one field a mailing list is answerable for.

**Both directions write an `audit_logs` row** (`entity_type`
`'newsletter_subscriber'`, actions `unsubscribe_newsletter_subscriber` /
`resubscribe_newsletter_subscriber`, old and new `unsubscribed_at`). There is no
other record: the row shows only the CURRENT state, so without the log nobody
could tell a customer who unsubscribed themselves from one a staff member
removed.

## 5. Sending, facts only

Nothing in the Hub sends to newsletter_subscribers, and no path sends an
arbitrary bulk email. What exists:

- send-transactional-email: one recipient per call, templateName must be
  in the registry (registry.ts; 33 templates, none a newsletter), staff
  JWT accepted.
- The loyalty broadcast: NotificationComposeDialog.tsx writes a
  loyalty_notifications row with an audience of loyalty_members (all,
  tier, or specific); process-loyalty-notification-queue runs hourly,
  100 recipients per run, 25 concurrent, template loyalty-broadcast.
  Members only.
- bulk-send-setup-invites: batches of up to 100, no internal pacing.
- Provider ceiling 100 emails per hour per workspace, 429 with retry
  (docs/RETROACTIVE-AND-EMAIL.md).

A Hub newsletter send would need: a newsletter template in the registry
carrying GET /newsletter/unsubscribe?token=<row.unsubscribe_token>; a
queue or loop capped under 100/hour, split by lang; a per-recipient
recordEmailAttempt() row; all under supabase/, so Lovable's. The CSV
route needs only this PR's export; unsubscribes made inside a mailing
tool do not flow back unless its unsubscribe link points at the Hub URL.

## 6. `newsletter_subscribers` is not in the generated types

The table was created live, and `src/integrations/supabase/types.ts` is
Supabase-auto-generated — Lovable regenerates it on its next edge-function
deploy and it is **never hand-edited** (CLAUDE.md GENERATED FILES).

Per that rule the fix is to cast at the call site. This feature makes that cast
**once**, in `newsletterSubscribers()` in
`src/components/website/newsletter-types.ts`, and every query goes through it.

**When types.ts regenerates with the table**: delete `newsletterSubscribers()`,
use `supabase.from('newsletter_subscribers')` directly, and replace
`NewsletterSubscriberRow` with the generated row type.

## Files

    src/lib/csv.ts                                          downloadCsv / toCsv / csvEscape
    src/components/website/newsletter-types.ts              row type, the cast, active/test predicates
    src/components/website/NewsletterSubscribersCard.tsx    the card, export, unsubscribe/re-subscribe
    src/components/notifications/StaffNotificationBell.tsx  the newsletter_subscribed case
