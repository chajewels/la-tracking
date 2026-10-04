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
4. **Capture happens in the Paidy merchant dashboard** (owner 2026-10-04; see
   "Follow-up" below). Paidy's `capture_success` webhook (or the sweep) reads
   the payment back and the Hub RECORDS it by itself through
   review-payment-submission (actor `paidy_auto`): exact yen, nothing
   refunded, `finalize_cash_submission_atomic` in one transaction. A staff
   **Confirm** does the same recording; on a payment Paidy has not captured
   yet it changes nothing ("capture it in the Paidy dashboard"). Expired /
   closed / rejected on Paidy with nothing captured → the submission is
   REJECTED with the note and the customer may pay again (PD4).
5. Reviewer **Reject** (the staff fallback — the invoice stays open) → Paidy is
   read first: a payment Paidy already captured is never rejected; the
   guarded status write claims the rejection; only then
   `POST /payments/:id/close`. A close Paidy refuses becomes a `close_failed`
   case the sweep retries.
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
- "CLAIMED, NOT RECORDED" IS PENDING (independent review 2026-10-04): a
  submission in status `confirmed` with no `confirmed_payment_id` counts as
  pending everywhere a pending payment matters — the filing writer, the
  website's offer and Paidy/card routes (`PENDING_SUBMISSION_OR`,
  `_shared/web-order-rules.ts`), and the cash-order expiry sweep — and the
  customer sees it as "being checked". Reject / under review / clarification
  never overwrite a `confirmed` submission (compare-and-set, 409). A
  rejected authorisation is never refiled; a waiting one is recorded (no
  submission) so the hourly check files or releases it; the writer refuses an
  order that can no longer take a payment; `finalize_cash_submission_atomic`
  refuses a Paidy payment whose record is not `captured`. Every write made
  under a Confirm's claim carries that claim's lease stamp.
- `buyer_data.last_order_amount` is the most recently COMPLETED paid order by
  `completed_at` (P10, `paidyLastOrderAmount()`).
- The storefront enables the Paidy button on `onReady` as well as `onLoad`
  and when `window.Paidy` already exists (P06, cha-jewels-web).

## Follow-up (2026-10-04, review R01–R18; owner answers)
Owner answers: capture in the **Paidy dashboard, Hub auto-records** · Paidy
**only when nothing is paid yet** · fallback = **staff press Reject** · a
refund on an unrecorded payment is **held for a staff decision**.

- PAYMENT LOCK — `cash_order_payment_lock(order)` answers why an order cannot
  take another payment: `paidy_captured_unrecorded`, `paidy_submission_pending`,
  `paidy_authorized` (not rejected, not expired), `paidy_checkout_open`, or the
  ordinary `submission_pending`. Any `paidy_*` reason closes EVERY other route:
  trigger `trg_guard_payment_submission_paidy` refuses a non-Paidy cash
  submission (staff included); website card + Paidy start, portal submit and
  the expiry sweep check it first; the storefront and portal show "Paidy
  payment being processed" and no option at all (`payment_state:
  "paidy_processing"`, `transfer_methods: []`, `paidy_processing` on portal
  cash orders). After a verified Reject / Paidy close the order opens again.
- CHECKOUT WINDOW — `POST /orders/:id/paidy/start` persists
  `paidy_checkout_attempts` BEFORE `Paidy.launch` (refused while anything holds
  the order, a second tab included); `POST /orders/:id/paidy/abandon` when
  Paidy reports closed/rejected; 30-minute timeout otherwise. Filing marks it
  `filed`. A late authorisation (webhook) is still filed or released.
- IMMUTABLE — a Paidy-linked submission's method, amount, order, customer and
  link never change; a rejected/cancelled one is never restored or re-filed;
  nothing is relabelled to or from `paidy`; `paidy_payments` identity/amount
  never change and rows are never deleted (`trg_guard_paidy_payment_identity`).
  The Hub's method dropdown and amount edit are locked on Paidy rows; the
  customer cannot edit or cancel a Paidy submission (she cancels in MyPaidy).
- EXACT YEN (R14) — `paidyYen()`; no rounded comparison anywhere; SQL refuses
  a non-integer amount; finalize checks authorised = submitted = captured.
- FILING (R15) — under the order lock: JPY, `total_paid = 0`, amount =
  balance, not expired, same customer; otherwise `stale_authorization` and the
  authorisation is released.
- RECORDING (R02/R17) — finalize binds the capture to its own order/customer,
  stores `cash_payments.provider_capture_id` (UNIQUE), refuses a refunded
  capture (`paidy_refunded`).
- SYNC (R05–R07) — every pass re-derives the record from Paidy (no "previous
  status" shortcuts): closes / rejections / EXPIRIES reject queued submissions,
  the refund total is recomputed from the ledger each pass, a refund opens its
  case BEFORE its ledger row, the full refund object (with `capture_id`) is
  kept. A captured, unrecorded payment is recorded automatically or becomes a
  case.
- CASES — `paidy_cases` (close_failed, captured_unrecorded,
  captured_no_submission, refund_before_record, refund_after_record,
  record_failed, unmatched_authorization, provider_unreadable). Opened by the
  system once per payment+kind (bell the first time), shown on Payment
  Submissions → "Paidy cases", resolved by staff with a written reason
  (`resolve_paidy_case`, confirm_payment, audited). "Record this capture"
  re-queues a provider-bound submission; "End its submission"
  (`end_submission`) rejects a stuck Paidy submission (refunded, mismatched,
  order closed) so the order opens again. The sweep closes cases Paidy itself
  settled (`close_paidy_case_system`).
- AUTO-RECORDER AUTH — review-payment-submission runs with verify_jwt = false,
  so the recorder is recognised ONLY by an HMAC-SHA256 signature over
  "<submission_id>.<ms timestamp>" keyed with the service-role key (headers
  x-paidy-auto-ts / x-paidy-auto-sig, 5-minute window); a token's claims are
  never trusted there. Only `action: confirmed` on a Paidy submission.
- WEBHOOK (R08/R09) — stored in `paidy_webhook_events` before anything else
  (500 if that fails); processing has an 8 s deadline (Paidy calls 6 s each);
  past it the answer is 200 and the sweep finishes it. Paidy 404 → a case;
  401/403/timeout/5xx → 502 and the event stays.
- SWEEP (R18) — drains the inbox, reads watched payments oldest
  `last_checked_at` first (failures stamp it too), skips other-environment
  payments (not errors), retries refused closes, expires stale windows, reports
  lag (`oldest_event_minutes`, `oldest_check_minutes`, `open_cases`); `ok` is
  false when any row failed. Watch horizon: authorised payments + captures of
  the last 400 days; older refunds are reconciled from Paidy's settlement
  export by hand.
- CHECKOUT DATA (R10–R13) — items + shipping − discount (a negative "Discount"
  line) + an explicit "Other charges" line = amount, else not offered; buyer =
  the customer (never the recipient), billing address from her own default JP
  address only; phone only a Japanese mobile; history = completed yen orders
  not paid with Paidy and not refunded, by order value, `last_order_at` in
  days; registration date only from `customers.created_at`. Address lines:
  Paidy line1 = building/room (our line2), line2 = street (our line1).
  OWNER TO CONFIRM WITH PAIDY: the address-line mapping and the negative
  discount line.
- NOT CHANGED (live-first rule): `terminate_web_order_atomic` /
  `expire_web_layaway_atomic` bodies — the expiry sweep checks the lock in
  TypeScript first; a seconds-wide race remains (docs/OPEN-BUGS.md).

## Owner answers (2026-10-04, second round) — migration 20261104110000
- REASSIGN OWNER — a cash order with ANY Paidy history (a `paidy_payments` row,
  a checkout attempt, or a Paidy submission) is REFUSED with code `paidy_order`
  and a plain reason. A web order belongs to the signed-in customer who paid;
  Paidy rows keep their customer. Added to `reassign_order_owner_atomic` by an
  md5-guarded in-place patch of the live body (Bug #280 rule).
- NOTHING ELSE WHILE PAIDY HOLDS THE ORDER — trigger
  `trg_guard_cash_payment_paidy` (BEFORE INSERT OR UPDATE OF voided_at,
  cash_order_id, payment_method on `cash_payments`) refuses any non-Paidy
  payment row, an un-void, a live row moved onto the order and a relabel into
  'paidy', while `cash_order_payment_lock` says `paidy_*`. This closes the three writers that
  never went through a submission: store credit (`redeem_store_credit_atomic`),
  a loyalty discount (`approve_redemption_atomic`) and Restore payment
  (`restore-cash-payment`). Their edge functions answer 409 in plain words
  ("…only after staff Reject the Paidy payment"); the whole write rolls back, so
  no credit, points or payment are spent. Paidy's own recording, voids and
  everything after a Reject still work. OPEN before Square goes live: a
  Square Confirm must check the lock BEFORE capturing (docs/OPEN-BUGS.md).
- LAYAWAY — Paidy never pays a layaway deposit or instalment (it is offered on
  yen CASH orders only, `paidyNotOfferedReason`), and a Paidy-paid order never
  becomes a layaway (no path converts a cash order into a plan). Forfeit and
  refund-to-customer rules do not apply to Paidy money: Paidy pays the shop,
  the customer pays Paidy.
- LOYALTY — points are earned ONCE PAID: the Paidy recording that completes the
  order goes through review-payment-submission, which awards exactly as for a
  bank transfer (cash: on completion).
- PROCESS RULE (not a code bug) — staff capture ONLY a Paidy payment that is
  listed in the Hub (Payment Submissions, Paidy pill). The Hub files every
  authorisation before anyone can capture; a capture with no Hub record can
  happen only if someone captures an unlisted payment in the dashboard, and the
  system still opens a `captured_no_submission` case for it.
- BULK IMPORT — never touches Paidy: it imports LAYAWAY payments only
  (`BulkPaymentImport.tsx`), and Paidy is cash-order only.

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
- The Hub NEVER captures (owner 2026-10-04): staff capture in the Paidy
  merchant dashboard; the Hub records what Paidy reports. Close only on Reject,
  a mismatch / stale filing, or the sweep's retry of a refused close.
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
- `supabase/migrations/20261030100000_paidy_payments.sql`, `20261102100000_paidy_integrity.sql` (expires_at, capture_started_at, processing_started_at, paidy_refunds, the two atomic writers), `20261103100000_paidy_followup.sql` (lock, attempts, cases, inbox, guards, stricter writers), `20261104110000_paidy_owner_answers.sql` (Reassign refusal `paidy_order`, `cash_payments` guard; harness `harness/paidy-owner-answers/`)
- `supabase/functions/_shared/paidy-events.ts` (one webhook event; webhook + sweep), `_shared/paidy-autorecord.ts` (the service-role recorder), `src/components/payments/PaidyCasesPanel.tsx`
- `supabase/functions/_shared/paidy-filing.ts` (file / adopt an authorisation), `_shared/paidy-sync.ts` (webhook + hourly sync; `development/paidy-sync.test.ts`)
- `supabase/functions/paidy-reconcile/index.ts` (hourly, service role)
- `supabase/functions/_shared/paidy-rules.ts` (pure; `src/test/paidy-rules.test.ts`), `_shared/paidy.ts` (API client)
- `supabase/functions/website/index.ts` (`paidyOffer()`, `GET /orders/:id` fields, `POST /orders/:id/paidy`)
- `supabase/functions/review-payment-submission/index.ts` (record a dashboard capture / close on Reject / proof exception / the paidy_auto service path)
- `supabase/functions/paidy-webhook/index.ts`, `supabase/config.toml`
- `supabase/functions/_shared/reservation-emails.ts`, `_shared/email-templates/order-confirmation.tsx` (`PAIDY_LINE`)
- `src/components/settings/PaidySettingsCard.tsx`, `paidy-settings.ts`, `src/pages/Website.tsx`
- `src/pages/PaymentSubmissions.tsx` (Paidy pill, dialog copy, Confirm enabled without a file, Finish recording), `src/pages/CashOrderDetail.tsx` (panel line)
- Storefront: `cha-jewels-web` PR "feat(orders): Paidy ato-barai on a confirmed order"; contract `supabase/contracts/api.md` (both repos)

## Checkout payment choice + points (2026-10-05)

See docs/CHECKOUT-CHOICE.md: the method is chosen at checkout and locked for the customer (staff change it with change-payment-method); points used at checkout are a LOYALTY- discount approved at staff Confirm, never "money paid".
