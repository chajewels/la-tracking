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
   { paidy_payment_id }`. A retry for an authorisation already filed on this
   order returns that submission (P01). Otherwise the Hub re-reads the payment
   from Paidy with `PAIDY_SECRET_KEY` and `filePaidyAuthorization()`
   (`_shared/paidy-filing.ts`) checks it with `paidyFilingMismatch()` (status
   AUTHORIZED, JPY, `test` flag = mode, amount = remaining balance, `order_ref`
   = the customer reference); a mismatch is CLOSED on Paidy and answered 409
   `paidy_mismatch`. Then `file_paidy_submission_atomic` writes the
   `paidy_payments` row (with Paidy's `expires_at`), the `payment_submissions`
   row (`payment_method 'paidy'`, `reference_number` = the Paidy id,
   `proof_url null`) and the audit row in ONE transaction under a lock on the
   order; bell `paidy_authorized`. 3 per 24 h per order.
4. Reviewer **Confirm** (review-payment-submission, cash branch) — see
   "Integrity" below: claim with a 5-minute lease, read Paidy FIRST, capture
   only an authorisation whose amounts agree, read Paidy again after any
   capture error, decide by what Paidy says; the payment is recorded by
   `finalize_cash_submission_atomic` in one transaction. Expired / closed /
   rejected on Paidy with nothing captured → the submission is REJECTED with
   the note and the customer pays again (PD4).
5. Reviewer **Reject** → Paidy is read first: a payment Paidy already captured
   is never rejected (409 `paidy_already_captured` — Confirm it instead); a
   claimed submission is never rejected (use Finish recording); otherwise
   `POST /payments/:id/close` (best effort; a failure rings
   `paidy_close_failed`; the authorisation lapses by itself at 30 days).
6. `paidy-webhook` (public, `verify_jwt = false`): Paidy signs nothing, so the
   body only names an id; the Hub re-reads the payment and runs
   `syncPaidyPayment()` (`_shared/paidy-sync.ts`). CLOSED/REJECTED by Paidy
   while a submission is still queued → rejected with the note, bell
   `paidy_closed_externally`. Capture and close never happen here.
7. `paidy-reconcile` (hourly, service role, Vault key) runs the same sync over
   every authorised payment and every capture of the last 400 days.

## Integrity (2026-10-04, review P01–P12; owner answers Q1–Q5)
- ONE TRANSACTION TO FILE (P01/P04): `file_paidy_submission_atomic` — record,
  submission, audit together under the order lock; one pending payment per
  order (owner Q2); idempotent on the Paidy id (`existing` / `recovered`).
- ONE TRANSACTION TO RECORD (P02, owner Q1 c): every cash-order Confirm, any
  method, records through `finalize_cash_submission_atomic` (cash_payments +
  cash_orders totals/status + submission link + audit, locks on order and
  submission, ceiling re-checked on the locked balance, idempotent on
  `confirmed_payment_id`). The hand-rolled rollback is gone. Square's capture
  logic is unchanged.
- DECIDE BY PAIDY'S READ-BACK, NEVER BY AN HTTP STATUS (P03): Paidy answers an
  expired capture 400 `payment.authorization.expired` and a closed one 403
  `service.forbidden` — the old 404/409 branch never fired. `paidyProviderOutcome()`
  maps the read-back to captured / authorized / expired / closed / rejected /
  unknown. "Pay again" is said ONLY for expired / closed / rejected with no
  capture. Unknown or Paidy unreachable → the claim is released, bell
  `paidy_capture_unverified`, 502, nothing recorded; the next Confirm reads
  Paidy first, so a capture that did happen is recorded and never repeated.
- AMOUNTS AGREE BEFORE MONEY MOVES (P08): Paidy's amount = the recorded amount
  = the submission = no more than the order's balance
  (`paidyCaptureAmountProblem()`); after capture the captured yen must equal
  the submission or nothing is recorded (bell `paidy_recording_failed`).
- EXPIRY IS PAIDY'S `expires_at` (P07), stored on `paidy_payments.expires_at`;
  30 days after authorisation only when Paidy did not send it.
- DATE PAID = THE CAPTURE DAY IN JAPAN TIME (owner Q5, `paidyJapanDate()`). An
  owner exception to the PHT day boundary, for Paidy captures only; the
  submission's own `payment_date` stays PHT.
- AN INTERRUPTED CONFIRM IS FINISHED, NEVER GUESSED (P02, owner Q4 a): the claim
  stamps `payment_submissions.processing_started_at`. A Paidy submission left
  `confirmed` with no `confirmed_payment_id` shows **Finish recording** in
  Payment Submissions once the lease is older than 5 minutes; it re-runs
  Confirm (reads Paidy first; records a capture, captures an authorisation,
  rejects an expired one). Bells: `paidy_recording_failed` (capture taken,
  recording failed) and `paidy_confirm_interrupted` (hourly check). Never
  automatic recording.
- A LOST CALLBACK IS FILED, NOT LOST (P12, owner Q3): the money is with Paidy,
  never with the customer, so an authorisation the Hub has no record of
  (webhook `authorize_success`, matched by `order_ref`) is FILED for staff to
  Confirm after a 3-minute grace for the website callback (503 → Paidy
  retries). It is released (closed, no charge) only when the order can no
  longer take it; bell `paidy_unmatched_authorization` either way. Paidy has
  no "list payments" API, so only the webhook can discover an unknown id.
- CAPTURED ON PAIDY, NOT IN THE HUB → bell `paidy_captured_unrecorded` (once per
  24 h per payment); the Hub never records it by itself.
- REFUNDS (P11): every refund Paidy reports is stored once in `paidy_refunds`
  (UNIQUE refund id), `paidy_payments.refund_jpy` is the total, bell
  `paidy_refund_recorded`. Order balances and refund decisions are NEVER
  changed from it. Refunds are made in the Paidy merchant dashboard; a Hub
  refund button is not built.
- EVERY WRITE IS CHECKED (P05): the webhook answers 5xx on any failed read or
  write so Paidy retries (about 5 hours of back-off); a 200 stops the retries.
- `buyer_data.last_order_amount` is the most recently COMPLETED paid order by
  `completed_at` (P10, `paidyLastOrderAmount()`).
- The storefront enables the Paidy button on `onReady` as well as `onLoad`
  and when `window.Paidy` already exists (P06, cha-jewels-web).

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
- N-PAY WIDGET (owner W1–W5, 2026-10-03): Paidy's promotional banner under the
  product price, product pages only (EN and JA), rendered by Paidy's own script
  from the Hub's yen price — the storefront computes nothing. Shown ONLY while
  `paidy_mode = 'on'` (`GET /paidy/widget`); the 6/12-pay attributes are added
  only after Paidy confirms the 6回/12回 activation, never before.
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
- `supabase/migrations/20261030100000_paidy_payments.sql`, `20261102100000_paidy_integrity.sql` (expires_at, capture_started_at, processing_started_at, paidy_refunds, the two atomic writers)
- `supabase/functions/_shared/paidy-filing.ts` (file / adopt an authorisation), `_shared/paidy-sync.ts` (webhook + hourly sync; `development/paidy-sync.test.ts`)
- `supabase/functions/paidy-reconcile/index.ts` (hourly, service role)
- `supabase/functions/_shared/paidy-rules.ts` (pure; `src/test/paidy-rules.test.ts`), `_shared/paidy.ts` (API client)
- `supabase/functions/website/index.ts` (`paidyOffer()`, `GET /orders/:id` fields, `POST /orders/:id/paidy`)
- `supabase/functions/review-payment-submission/index.ts` (capture / close / proof exception)
- `supabase/functions/paidy-webhook/index.ts`, `supabase/config.toml`
- `supabase/functions/_shared/reservation-emails.ts`, `_shared/email-templates/order-confirmation.tsx` (`PAIDY_LINE`)
- `src/components/settings/PaidySettingsCard.tsx`, `paidy-settings.ts`, `src/pages/Website.tsx`
- `src/pages/PaymentSubmissions.tsx` (Paidy pill, dialog copy, Confirm enabled without a file, Finish recording), `src/pages/CashOrderDetail.tsx` (panel line)
- Storefront: `cha-jewels-web` PR "feat(orders): Paidy ato-barai on a confirmed order"; contract `supabase/contracts/api.md` (both repos)
