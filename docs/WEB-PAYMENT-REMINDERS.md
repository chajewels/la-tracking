# Web payment reminders (stage D) and the 48h reservation bell (stage C)

Added 2026-10-04, from the approved plan
`~/Code/reference/abandoned-cart-investigation.md`, revision 2 (§2j, §2k, §3b′;
owner decisions D12–D18). This is step 1 of that plan. Cart reminders (stages A/B)
are a separate, later PR and share nothing with this one.

Migration: `supabase/migrations/20261004100000_web_payment_reminders.sql`, run by
the owner. Local proof: `docs/sql/20261004_web_payment_reminders_local_{stub,tests}.sql`.

## What the customer gets

ONE email before the transfer deadline of a web order or web layaway that staff
have confirmed and nothing has been paid on. It is transactional (her own order),
so it needs no consent. It reads **no** consent, newsletter, cart-reminder or
suppression row, so a cart-reminder opt-out can never block it.

| | Cash order (full payment) | Layaway |
|---|---|---|
| Template | `order-payment-due.tsx` | `layaway-deposit-due.tsx` |
| Amount | `remaining_balance`, in the order's currency (¥ or ₱) | `downpayment_amount`, in the plan's currency |
| Language | the order's `customer_lang`: `ja` gives Japanese then English; `en` gives English only (the same rule as every order email) | **English only.** The template has no `lang` prop and no Japanese copy. |
| Methods | every active transfer method for that currency (`transferMethods`), with the region from the currency | same |
| Also shown | the deadline (JST for yen, PHT for pesos); "after the deadline it is cancelled and goes back on sale"; "already paid? upload proof or reply"; the order page button | same, plan page |

No products, no offers, no layaway wording in the cash email. Adding a promotion
would make it a 特定電子メール and require consent. `src/test/web-payment-reminders.test.tsx`
fails on promotional words and on any Japanese in the layaway template. The
registered company name in the footer is the one exception; it is in every
customer email.

## When (D12)

- **Eligible:**
  - `source_channel = 'web'`;
  - staff-confirmed (`ready_confirmed_at` set);
  - `transfer_due_at` set.
  - Cash: `status = pending`, `payment_status = pending_transfer`, `remaining_balance > 0`.
  - Layaway: `status = active`, `total_paid = 0`, `downpayment_amount > 0`.
- **Skipped when:**
  - a payment submission is `submitted` / `under_review` (INVARIANT 12's predicate; for a layaway also through `payment_submission_allocations`);
  - the order is paid, cancelled or expired;
  - the deadline has passed or is less than 1 hour away;
  - the customer has no valid address;
  - the customer is `is_test` and the address is not owner-readable. This is the storefront test gate, repeated in SQL.
- **Window:**
  - if `transfer_due_at − ready_confirmed_at ≤ 30h` (the 24h first-order deadline), the reminder is sent when **≤ 6h** remain;
  - otherwise (72h, or a deadline staff moved) when **≤ 24h** remain;
  - the hourly run at :13 sends the first time the order is inside its window.
- **No quiet hours.** The plan (§2k) chose on-time delivery: the deadline is the customer's.
- **Dedupe:**
  - `UNIQUE (entity_type, entity_id, deadline)` on `web_payment_reminders`;
  - idempotency key `payment-due-<id>-<deadline epoch>`;
  - a moved deadline earns one more reminder, and **never more than 2 per order**;
  - claimed before the send and never retried: a failed send still counts.
- **Web orders only (D14).** Staff chase Hub-made orders over Messenger.

## Who decides

**SQL decides everything. The edge function only renders and sends.**

- **`web_payment_reminder_eligible(type, id)`** is the one rule.
  - Read-only preview: `SELECT * FROM web_payment_reminder_eligible(NULL, NULL)`.
- **`web_payment_reminder_candidates(limit)`** applies the switch, then the rule.
- **`claim_web_payment_reminder(type, id, deadline)`**:
  - locks the order row;
  - re-runs the rule **and** the switch;
  - refuses a deadline that is no longer the order's;
  - inserts the ledger row.
  - A proof upload, a payment, a moved deadline, the switch turned off, or a second run in between all win. A NULL return means nothing is sent.
- **`finish_web_payment_reminder(id, status, detail)`** records sent / skipped / failed / suppressed.
- **`web-payment-reminder-sweep`** (edge function, verify_jwt, service role or `system_health`):
  - reads the switch, returns early when off;
  - otherwise runs candidates → claim → `sendClaimedPaymentReminder` → finish.
  - `sendClaimedPaymentReminder` renders from the **claimed row** and sends through `sendStorefrontEmail`, the order-email pipeline: brand, Reply-To sales@, `purpose: 'transactional'`, test gate, `email_send_log`.
- **`_shared/web-payment-reminder-rules.ts`** is the TS mirror, for vitest and the Hub. Change it together with the SQL.

## The switch

Two `system_settings` rows, both guarded by `trg_guard_web_payment_reminders`. Every SQL or PostgREST write is refused.

| Key | Value | Seeded |
|---|---|---|
| `web_payment_reminders_mode` | `"off"` \| `"owner_only"` \| `"on"`. Anything else reads as off (fail-closed). | `"off"` |
| `web_payment_reminders_owner_addresses` | JSON array. Each entry is a full address or `"@domain"`. | `["chajewelsjapan@gmail.com", "@chajewelsjp.com"]` |

- **Changed only in Hub → Settings → General → Payment reminders**, which calls `set_web_payment_reminders`:
  - ADMIN ROLE only;
  - `p_expected_mode` stale check;
  - owner list validated, max 20 entries;
  - `owner_only` needs at least one entry;
  - one `audit_logs` row per change.
- **Read** through `get_web_payment_reminders` (admin or `admin_settings`). It also returns `due_now` and `sent_7d`.
- **Rollout:** off → owner_only (owner acceptance) → on.
- **The migration never writes an existing value.** Its self-check aborts if a first run leaves the mode anything but off.

## Stage C: the 48h "last day" bell (D13)

- **What it is:** `web_reservation_expiring_bells()`, pure SQL on its own cron job `web-reservation-expiring-bell` (hourly at :13).
  - It runs **whatever the payment switch says**, because it is staff-only and sends no email.
- **Who gets a bell:** every web reservation still unconfirmed (`ready_confirmed_at IS NULL`, live status) whose age is 48–72h.
  - It gets one `staff_notifications` row of type `web_reservation_expiring`, titled "Last day — {ref} auto-cancels at {time} PHT".
  - Deduped on `metadata.entity_id`.
  - The bell links to the order through `metadata.cash_order_id` / `account_id`.
- **Unchanged:** the 24h sales@ digest and the 72h auto-cancel (`web-reservation-sweep`).

## Order email history

`get_order_email_history(type, id)` is staff only (`is_staff`). It returns:
- the storefront `email_send_log` rows whose `metadata.reference` is the order's `web_reference` or invoice number (newest 100);
- the order's `web_payment_reminders` rows.

The Hub shows it as **Customer emails** on web cash orders and web layaways (`OrderEmailHistory`).

## D17 fix (pre-existing)

`auto-expire-cash-orders` sent `layaway-expired` with `pickLang(customer_lang)`. `pickLang` reads a missing language as Japanese, so a plan could get a Japanese block about its hold. The call now passes `lang: "en"`. The cash `order-expired` email keeps the customer's language. See docs/FIXED-BUGS.md.

## Deploy order

1. Hub PR → `develop` → release PR → `main` (owner merges), then merge `main` back into `develop`.
2. Lovable, deploy only:
   - `web-payment-reminder-sweep` (new, verify_jwt = true);
   - `auto-expire-cash-orders` (D17);
   - `preview-transactional-email` (bundles the changed preview registry; previews only).
3. Owner runs the migration in the SQL Editor. The mode stays off.
4. Owner acceptance test in `owner_only` mode, then `on`.
