# Paidy 『あと払い（ペイディ）』 on a confirmed web order (2026-10-03)

Owner decisions: P1 pay after staff Confirm, P5 Japanese delivery address only
(EN and JA sites), P6 pay-next-month + 3回 (both enabled by the merchant terms;
the customer picks 3回 in the Paidy app), PD1 no proof file on a Paidy
submission, PD2 Paidy above the bank details, PD3 the switch ships off,
PD4 an expired authorisation auto-rejects the submission. Terms: pay-next-month
3.50%, 3回 4.50% (3.50% + 1.00% when the customer switches), month-end close,
paid on the 20th of the next month, ¥500+tax transfer fee; Paidy pays the
merchant once in full. Reference: paidy.com/docs/api/en, paidy.com/docs/en/paidycheckout.html.

## Flow
1. Staff Confirm the draft → the real order exists (`cash_orders`, yen,
   `payment_status = 'pending_transfer'`). The order-ready email carries one
   Paidy line when the order would offer it.
2. `GET /orders/:id` (website) returns `paidy: { offered, public_key, test,
   checkout }` when `paidyNotOfferedReason()` is null (`_shared/paidy-rules.ts`):
   `paidy_mode` on (or test + `customers.is_test`), a public key of the mode's
   family, JPY, order `pending` / `pending_transfer`, not an unconfirmed
   reservation, `remaining_balance > 0`, ship-to snapshot country JP with line1,
   city, region and a 7-digit postal code, no `submitted | under_review`
   submission. `checkout` is the exact `Paidy.launch()` payload — amount =
   remaining balance, the order's lines, `buyer_data` from this customer's paid
   yen cash orders. The storefront passes it through untouched.
3. The customer finishes Paidy's window → `POST /orders/:id/paidy
   { paidy_payment_id }`. The Hub re-reads the payment from Paidy with
   `PAIDY_SECRET_KEY` (status AUTHORIZED, JPY, `test` flag = mode, amount =
   remaining balance, `order_ref` = the customer reference); a mismatch is
   CLOSED on Paidy and answered 409 `paidy_mismatch`. Then one `paidy_payments`
   row (authorized) and one `payment_submissions` row (`payment_method 'paidy'`,
   `reference_number` = the Paidy id, `proof_url null`, `paidy_payment_id`),
   audit row, bell `paidy_authorized`. 3 per 24 h per order.
4. Reviewer **Confirm** (review-payment-submission, cash branch): after the
   atomic claim and before `cash_payments` → `POST /payments/:id/captures`.
   Success → `paidy_payments` captured; the cash payment is written as today.
   Paidy 404/409 or > 30 days since authorisation (PD4) → the submission is
   REJECTED with the note, `paidy_payments` expired, 409
   `paidy_authorization_expired`; any other failure → claim reverted, 502
   `paidy_capture_failed`, nothing written.
5. Reviewer **Reject** → `POST /payments/:id/close` (best effort; a failure
   rings `paidy_close_failed`; the authorisation lapses by itself at 30 days).
6. `paidy-webhook` (public, `verify_jwt = false`): Paidy signs nothing, so the
   body only names an id; the Hub re-reads the payment and syncs
   `paidy_payments`. CLOSED/REJECTED by Paidy while a submission is still
   pending → the submission is rejected with the note, bell
   `paidy_closed_externally`. Capture and close never happen here.

## Rules (also one line each in CLAUDE.md)
- The secret key is the edge-function secret `PAIDY_SECRET_KEY` only — never
  the database, the repo, chat or a Lovable prompt body. `set_paidy_settings`
  refuses an `sk_` key.
- `paidy_mode` (off | test | on, fail-closed) and `paidy_public_key` change ONLY
  through `set_paidy_settings` (admin role, audited; guard trigger
  `trg_guard_paidy_settings`); never in a migration or SQL. The key family must
  match the mode (test ↔ pk_test_, on ↔ pk_live_); the secret's family is
  compared too before any Paidy call (`paidySecretIsTest()`).
- A Paidy submission is the ONE exception to PROOF REQUIRED (PD1): the proof is
  the authorisation the Hub read back. Every other method keeps the rule.
- Capture happens ONLY in review-payment-submission on Confirm; close on
  Reject; nothing in SQL, nothing from the storefront, nothing from the webhook.
- Refunds after capture are NOT automatic and not built: the cancel +
  refund-decision path records the decision; a Paidy refund button is a later
  admin feature (`POST /payments/:id/refunds` with the `capture_id`).
- A Paidy payment is yen only; a peso order never offers it.
- PAIDY'S STATUS CASE IS NOT TRUSTED: the reference documents AUTHORIZED |
  CLOSED | REJECTED, but the live Checkout callback sent `"authorized"` in lower
  case (test run 2026-10-03, pay_asDHekoAAEkAmsmA) and the storefront dropped
  the authorisation as "window closed". `normalizePaidyPayment()` in
  `_shared/paidy.ts` upper-cases every API read-back; the storefront's
  `paidyStatus()` (lib/paidy.ts, PR #261) does the same for the callback. Never
  compare a raw Paidy status again.

## Settings and go-live
Website → Settings → Paidy (admin): mode + public key. Sequence: migration
applied → secret set → mode `test` with `pk_test_` → Test Customer run
(authorise → Confirm → capture in the Paidy console; authorise → Reject →
closed; webhook delivered) → Paidy self-check sheet → live keys → mode `on`.
Test accounts: `successful.payment@paidy.com` / `rejected.payment@paidy.com`,
phone `08000000001`, SMS code `8888`.

## Files
- `supabase/migrations/20261030100000_paidy_payments.sql`
- `supabase/functions/_shared/paidy-rules.ts` (pure; `src/test/paidy-rules.test.ts`), `_shared/paidy.ts` (API client)
- `supabase/functions/website/index.ts` (`paidyOffer()`, `GET /orders/:id` fields, `POST /orders/:id/paidy`)
- `supabase/functions/review-payment-submission/index.ts` (capture / close / proof exception)
- `supabase/functions/paidy-webhook/index.ts`, `supabase/config.toml`
- `supabase/functions/_shared/reservation-emails.ts`, `_shared/email-templates/order-confirmation.tsx` (`PAIDY_LINE`)
- `src/components/settings/PaidySettingsCard.tsx`, `paidy-settings.ts`, `src/pages/Website.tsx`
- `src/pages/PaymentSubmissions.tsx` (Paidy pill, dialog copy, Confirm enabled without a file), `src/pages/CashOrderDetail.tsx` (panel line)
- Storefront: `cha-jewels-web` PR "feat(orders): Paidy ato-barai on a confirmed order"; contract `supabase/contracts/api.md` (both repos)
