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
   remaining balance, the order's lines, `buyer_data` from this customer's
   COMPLETED yen orders that were not paid with Paidy and not refunded
   (cancelled / expired never count), plus her completed yen layaway plans
   (H9). Built by `paidyCheckoutPayload()`. The storefront passes it through
   untouched.
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
- DECIDE BY PAIDY'S READ-BACK, NEVER BY AN HTTP STATUS (P03): in our test runs
  Paidy answered an expired capture 400 `payment.authorization.expired` and a
  closed one 403 `service.forbidden` (OBSERVED behaviour — these code strings
  are not on Paidy's published API pages, which show only generic 403/409
  examples) — the old 404/409 branch never fired. `paidyProviderOutcome()`
  maps the read-back to captured / authorized / expired / closed / rejected /
  unknown. "Pay again" is said ONLY for expired / closed / rejected with no
  capture. Unknown or Paidy unreachable → the claim is released, bell
  `paidy_capture_unverified`, 502, nothing recorded; the next Confirm reads
  Paidy first, so a capture that did happen is recorded and never repeated.
- AMOUNTS AGREE BEFORE MONEY MOVES (P08): Paidy's amount = the recorded amount
  = the submission = no more than the order's balance
  (`paidyCaptureAmountProblem()`); after capture the captured yen must equal
  the submission or nothing is recorded (bell `paidy_recording_failed`).
- EXPIRY IS PAIDY'S `expires_at` (P07), stored on `paidy_payments.expires_at`.
  Paidy's developer docs state no fixed authorisation length; 30 days after
  authorisation (`PAIDY_AUTH_DAYS`) is a FALLBACK only, used when Paidy did not
  send `expires_at`. The `paidy_authorized` bell shows the `expires_at` date
  (JST) and says "valid 30 days" only in that fallback case.
- DATE PAID = THE CAPTURE DAY IN JAPAN TIME (owner Q5, `paidyJapanDate()`). An
  owner exception to the PHT day boundary, for Paidy captures only; the
  submission's own `payment_date` stays PHT.
- AN INTERRUPTED CONFIRM IS FINISHED, NEVER GUESSED (P02, owner Q4 a): the claim
  stamps `payment_submissions.processing_started_at`. A Paidy submission left
  `confirmed` with no `confirmed_payment_id` shows **Finish recording** in
  Payment Submissions once the lease is older than 5 minutes; it re-runs
  Confirm (reads Paidy first; records a capture Paidy reports, leaves a
  not-yet-captured authorisation alone — the Hub never captures — and rejects
  an expired one). Bells: `paidy_recording_failed` (capture taken,
  recording failed) and `paidy_confirm_interrupted` (hourly check). Never
  automatic recording.
- A LOST CALLBACK IS FILED, NOT LOST (P12, owner Q3): the money is with Paidy,
  never with the customer, so an authorisation the Hub has no record of
  (webhook `authorize_success`, matched by `order_ref`) is FILED for staff to
  Confirm after a 3-minute grace for the website callback (503 → Paidy
  retries). It is released (closed, no charge) only when the order can no
  longer take it; bell `paidy_unmatched_authorization` either way. Paidy has
  no "list payments" API, so only the webhook can discover an unknown id.
- CAPTURED ON PAIDY, NOT IN THE HUB → the Hub RECORDS it automatically (step 4
  above, actor `paidy_auto`); only when that recording cannot happen (amounts
  disagree, refunded, no submission) does it become a case / bell
  `paidy_captured_unrecorded` (once per 24 h per payment).
- REFUNDS (P11): every refund Paidy reports is stored once in `paidy_refunds`
  (UNIQUE refund id), `paidy_payments.refund_jpy` is the total, bell
  `paidy_refund_recorded`. Order balances and refund decisions are NEVER
  changed from it. Refunds are made in the Paidy merchant dashboard; a Hub
  refund button is not built. Customer email (addendum §9 #9, 2026-10-06): a
  refund newly stored in `paidy_refunds` sends 「返金を受け付けました」 on a web order
  (`refund-received-paidy-<refund id>`). A filed authorisation sends
  「お支払いを受け付けました」 from `filePaidyAuthorization`, whichever path filed it
  (§9 #1).
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
- `buyer_data.last_order_amount` is the most recently COMPLETED order by
  `completed_at` (P10; computed in `paidyBuyerHistory()`, with the same
  exclusions as `ltv`).
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
  RESOLVED by Paidy's own docs (paidy.com/docs/en/paidycheckout.html, checked
  2026-10-06): line1 = "building name, apartment number", line2 = "district,
  land number, land number extension" — what we send; and "If the order item
  is a discount or coupon, set the unit_price to a negative value" — our
  "Discount" / "Points" lines.
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

## Alignment with Paidy's docs (H9, 2026-10-06)
Checked against paidy.com/docs/en/paidycheckout.html and webhook.html.
- `buyer_data.billing_address` (Paidy: REQUIRED, "billing address (i.e.,
  residence)"): her default address-book entry when it is a complete JP
  address, else her own `customers` record when THAT is complete
  (`paidyBillingAddress()`), never the ship-to / gift recipient. Otherwise
  omitted and the function logs `[paidy] billing_address omitted:
  no_complete_jp_billing_address` (no address text). NOTE: `customers` has no
  prefecture / line2 column, so the customer-record fallback cannot pass the
  completeness check (it needs a region) until such a column exists.
- History (`ltv`, `order_count`, `last_order_*`) adds her COMPLETED yen
  `layaway_accounts` (value `total_amount`, date `completed_at`, else
  `order_date`); forfeited / cancelled / final_* plans never count.
- `buyer.dob` = `customers.birthday` (YYYY-MM-DD) when a real date.
- `buyer_data.number_of_points` (Paidy: points held "prior to this order") =
  `loyalty_members.remaining_points` + the points spent on this order (Confirm
  already deducted them; 1 pt = ¥1). Omitted when she is not a member.
- `order.tax` is omitted (optional; prices are tax-inclusive — 0 was wrong).
- `metadata` = `{ cash_order_id, customer_id, source: "web" }` (max 20 keys).
- WEBHOOK SOURCE CHECK IS SOFT (controller ruling R14): EVERY delivery is
  processed exactly as before (inbox row, re-read from Paidy) — a dropped real
  webhook is unrecoverable for an authorisation the Hub does not know (P12),
  and the header can be appended to or misread. The source IP is
  `cf-connecting-ip` when present, else the LAST `x-forwarded-for` entry (the
  one the platform adds), `paidyWebhookSourceIp()`. It is compared with
  Paidy's 5 published IPs (`PAIDY_WEBHOOK_IPS`: 13.114.134.35, 13.113.94.100,
  18.182.135.232, 52.199.50.20, 52.199.62.26) and decides ONE thing: whether
  an id Paidy does not know (404) may open a `provider_unreadable` case + staff
  bell. Recognised → as before. Unrecognised → no case, no bell, the inbox row
  is marked `(unrecognised source)` and the function logs
  `[paidy-webhook] unrecognised source <ip>` (IP only). ESCAPE HATCH: edge
  secret `PAIDY_WEBHOOK_IP_CHECK=off` treats every source as recognised; any
  other value or no secret = on. Edge case: a delivery that passes the 8 s
  deadline is finished by the sweep, which does not know the source and opens
  the case as before.
- GO-LIVE CHECK (source IP): after the first deploy, log the raw
  `cf-connecting-ip` and `x-forwarded-for` headers of ONE real Paidy test
  webhook (temporary log, then remove) and confirm the platform supplies
  Paidy's IP in `cf-connecting-ip` or as the last XFF entry. If not, real
  Paidy 404s would be logged as "unrecognised source" with no bell — set
  `PAIDY_WEBHOOK_IP_CHECK=off` until the parsing is fixed.
- Buyer history (cash and layaway) leaves out test accounts: numeric invoice
  numbers only (`invoice_number ~ '^[0-9]+$'`).

Open for owner (NOT implemented):
- P2-1 `buyer.name1`: Paidy asks for kanji, FAMILY name first, space-separated;
  we send `customers.full_name` as stored (often given-name first, Latin).
  Needs a family/given (or "name as on ID") field.
- P2-7 an order cancelled or expired while Paidy still holds an authorisation:
  Paidy "highly recommends" closing it; today staff Reject does. Auto-close
  would extend the close triggers in the rule below.

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

## Owner decisions 2026-10-06 (Paidy chat)

- **buyer.name1 is family name first.** `paidyFamilyFirstName` (`_shared/paidy-rules.ts`): a name in Japanese script is sent as written; a name in Latin letters moves its last word to the front ("Maria Santos" → "Santos Maria"). Known limit: a two-word surname ("Maria Dela Cruz") gives "Cruz Maria Dela" — customers has one `full_name` column.
- **A staff cancel closes an open Paidy authorisation first.** `cancel-cash-order` → `releasePaidyForCancel` (`_shared/paidy-cancel-release.ts`): reads each authorised payment back from Paidy; still authorised → `POST /payments/:id/close`, the row → `closed`, its pending submission rejected quietly (the customer gets the cancellation email only); already captured → the cancel is REFUSED (record it, refund in the Paidy dashboard); Paidy unreachable or the close refused → the cancel is refused and nothing changes. The staff cancel PREVIEW no longer refuses on a Paidy lock (`terminate_web_order_atomic`, migration 20261114100000); the real cancel still does while any Paidy money is unresolved.
- **Expired:** an order with an open Paidy payment never expires (INVARIANT 12 freeze); when Paidy's own `expires_at` passes, the Hub rejects the submission (PD4) and Paidy can no longer capture it.
- **Reopen:** Paidy documents a closed payment as final (only refund / retrieve / status / update are valid after CLOSED). A reopened (revived) invoice is paid with a NEW Paidy checkout — never by reopening the old authorisation.


## Reassessment P04–P07 (owner answers 2026-10-08; migration 20261119100000)

- **P04 — closing the window never unlocks the order by itself.** `/orders/:id/paidy/abandon`
  only NOTES her close (`paidy_checkout_attempts.customer_closed_at`); the attempt stays
  `open` and `cash_order_payment_lock` keeps answering `paidy_checkout_open` (no longer
  keyed on `expires_at`). The ONE way an open window ends without a filing is
  `expire_paidy_checkout_attempts(p_cash_order_id)` (service_role): timed out AND no
  live authorisation / capture on the order AND no unprocessed Paidy notification
  received since it opened (other-environment ones excepted). The hourly sweep
  (:51) calls it for all orders; `start_paidy_checkout_attempt` calls it for the one
  order and then replaces the window she closed herself (`abandoned`), so she can
  open Paidy again at once while the other methods wait for the sweep. The
  storefront says so ("within about 90 minutes").
- **P05 — who Paidy is offered to.** `customers.family_name` + `given_name` (new);
  `buyer.name1 = family + given` as entered (`paidyBuyerName`), never guessed.
  `paidyNotOfferedReason` now also refuses `no_jp_billing_address` (her default
  address-book entry or customer record, complete JP incl. prefecture),
  `no_jp_mobile` (her own 070/080/090 number) and `no_buyer_name`. The order payload
  carries `paidy_requirements` {family_name, given_name, jp_mobile,
  jp_billing_address} so the storefront can ask for what is missing;
  `PUT /me/paidy-profile` writes the two names and the Japanese mobile (400 names
  the field). Hub: Edit Customer (dialog and detail page) has the two fields.
- **P06 — complete buyer history.** `paidyOffer` pages through ALL her completed yen
  cash orders and plans (`allRows`, 500/page, no cap); a read error withholds Paidy
  (`history_unavailable`) instead of sending Paidy incomplete figures.
- **P07 — environments.** The sweep reads only `paidy_payments.test = <this key's
  environment>`; an inbox event for the other environment is kept and retried
  daily (`other_environment`, `next_attempt_at` +24h) and dropped only after 30 days
  (`other_environment_expired`).

### P04 QA follow-up (2026-10-08, migration 20261121100000)

Browser QA after the P04–P07 release found the storefront contradicting
itself: while her own window was open (`paidy_checkout_open`) every button was
hidden and the headline said "being checked", yet the text promised she could
try Paidy again. Fixes, all within the owner default "she can reopen Paidy
right away":

- `website` GET /orders/:id answers `payment_state: "paidy_window_open"` when
  the ONLY lock is her own checkout window (`cash_order_payment_lock` with
  `p_ignore_attempts` = true is null) and offers Paidy again; transfer and
  card stay hidden until the sweep. A real Paidy payment in progress is still
  `paidy_processing` with nothing offered.
- `start_paidy_checkout_attempt` replaces ANY open window of hers on that
  order (end_reason `replaced`), not only one she reported closed — a lost
  tab no longer blocks her for up to 90 minutes. The lock carries over; the
  sweep still decides whether the old window took money.
- "Pay another way" lists Paidy when the only refusal is her own missing
  details (`no_buyer_name` / `no_jp_mobile` / `no_jp_billing_address`); the
  order page then collects them. `paidy_requirements` carries her current
  `mobile_number` so the form pre-fills it.
- Hub CashOrderDetail shows an amber "Paidy window open since …" line
  (staff SELECT on paidy_checkout_attempts) so refused Confirm / Submit /
  store-credit actions are explained; Customer Detail's Contact card shows
  the Paidy name.

## Reassessment PA01–PA15 (owner brief 2026-10-08 15:38 JST)

The 8 October QA/QC reassessment lists 15 Paidy findings (PA01–PA15) and 14
validation items (V01–V14). The owner-corrected brief, the four owner
decisions (PA08 no automatic replay + audited manual resend; PA10 never drop
unresolved recovery at 30 days; PA15 ask Paidy about Latin names and address
types; billing residence confirmed separately from shipping) and the build
order live in the Project doc `claude/paidy-pa01-pa15-brief-2026-10-08.md`.
Each finding is closed here, under its PA id, with its acceptance evidence.

### PA12 + PA13 — PR 1 (edge only; no SQL)

- **PA12 — a 2xx from Paidy is a payment only when it is complete.**
  `validatePaidyPaymentObject(json, expectedId)` (paidy-rules.ts) requires the
  REQUESTED payment id, a whole-yen amount, JPY, a boolean `test`, a status,
  and well-formed `captures` / `refunds` (a refund's `capture_id` must name a
  capture the payment has). `CLOSED` without a captures ARRAY is incomplete
  (CLOSED is both "released" and "captured"; only the array tells them
  apart). The client (paidy.ts `call`) runs it on every 2xx — and on a body
  that is not JSON — and throws `PaidyError(502, "paidy_bad_response")`.
  Every caller already treats a non-404 PaidyError as UNKNOWN (keep the row /
  event, read Paidy again), so the reproduced `200 { "status": "CLOSED" }` is
  now an unverified read, never an uncaptured state. An unfamiliar status
  value is NOT refused by the validator: it passes through and
  `paidyProviderOutcome` answers "unknown".
- **PA13 — staff Reject refuses an unknown read-back.** The Paidy pre-Reject
  branch in review-payment-submission now ends with an explicit `else` for
  any outcome that is not captured / authorized / expired / closed / rejected:
  HTTP 502 `paidy_unverified` (reason `paidy_unknown_outcome`), the submission
  stays queued and the order stays locked. Before, it fell through to the
  ordinary reject and unlocked the order with Paidy's position unknown.
- Tests: development/paidy-pa12-pa13.test.ts (CI list). Acceptance: malformed
  JSON, missing / mismatched id, wrong currency, bad types, invalid capture /
  refund linkage and incomplete CLOSED all produce an unknown outcome — no
  false rejection, no false release, no invented completion.

### PA01 + PA02 + PA03 — PR 2 (migration 20261123100000 + paidy-sync + paidy-reconcile)

Owner decision 2026-10-08 16:16 JST — **Paidy at cancel = REFUSE**, like
Square's R05. Company policy is no cash refund: a cancelled Paidy-paid order
gets store credit under the 100 % / 70 % rule and the customer's Paidy bill is
untouched (Paidy never refunds on its own). A refund pressed in the Paidy
dashboard is therefore an exception made deliberately.

- **PA02 — no double compensation.** Both cancel RPCs read `paidy_refunds`:
  any verified row → "store credit issued" is refused
  (`paidy_already_refunded`; cancel_cash_order_atomic raises it, the web RPC
  returns it as a reason) and staff finish by hand (refund pending → Mark
  refund issued). The Square R05 checks are untouched beside it.
  `record_paidy_refund(refund_id, payment_row, amount, capture_id, at,
  payload)` (service role) is now the ONLY writer of `paidy_refunds`: it locks
  the ORDER first (the cancel RPCs hold the same lock, so a refund and a
  cancel serialise and a cancel that lands first sees the refund), then the
  payment; inserts idempotently by refund id; refuses `not_captured`,
  `capture_mismatch`, `refund_exceeds_capture`; raises `refund_jpy`
  monotonically; and rings **`paidy_refund_after_credit`** once per refund
  when the order already holds a `cancelled_cash` lot — the reconciliation
  path for a dashboard refund made AFTER credit (a human voids the lot;
  Settings → Store Credit). `paidy-sync` calls it after the capture status is
  written and only when the read-back passed the PA12 validator for that id
  AND its `test` flag matches the row's (otherwise nothing is recorded and
  the pass is flagged `refund_unverified`).
- **PA03 — truthful "refund issued" for Paidy.**
  `mark_web_order_refund_issued_atomic` method `paidy` needs Paidy money on
  the order (`method_mismatch` / `not_paid_by_paidy`) and at least one
  verified refund (`no_verified_paidy_refund`); the amount recorded is
  `LEAST(paidy money, verified total)` and the audit row carries
  `paidy_refunded_total_jpy` + `paidy_remaining_jpy` — never the gross. A
  non-Paidy method on a mixed order records only the non-Paidy money.
  `terminate_web_order_atomic` refuses `refund_issued` on a Paidy-paid order
  while verified refunds do not cover the Paidy money
  (`paidy_refund_needs_dashboard`) — the twin of `card_refund_needs_square`.
  Preview carries `paid_by_paidy`, `paidy_paid_jpy`, `paidy_refunded_jpy`.
  Staff copy: `_shared/terminate-refusals.ts`, `MarkRefundIssuedDialog`.
- **PA01 — an orphan capture is never released by a note.** A capture case
  with no payment row (`paidy_payment_row IS NULL`, kind captured_unrecorded /
  captured_no_submission / record_failed) is the order's only lock
  (`cash_order_payment_lock` → paidy_captured_unrecorded).
  `resolve_paidy_case` now refuses `no_action`, `handled_in_paidy`,
  `released`, `refunded_in_paidy` and `end_submission` on it
  (`orphan_capture_unsettled`); it closes through `record_capture` once a
  payment row exists, or by the sweep: `paidy-reconcile` step 4b re-reads
  every open orphan case's payment from Paidy each run (this environment's
  key only; the other environment's run owns the rest) and calls
  `resolve_orphan_paidy_case_verified` (service role) ONLY when Paidy reports
  the capture fully refunded; anything else keeps the case — and the lock —
  and refreshes `last_seen_at` / `attempts`. Report fields
  `orphan_cases_checked` / `orphan_cases_resolved`.
- Tests: development/paidy-sync.test.ts (R06 reordered + PA02 bell + PA02
  env mismatch), development/paidy-pa01-pa03.test.ts (wiring + migration
  guards), both in the CI list. The SQL bodies run only on Postgres: the
  migration self-checks every patched function and STOPS on any mismatch.

### PA05 + PA09 + PA04 + PA10 — PR 3, recovery (migration 20261125100000 + record-only 20261126100000; owner go 2026-10-08 17:39 JST)

Plan and investigation: claude/paidy-pr3-recovery-plan-2026-10-08.md (project).
Owner decisions applied: an unverified window still ends after 30 min (honestly
named); parked notifications shown as a count on the Paidy cases panel; the
window notice wording (storefront) says what the Hub does — "our next hourly
check finds no Paidy payment on this order" — never "confirmed with Paidy".

- **PA05 — a release is what Paidy says it is.** `releasePaidyAuthorization`
  returns `released | captured | pending | unknown` classified from Paidy's
  answer to the close (re-read on a refused call): only closed / rejected /
  expired ends the row; a capture found at release is written captured and
  opens the locking capture case (never closed); AUTHORIZED-after-close or an
  unreadable answer opens `close_failed`. Callers say `release_<outcome>_…`
  instead of `released_…` when the close was not confirmed. The sweep (step 3b)
  retries every `close_failed` case WITHOUT a payment row — an unfiled payment
  the Hub tried to release — from Paidy's read-back and resolves it only when
  Paidy confirms (`orphan_releases_retried` / `_resolved`).
- **PA09 — inbox bookkeeping is honest.** `claim_paidy_webhook_event` (5-minute
  lease, compare-and-set) is passed by the webhook and the sweep before any
  work; every inbox write is retried once and counted (`writes_failed` →
  `inbox_write_errors`, the webhook answers 500 so Paidy retries); duplicates
  in a run are completed only after the first event for that payment is done.
- **PA04 — window expiry.** The guard in `expire_paidy_checkout_attempts` is
  ORDER-CORRELATED (an unprocessed, unparked event naming this order, or one
  not yet classified); a window that knows its Paidy payment id (the
  storefront's rejected/closed callback now hands it over —
  `note_paidy_checkout_attempt_payment`) is verified with Paidy by the sweep
  first (`verified_empty_at`; an authorisation found is adopted, a capture
  opens its case); the result is named on the attempt (`verification` =
  verified_empty | unverified_no_id). The launch metadata carries
  `attempt_id`. A window with no id ends on time alone, bounded by adoption.
- **PA10 — environment and age.** Inbox events are classified
  (`cash_order_id`, `test`) and the sweep reads only this environment's working
  batch; events this key cannot answer are PARKED (`parked_reason`
  other_environment | unknown_to_this_key), retried daily and NEVER dropped
  (owner); an unknown id is closed only after BOTH keys answered 404
  (`tried_test` / `tried_live`). `paidy_unrecorded_captures` feeds the sweep
  every unrecorded, not-fully-refunded capture whatever its age (captured_at
  NULL included); recorded captures keep the 400-day refund window.
- Report fields added: events_parked, inbox_write_errors,
  orphan_releases_retried/_resolved, windows_verified, windows_recovered,
  parked_events, parked_oldest_minutes.
- Tests: development/paidy-pr3-recovery.test.ts (release classification with
  a stubbed Paidy, parking + both-keys closure, counted write failures, source
  and migration guards) + the updated development/paidy-p04-p07.test.ts; in
  the CI list.
