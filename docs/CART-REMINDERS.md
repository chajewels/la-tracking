# Cart reminders (stages A and B)

Added 2026-10-01 from the approved plan
`~/Code/reference/abandoned-cart-investigation.md`, revision 2 (§2a–2e, §2i,
§3a′ A1, §3b, §3b″; owner "approved all recommendation", decisions D1–D11,
D4/D5 superseded by the money rule below). Stage D (payment reminders) is
docs/WEB-PAYMENT-REMINDERS.md and shares nothing with this.

Migration: `supabase/migrations/20261021100000_cart_reminders.sql`, run by the
owner. Local proof: `docs/sql/20261021_cart_reminders_local_{stub,tests}.sql`
(9 blocks, ends `cart reminders local tests: PASS`).

## What the customer gets

ONE PROMOTIONAL email per "cart cycle" — the stretch from an empty cart
getting its first piece until she orders or the cart empties — and only if she
ticked the cart-reminder box. It lists the pieces still available, says plainly
that the cart holds nothing, and links to `/cart/restore` on the storefront.

Stage B is the SAME single email with different money: when she reached
checkout this cycle without ordering, the email takes the form of what she
chose there (full payment in yen, full payment in pesos, or a layaway plan).
It is never a second email; `UNIQUE(cycle_id)` on the ledger is the guarantee.

| Form (`reminderForm`) | When | EN | JA |
|---|---|---|---|
| `stage_a` | no checkout this cycle | `¥68,000 (₱27,016)` per piece + the Hub's reserve line per piece ("Or reserve with ¥20,400 (₱8,105) — 30% down — …"), only when the variant has BOTH `down_payment_jpy` and `down_payment_php` | yen only |
| `full_jpy` | quote `full` + `JPY` | ¥ per piece, no ₱, no reserve line | ¥ per piece |
| `full_php` | quote `full` + `PHP` | ₱ per piece (`variantPricePhp`) + "at today's rate" note; no rate → ¥ + "peso amount at checkout" | same, Japanese note |
| `layaway` | quote `layaway` + term + currency | items in ¥ (and ₱ when the plan is pesos), then a plan panel from `layaway_quote` for the sum of available pieces; the Hub refusing (`below_plan_minimum`, `fx_unavailable`, `term_downgraded`, a term not launched) → the `stage_a` EN form | **never** — JA + layaway renders the `stage_a` JA form |

- ONE LANGUAGE PER EMAIL (D5). No "Japanese first, English below". That is what
  makes the Japanese rule unbreakable: there is no English block to carry a
  layaway line into a Japanese email. The language is `customer_carts.lang`,
  the storefront language at her last cart change.
- THE JAPANESE EMAIL NEVER MENTIONS LAYAWAY, a deposit or a reserve figure, in
  any stage (owner rule 2026-09-25: nothing layaway-related on the Japanese
  site, emails included). `JA_FORBIDDEN` in `_shared/cart-reminder-rules.ts`
  is the word list; `development/cart-reminder-ja.test.ts` renders every form
  in Japanese, HTML and plain text, and fails on any of them. 「お取り置き」 in the
  reserve-first sentence is the owner's own wording for "we hold the piece after
  you ORDER" and is not a layaway word.
- EVERY MONEY FIGURE IS THE HUB'S (owner rule 2026-09-25), recomputed at send
  time from Hub code, never copied from the stored quote: `price_php` =
  `variantPricePhp`; the reserve line = `attachDownPayments` →
  `website_down_payments` → `layaway_quote`; the plan panel =
  `planLayawayQuote` → `layaway_quote` (the `/layaway/quote` path). The template
  and the sender compute no percentage, rate or conversion; a figure the Hub
  cannot produce is omitted. `src/test/cart-reminders.test.tsx` greps both files
  for arithmetic.
- Sold or unpublished pieces are dropped from the email and never mentioned.
  No subtotal (shipping and totals come from `/checkout/quote`). No "similar
  pieces", no discount, no urgency.
- Honest reservation line, both stages: the cart does not hold the pieces. With
  `web_reservation_mode` on, "when you order, we reserve it for you and confirm
  before you pay"; the sweep reads the switch and drops that sentence when it is
  off (D6). Stage B adds "Your earlier checkout did not reserve anything."
- Button: "View your cart" / 「カートを見る」; stage B "Continue to checkout" /
  「ご注文手続きへ進む」. Both → `https://www.chajewelsjp.com/cart/restore`.
- Subject: EN "Still in your cart at Cha Jewels"; JA 「Cha Jewels｜カートに商品が残っています」.
- Mandatory sender block (特定電子メール法 §4, D7): "You're receiving this because
  you asked for cart reminders. Stop cart reminders [link]. Your order emails are
  not affected." then the registered company name, the FULL postal address
  (`COMPANY_ADDRESS` in `_shared/transactional-email-templates/brand.ts`, the
  tokusho address; change it with the storefront's `lib/content/legal.ts`), and
  sales@chajewelsjp.com.
- Templates: `_shared/email-templates/cart-reminder.tsx`; previews
  `storefront-cart-reminder-{ja,en,en-layaway,ja-php}` in `preview-registry.ts`
  (rendered by `development/email-encoding.test.ts` in CI).

## Who is reminded, and when — the SQL decides

`cart_reminder_candidates(p_limit)` applies EVERY rule in one place; the edge
function only renders and sends. A candidate must pass all of:

1. Kill switch `system_settings.cart_reminders_mode`: `off` (seeded) / `owner_only`
   / `on`; anything else is off (fail-closed, `readCartReminderMode` mirrors it).
2. Consent: `customer_email_consents (customer, 'cart_reminder').opted_in`.
3. Customer: `on` → `is_test = false` or an owner-readable address
   (chajewelsjapan@gmail.com, @chajewelsjp.com — the storefront test gate);
   `owner_only` → owner-readable only.
4. Address present, valid, and not in `suppressed_emails` (checked here because
   `storefront-email.ts` does not check it).
5. Idle: `cart.updated_at <= now() - cart_reminder_idle_minutes` (seeded 1440;
   minimum 5 for a test run) AND `>= now() - 7 days` — old carts are never chased.
6. No `cash_orders` / `layaway_accounts` row for her created at or after
   `cart.updated_at` — covers a web order, a reservation and a Hub order staff
   made from Messenger; nothing depends on the storefront's clear arriving.
7. Never twice for one `cycle_id`; never within 7 days of her previous reminder.
8. Stock: at least one line whose product is `active` with `stock_qty >= 1`.
   None → nothing sent, cycle NOT consumed (a restock inside the 7 days qualifies).
9. Local hours 09:00–19:59: `location ILIKE '%philippines%'` → Asia/Manila,
   else Asia/Tokyo.

`claim_cart_reminder` re-checks consent (`FOR SHARE`) and that the cart is still
on that cycle, then inserts the ledger row (`ON CONFLICT (cycle_id) DO NOTHING`)
— an opt-out one second before the sweep still wins. `finish_cart_reminder`
records sent / skipped / failed / suppressed. NEVER retried.

Stage B: the candidate carries `quote_mode` / `quote_currency` / `quote_term`
from her latest `checkout_quotes` row with `created_at >= cycle_started_at` and
`consumed_at IS NULL` (a consumed quote means an order, which rule 6 excludes).
An expired quote still counts: her choices stand; the figures do not.

The second reminder at 72 h is NOT built (recommendation: no for launch).

## The sweep — `cart-reminder-sweep`

pg_cron `cart-reminder-sweep` at `31 * * * *`, Vault service key, like the stage
D sweep. Service role or staff with `system_health`. Order: read the two switches
→ at 18:00 UTC (03:00 JST) `purge_stale_customer_carts` (lines untouched 90 days,
D8; consents and events are kept) → mode off ⇒ `{ mode: 'off' }` →
candidates(50) → claim → render + `sendStorefrontEmail` (label `cart-reminder`,
idempotency `cart-reminder-<cycle_id>`, reference = customer code, one
`email_send_log` row per outcome) → finish. `supabase/config.toml`
`[functions.cart-reminder-sweep] verify_jwt = true`.

## Consent — `customer_email_consents` + the append-only events

- Current state: `(customer_id, kind='cart_reminder')`: `opted_in`,
  `consented_at`, `withdrawn_at`, `source`, `lang`, `text_version`,
  `unsubscribe_token`.
- Legal record: `customer_email_consent_events`, APPEND-ONLY (trigger refuses
  UPDATE/DELETE; the FK's SET NULL on customer deletion is the one allowed
  update): email snapshot, action, source (`account` / `complete_profile` /
  `checkout` / `email_link` / `lovable_unsubscribe` / `staff`), language, the
  exact `text_version` shown, time. Never deleted (特定電子メール法 §3(2),
  特商法 §12-3, PH DPA evidence).
- Writers, all service-role SQL: `set_cart_reminder_consent` (the storefront's
  `PUT /me/cart-reminders`; an opt-in needs a `text_version`),
  `withdraw_cart_reminder_by_token` (the email link; ALWAYS answers
  `unsubscribed`), `withdraw_cart_reminder_by_email` (the provider's own
  unsubscribe, see below).
- The checkbox is OFF by default, separate, and names Cha Jewels and
  "promotional". Checkout has no checkbox at launch (D3). Wording and
  `text_version` live in the storefront (cart-reminder-2026-10).
- The opt-out link touches ONLY the consent row — never `suppressed_emails`, so
  her order emails continue.

### A provider unsubscribe (D1 mitigation)

If she uses Lovable's own unsubscribe on a cart reminder, Lovable may suppress
the ADDRESS on notify.chajewelsjp.com — order emails included. Both webhooks
(`handle-email-suppression`, reason `unsubscribe`; `handle-email-events`,
`email.unsubscribed`) call `withdrawCartRemindersForAddress`
(`_shared/cart-reminder-unsubscribe.ts`): `withdraw_cart_reminder_by_email`
withdraws our consent for every customer on that address (source
`lovable_unsubscribe`) and, when anything was withdrawn, rings staff bell
`cart_reminder_unsubscribed` naming the address so staff know her order emails
may now be held back. Idempotent; never fails the webhook.

Still OPEN with Lovable before `on` (D1): may a promotional reminder go through
`purpose: 'transactional'`; does Lovable add its own unsubscribe footer; does its
unsubscribe suppress all later sends to that address.

## The storefront side (A5, separate PR in cha-jewels-web)

Routes (contract: docs/WEBSITE-VERCEL.md): `GET/PUT /me/cart` (the four cart
actions `PUT` the whole list inside Next `after()`, cookie first, Hub never
awaited; sign-in merges `GET /me/cart` with the cookie, union, larger qty, 20
lines), `PUT /me/cart-reminders` (the `/account` toggle and the
`/account/complete-profile` checkbox), `cart_reminders.opted_in` on `GET /me`,
`GET /cart-reminders/unsubscribe?token=` (the `/cart-reminders/unsubscribe`
page: "Cart reminders are stopped" / 「カートのお知らせを停止しました」, order emails
continue), and the `/cart/restore` route handler (signed in: merge the saved cart
into the cookie → `/cart`; signed out → `/login?next=/cart/restore`). A privacy
notice line: a signed-in customer's cart is saved to her account.

## Tables

`customer_carts` (one per customer: lang, cycle_id, cycle_started_at,
updated_at, client_as_of), `customer_cart_lines` (variant FK ON DELETE CASCADE,
qty 1–20; slug never stored), `customer_email_consents`,
`customer_email_consent_events`, `cart_reminder_sends` (the claim ledger). RLS:
staff may read; only the service role writes, through the functions above.
Settings: `cart_reminders_mode`, `cart_reminder_idle_minutes`.

## Switching on (owner, SQL Editor)

```sql
UPDATE system_settings SET value = '"owner_only"'::jsonb WHERE key = 'cart_reminders_mode';
-- test: UPDATE system_settings SET value = '"5"'::jsonb WHERE key = 'cart_reminder_idle_minutes';
-- after the owner's acceptance run: 'on', and idle back to '"1440"'
```

## Tests

- `docs/sql/20261021_cart_reminders_local_tests.sql` — the SQL, on a local Postgres.
- `development/cart-reminder-ja.test.ts` (deno, CI) — the Japanese rule, the
  Hub-only money, the sender block, rendered.
- `development/email-encoding.test.ts` — renders every form, both languages.
- `src/test/cart-reminders.test.tsx` (vitest, CI) — the rules, the plumbing
  names, the source pins.
