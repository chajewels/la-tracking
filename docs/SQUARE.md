# Square card payments on a confirmed web order (S1, 2026-10-04)

Owner plan v2 approved 2026-10-04 00:03 JST (project doc
`claude/square-build-plan-v2-2026-10-03.md`). Square is **Paidy's twin with a
card form instead of a Paidy popup**: every rule Paidy follows (universal
submission, INVARIANT 12 freeze, capture only on reviewer Confirm, fail-closed
mode, secrets only in Lovable, id-family guard, no money computed on the site)
carries over unchanged. Reference: developer.squareup.com (Web Payments SDK,
Payments API `autocomplete:false`, Webhooks). API version 2026-09-16.

## Decisions on file
| # | Decision |
|---|---|
| D0 | Absorb the Square fee at launch, no price factor (same as Paidy's 3.50 %). |
| D4 | Yen-settled cash orders only (Square JP charges yen); peso-settled → transfer. Any country. |
| D5 | Offered after staff Confirm, from the ready email / order page. |
| D6 | Authorise on pay → capture on Confirm → void on Reject. |
| D7 | 3-D Secure always: the storefront always calls `card.tokenize(verificationDetails)`, Square's current flow, which runs the buyer verification INSIDE the card token. A separate `verification_token` (the deprecated `verifyBuyer()` flow) is optional and forwarded when present (owner decision B, 2026-10-04); `three_ds_status` records which path: `VERIFICATION_TOKEN_PRESENTED` or `VERIFIED_IN_CARD_TOKEN`. `verification_required` is no longer answered. |
| **D9** | **Every card payment** needs BOTH the recorded terms tick AND an e-signed **Card Purchase Agreement** ("the document we need fighting disputes"). `card_agreement_min_jpy` exists for later loosening, seeded 0 = all. Reuses the layaway signing flow, keyed by order id. |
| D10 | `dispute.created` webhook → bell `card_dispute_opened` + evidence fields on `square_payments`. |
| D11 | `square_mode` off/test/on (fail-closed) + PUBLIC `square_app_id` / `square_location_id` in Hub settings via `set_square_settings`; `SQUARE_ACCESS_TOKEN` + `SQUARE_WEBHOOK_SIGNATURE_KEY` Lovable secrets only; the website reads the public ids from the Hub (no Vercel env). |
| D12 | Footer card marks ship in the storefront PR (S3), from Square's official logo kit. |
| Q1 (2026-10-04 01:07) | ONE bilingual EN + JA Card Purchase Agreement, one signature, keyed by order id (`doc=card&order=<id>`). A NEW document — only the layaway signing MECHANISM is reused. |
| Q2 | `delay_action: CANCEL` — Square drops an unconfirmed hold at the end of its 7-day window; the submission auto-rejects (Paidy PD4 pattern); bell `card_hold_expiring` from day 5. |
| Q3 | Cards only at launch; Apple Pay / Google Pay a follow-up PR after go-live. |
| Q4 | The owner pastes the current Apps Script; Claude Code returns the full updated script. |
| — | Never on layaway (owner rule). Points redemption / discount codes are separate backlog items. |

## Build steps
- **S1 Hub (this PR):** migration `20261101100000_square_payments.sql`, Hub
  UI (Website → Settings → Card payments (Square); Payment Submissions and
  Cash Order Detail card handling), `square-settings.ts` + vitest, this doc.
  Release → Lovable SQL-ONLY apply.
- **S2 Edge (DEPLOY-ONLY after the sandbox secrets are in Lovable):**
  `_shared/square.ts` (fetch client, no package), `_shared/card-rules.ts`
  (+ vitest, never imports Deno), `website` route `POST /orders/:id/card` and
  card fields on `GET /me/orders/:id`, the capture/void branch in
  `review-payment-submission`, `square-webhook`.
- **S4 Card Purchase Agreement (critical path):** document text EN + JA for
  owner approval; Apps Script doc type `card` keyed by order id answering
  `{ok, signed, version, signedAt}`; storefront gate (`agreement_required` /
  `agreement_unverified`, fail-closed, exactly like layaway); the Hub stores
  `agreement_version` / `agreement_signed_at` on `square_payments`.
- **S3 Storefront:** `hub.cardPayment`, `/account/orders/[id]/pay-card`
  (Web Payments SDK, 3DS, terms tick), order-page button + lede EN/JA, FAQ
  "Can I pay by card?" (Hub data), privacy processor line, footer marks.
- **Sandbox test** with Test Customer CJ-2026-05088 in test mode, then
  **go-live**: production token + signature key (Lovable), production ids +
  mode On (Hub), one real small payment by the owner refunded in the Dashboard.

## Flow (S2 as built 2026-10-04; S3/S4 add the storefront and the agreement)
1. Staff Confirm the draft → the real order exists (`cash_orders`, yen,
   `payment_status = 'pending_transfer'`).
2. `GET /orders/:id` returns `card: { offered, app_id, location_id, test,
   amount_jpy, agreement_required, agreement_min_jpy }` when
   `cardNotOfferedReason()` is null (`_shared/card-rules.ts`, pure, vitest):
   `square_mode` on (or test + `customers.is_test`), an app id of the mode's
   family (`squareAppIdFamily`), a location id, JPY, order `pending` /
   `pending_transfer`, `ready_confirmed_at` set, `remaining_balance > 0`, no
   `submitted | under_review` submission. No address rule (D4). Amount = the
   Hub's remaining balance, shown and sent as-is; the site computes nothing.
3. Agreement first (S4): the pay-card page refuses until the Apps Script lookup
   answers `signed: true` for `doc=card&order=<id>`.
4. The customer tokenises the card (3DS) → `POST /orders/:id/card
   { source_id, verification_token?, terms: {accepted_at, version, ip?,
   user_agent?}, agreement: {version, signed_at} | null }`. The Hub re-checks
   the rule (D7: `verification_token` is optional — the current SDK verifies
   inside the card token, owner B 2026-10-04), refuses `terms_required`
   (accepted_at AND version) / `agreement_missing` (D9), applies the 3-per-24h submission cap
   AND the 5-per-24h card-attempt cap (`square_attempts`, declines included —
   429 `too_many_attempts`), then calls **CreatePayment `autocomplete:false`,
   `delay_action: CANCEL`** (`_shared/square.ts`; idempotency key =
   `cardIdempotencyKey(order id, card token)` — one per card NONCE, so a
   retried click dedupes to the same hold and a corrected card gets a fresh
   key; `reference_id` = invoice, `note` = customer reference,
   `statement_description_identifier` "CHA JEWELS"; host sandbox/production
   from the mode). The answer must be APPROVED, JPY, amount = remaining
   balance, else CancelPayment + 409 `card_mismatch`; a card refusal
   (`SquareError.isCardRefusal`) is 402 `card_declined` with Square's code.
   Then one `square_payments` row (`authorized`, brand, last4,
   `three_ds_status` VERIFICATION_TOKEN_PRESENTED | VERIFIED_IN_CARD_TOKEN, receipt URL, terms +
   agreement evidence incl. IP / UA as reported by the storefront's server
   action, `capture_by` = Square's `delayed_until` or +7 days) and one `payment_submissions` row
   (`payment_method 'square'`, `reference_number` = the Square payment id,
   `proof_url null`, `square_payment_id` = the row uuid), audit
   `submission_created` (path `website_card`), bell `card_authorized`.
   INVARIANT 12 freezes the deadline.
5. Reviewer **Confirm** (review-payment-submission, cash branch, step 2e —
   the twin of Paidy's 2d): after the atomic claim and before `cash_payments`
   → **CompletePayment**. Success (COMPLETED) → `captured`; the cash payment
   is written as today. `captured` already → carry on (retried Confirm). Hold
   amount ≠ the submission's amount → claim reverted, 409 `square_amount_mismatch`.
   Square now rating the payment HIGH risk → claim reverted, 409 `risk_high`,
   nothing captured (HUB-3, 2026-10-05).
   The hold is never judged by the clock: Square is READ first. Square showing
   it CANCELED / FAILED → the submission REJECTED with the note, audit reason
   `card_hold_closed`, 409 `card_hold_closed` (nothing was charged; she can pay
   again). Any failure to read or capture → nothing recorded, 502
   `card_unverified` (+ bell `card_capture_unverified` when a capture may have
   happened; "Finish recording" re-reads Square and never charges twice).
6. Reviewer **Reject** → Square read first; APPROVED → **CancelPayment** (void,
   no fee) → `voided`. COMPLETED → 409 `card_already_captured` (press Confirm).
   PENDING → 409 `card_pending`, nothing rejected, no bell — Square is still
   processing, try again in a few minutes (HUB-6). Any other status that is not
   CANCELED / FAILED after the void → bell `card_void_failed`, 502, the
   submission is NOT rejected (the hold may still be on the card).
7. `square-webhook` (public, SIGNED): base64(HMAC-SHA256(key, registered
   notification URL + raw body)) against `x-square-hmacsha256-signature`,
   timing-safe (`verifySquareSignature`, deno test
   `development/square-signature.test.ts`); 401 otherwise. Every event id lands
   in `square_webhook_events` once (duplicate → 200 `duplicate`); the body is
   never trusted — the payment is re-read from Square. COMPLETED → `captured`,
   FAILED → `failed`, CANCELED → `expired` (past the window) or `voided`; a
   settled row is never downgraded; a live submission on a hold that closed
   externally is rejected with the note + audit `card_closed_externally` + bell.
   `dispute.*` → `disputed_at` / `dispute_id` + bell `card_dispute_opened`
   (D10); `refund.*` → `refund_jpy` + bell `card_refunded`.
8. Hourly (square-reconcile → `ring_square_deadline_bells`): a hold still
   `authorized` rings `card_hold_expiring` once (`warned_at`) 2 days before
   Square's own deadline `capture_by` (= `delayed_until`); when Square sent no
   `delayed_until`, `authorized_at` + 7 days, and the bell says "about" (HUB-7).
   Nothing else is touched (INVARIANT 12).
9. Refunds phase 1: Square Dashboard; the Hub records `refund_status` as today.

## S1 schema (migration 20261101100000)
- `square_payments` — one row per Square payment: `cash_order_id`,
  `customer_id`, `square_payment_id` UNIQUE, `status` authorized | captured |
  voided | rejected | expired | failed, `test`, `amount_jpy`, `card_brand`,
  `card_last4`, `three_ds_status`, `receipt_url`, terms evidence
  (`terms_accepted_at/version/ip/user_agent`), `agreement_version` /
  `agreement_signed_at`, `authorized_at`, `capture_by`, `captured_at`,
  `voided_at` / `voided_reason`, `refund_jpy`, `disputed_at` / `dispute_id`,
  `last_webhook_at`, `last_payload`. RLS: staff select; service_role writes.
- `payment_submissions.square_payment_id` + partial unique index
  `uq_payment_submissions_square_live` (one live submission per hold).
- `square_webhook_events` (`event_id` PK, event_type, payment_id, outcome,
  error, payload) — idempotency log.
- `square_payments.warned_at` (S2, 20261101110000) — the hold-expiry bell stamp.
- `square_attempts` (S2, same migration) — one row per CreatePayment attempt
  (authorized | declined | refused | mismatch | error); the card-attempt cap's
  evidence, never money state. The `rejected` value of `square_payments.status`
  is reserved and not written today (a decline creates no row).
- Settings: `square_mode` "off", `square_app_id` "", `square_location_id` "",
  `card_agreement_min_jpy` 0. `guard_square_settings()` /
  `trg_guard_square_settings` refuse any write without GUC
  `app.allow_square_settings_change`; `square_mode()` reads fail-closed;
  `get_square_settings()` (mode, ids, threshold, last change, `can_change`,
  `authorized_now`, `captured_30d`, `disputes_open`); `set_square_settings(
  p_mode, p_app_id, p_location_id, p_agreement_min_jpy, p_expected_mode)` —
  admin only, audited (`audit_logs` action `set_square_settings`), refusals
  `invalid_app_id` (an access token `EAAA…` / `sq0atp` / `sq0csp` is refused;
  only `sandbox-sq0idb-…` / `sq0idp-…`), `invalid_location_id`,
  `invalid_agreement_min`, `sandbox_app_id_required` (test),
  `production_app_id_required` + `location_id_required` (on), `stale`.

## Rules (one line each in CLAUDE.md)
- `SQUARE_ACCESS_TOKEN` and `SQUARE_WEBHOOK_SIGNATURE_KEY` are edge-function
  secrets only — never the database, the repo, chat or a Lovable prompt body.
- `square_mode`, the public ids and the agreement threshold change ONLY through
  `set_square_settings` (admin, audited, guard trigger); never in a migration
  or SQL. The id family must match the mode (test ↔ sandbox-sq0idb-, on ↔ sq0idp-).
- A `square` submission is, like `paidy`, an exception to PROOF REQUIRED: the
  proof is the authorisation the Hub read back from Square.
- Capture ONLY in review-payment-submission on Confirm; void on Reject;
  nothing in SQL, nothing from the storefront, nothing from the webhook.
- Every card payment needs the signed Card Purchase Agreement (D9); the
  storefront gate fails closed with two codes, exactly like layaway.
- Yen cash orders only, any country; never layaway; fee absorbed (D0).

## Hub UI (S1)
- Website → Settings → **Card payments (Square)** (admin only,
  `WEBSITE_SETTINGS_SECTIONS.square`): mode radio with confirm dialog,
  Application ID + Location ID ("Save ids"), agreement threshold ("Save
  threshold"), counters (awaiting Confirm / captured 30 d / disputes open).
- Payment Submissions: a `square` submission shows the "Card" pill, satisfies
  the proof gate, and the Confirm / Reject dialogs say capture / void.
- Cash Order Detail: the pending-transfer banner names a card hold awaiting
  Confirm.

## Edge functions (S2, 2026-10-04)
| File | Role |
|---|---|
| `_shared/card-rules.ts` | PURE rules (no Deno, no imports): `squareModeFrom`, `squareAppIdFamily`, `cardNotOfferedReason`, `CARD_HOLD_DAYS` 7 / `CARD_HOLD_WARN_DAYS` 5, `cardHoldExpired`, `cardHoldWarnDue`, `cardAmountMatches`, `isSquarePaymentId`, `normalizeSquareStatus`, `agreementRequired`. vitest `src/test/card-rules.test.ts` (CI). |
| `_shared/square.ts` | The only file that talks to Square (fetch, `Square-Version` 2026-09-16; SQUARE_ACCESS_TOKEN read only here): `square.create` (authorise), `get`, `complete`, `cancel`; `SquareError` (+ `isCardRefusal`); `verifySquareSignature` / `hmacSha256Base64` (SQUARE_WEBHOOK_SIGNATURE_KEY). Sandbox vs production host is passed by the caller from `square_mode`, never guessed from the token. |
| `website/index.ts` | `cardOffer()`; `GET /orders/:id` → `card`; `POST /orders/:id/card`. |
| `review-payment-submission/index.ts` | `isSquareSubmission` (proof exception); step 2e capture; Reject void. |
| `square-webhook/index.ts` | `verify_jwt = false` in config.toml; signed; idempotent; re-reads. |
| `auto-expire-cash-orders/index.ts` | the `card_hold_expiring` pass. |

Deploy (Lovable DEPLOY-ONLY after the two secrets exist): `website`, `review-payment-submission`, `square-webhook`, `auto-expire-cash-orders`; SQL-ONLY first for 20261101110000.

## Owner inputs before S2 deploy
1. Square Dashboard: location = Cha Jewels / Japan / JPY; Visa, Mastercard,
   Amex, JCB, Diners, Discover enabled for online; statement descriptor
   "CHA JEWELS"; dispute notification email.
2. Square Developer: Sandbox **Application ID** + **Location ID** (public,
   pasted in chat → Hub settings); sandbox **access token** → Lovable secret
   `SQUARE_ACCESS_TOKEN` only.
3. Webhook subscription to
   `https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/square-webhook` for
   `payment.created`, `payment.updated`, `refund.created`, `refund.updated`,
   `dispute.created`, `dispute.state.updated` (all six, in BOTH the sandbox and
   the production app — `payment.created` makes a hold whose create answer was
   lost visible at once, not only when Square cancels it ~7 days later) →
   its **signature key** → Lovable secret `SQUARE_WEBHOOK_SIGNATURE_KEY`
   (production: `SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY`) only.

## Integrity (2026-10-04, review SQ01–SQ23 — docs/SQUARE-INTEGRITY.md)

Migration 20261104100000_square_integrity.sql; `_shared/square-sync.ts`; new `square-reconcile`.

- **Attempt first.** Every CreatePayment has a `square_card_attempts` row reserved under the order lock
  BEFORE Square is called (`reserve_square_attempt`): exact integer yen = remaining balance, one
  unresolved commitment per order, caps 5 failures per order / 10 declines per customer (24 h). Square
  sees the attempt's immutable request (amount, location, idempotency key, `reference_id` = `cja_…`).
  A retried token replays the same request (same key → no second hold). An ambiguous failure leaves the
  attempt `unknown` and the customer is told it is being confirmed — never "not charged".
- **One gate.** `square_order_unresolved(order)` = an attempt reserved/unknown/cancelling, a live hold,
  or captured card money not yet recorded. It is part of the Paidy follow-up's ONE answer:
  `cash_order_payment_lock(order)` returns `card_payment_unresolved` (after the `paidy_*` reasons, before
  `submission_pending`). While it does: no other card attempt, no Paidy (start / filing refuse), no
  transfer or staff submission (`guard_provider_submission` trigger, any route; website,
  submit-cash-payment, customer portal hide/refuse it), no expiry, no cancel (terminate_web_order_atomic →
  `card_payment_unresolved`, staff included). After a verified decline/void it opens again (owner 3A).
  Direct `cash_payments` writes are covered too (20261106110000): `trg_guard_cash_payment_paidy` refuses
  store credit, a loyalty-points discount, an un-void or a relabel while the lock is
  `card_payment_unresolved`; only Square's own recording (a row inserted as `square` by
  `finalize_cash_submission_atomic`) passes. The Hub order page then shows "Open in Payments" instead of
  Submit Payment / Confirm transfer received / Cancel Order (Cancel stays for a Paidy hold).
  The reverse holds too: while the lock says `paidy_*`, `reserve_square_attempt` refuses
  (`paidy_in_progress`), and a hold that arrives after Paidy took the order is filed as an exception and
  voided at once (nothing charged).
- **Filing** (`file_square_authorization_atomic`): hold + submission + audit + `card_authorized` bell in
  one transaction, idempotent on the Square payment id. A hold the order cannot take is recorded with an
  exception and no submission (`unfiled_hold` bell; never auto-voided). Amount/location/currency
  mismatch → exception + void. Risk HIGH → void + fraud cancel.
- **Provider truth** (`apply_square_payment_state`): COMPLETED is captured even after a local close
  (exception `captured_after_close`); captured never downgrades; APPROVED after a local close →
  `void_unconfirmed`; CANCELED/FAILED of a live hold → voided/expired/failed and a waiting submission
  rejected. Older observations (Square `updated_at`) are ignored. Bells are written in the same
  transaction (durable outbox).
- **Confirm** reads Square before and after CompletePayment (with `version_token`), claims the hold
  (`claim_square_action` 'capture' — a Reject cannot void it meanwhile), resumes with "Finish recording"
  after a 5-minute lease, records via `finalize_cash_submission_atomic` (Square guard: captured, same
  order + customer, JPY, exact captured yen, not already allocated; binds `cash_payment_id`). date_paid
  = capture day in Japan time. **Reject** claims 'void', reads Square first, voids, and rejects only
  when Square shows CANCELED/FAILED; a COMPLETED payment is never rejected.
- **Provider-linked submissions are locked** (`guard_provider_submission`): method, amount, order,
  customer and link cannot change; a card submission cannot be cancelled (only Reject); nothing becomes
  `square` without its hold. Customers cannot edit/cancel card or Paidy submissions.
- **Webhook = durable inbox**: stored, claimed with a lease, processed through square-sync, finished as
  done / ignored / quarantined / failed (retry with backoff; dead after 12 → bell). Failed answers 500
  so Square redelivers; square-reconcile retries hourly.
- **Customer emails (addendum §9, 2026-10-06)**: a new hold filing (`fileForAttempt`, outcome
  `filed`) sends 「お支払いを受け付けました」 with 「仮売上（まだ請求されていません）」, brand •last4 and the hold
  end; a refund that reaches `COMPLETED` sends 「返金を受け付けました」 once per refund id; a fraud
  cancel sends the order-cancelled email with the neutral reason 「お支払いを確認できなかったため」 (never
  "fraud"); a hold the Hub voids with no submission (amount mismatch, Paidy took the order, risk HIGH
  not cancelled) sends order-payment-not-accepted (card, provider_ended). Dispute and hold-expiring
  stay staff-bell only.
- **Refunds and disputes**: one row each (`square_refunds`, `square_disputes`), lifecycle + staff
  decision (`decide_square_case`); refunds never change order accounting (owner 2A); dispute evidence in
  the Square Dashboard, reminders 3 d / 1 d before `due_at`. Subscribe `dispute.state.updated`.
- **Fraud (owner 2026-10-04)**: 5 declines on the order or 10 across the customer's orders in 24 h, or
  Square risk HIGH → void any hold, then `square_fraud_cancel` cancels the invoice (source system, stock
  back); refused (bell) when card money is unresolved or other money was received. Revive with
  `revive_web_cash_order_atomic`.
- **Secrets per environment**: sandbox `SQUARE_SANDBOX_ACCESS_TOKEN` → `SQUARE_ACCESS_TOKEN`; production
  `SQUARE_PRODUCTION_ACCESS_TOKEN` → `SQUARE_ACCESS_TOKEN`; webhook keys
  `SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY` and `SQUARE_WEBHOOK_SIGNATURE_KEY` both tried. Every row
  carries its environment, so old sandbox holds stay readable after go-live.
- **3DS evidence** is `sdk_tokenize_with_verification` / `verification_token_supplied` / `unknown` —
  never "verified". **Billing** is the cardholder's (name field + "same as delivery"), never a gift
  recipient. **Agreement** must bind this customer and amount (Card.gs v3 signed link); a changed amount
  means signing again.
- **Operator panel + settlement report**: Website → Settings → Card payments (Square), under the
  settings card (`SquareOperationsPanel`): active holds, open attempts, captured-unrecorded/exceptions
  (Resolve), refunds, disputes, webhook problems, settlement by Japan day (gross, Square fees, refunds,
  lost disputes, net; CSV). Bank payouts stay in the Square Dashboard.

## Checkout payment choice + points (2026-10-05)

See docs/CHECKOUT-CHOICE.md: the method is chosen at checkout and locked for the customer (staff change it with change-payment-method); points used at checkout are a LOYALTY- discount approved at staff Confirm, never "money paid".

## QC fixes (2026-10-05, independent close-out review QC01–QC15)

Migration `20261108100000_square_closeout_qc.sql` (md5-guarded, every replaced body starts from live) and
the edge functions square-webhook, square-reconcile, review-payment-submission, website (shared Square
modules), void-cash-payment, restore-cash-payment. Plan: project doc
`claude/square-closeout-qc-plan-2026-10-05.md`.

- **Refunded money is never credited in full (QC01).** `finalize_cash_submission_atomic` refuses
  `square_refunded` when Square reports a completed or pending refund on the capture
  (`square_refunds` not FAILED/REJECTED, or `refund_jpy`) and flags `refunded_before_record`;
  `record_square_refund` flags it too. The Confirm path reads the payment's refunds before recording.
  The only way to record the net is the admin/finance decision **record_net_after_refund** (completed
  partial refund, none pending): a `card_net_after_refund` submission for exactly captured − completed.
- **A decision is not a resolution (QC02).** `decide_square_case` stores `exception_decision` and
  releases the order only on evidence: the capture recorded on the ledger (`record_on_order` /
  `record_net_after_refund` hand it to the normal Confirm path — the panel calls
  review-payment-submission, which reads Square and the finalizer records it), a completed full
  refund (`refunded_in_square`), or Square showing the hold closed (`voided_in_square`). **Note only**
  (`other`) resolves nothing. Refund and dispute decisions must match Square's state
  (`state_mismatch`).
- **Provider receipts are bound and immutable (QC03/QC04/QC12).** `guard_cash_payment_paidy` now
  covers INSERT, UPDATE and DELETE: a `square` / `paidy` row (or any `provider_capture_id`) is inserted
  only with matching captured provider evidence (same order, exact yen, JPY, not refunded, not yet
  recorded); a card receipt carries its Square payment id in `provider_capture_id` (unique — backfilled
  for existing rows). Once written, a provider receipt cannot be voided, restored, changed or deleted
  (`provider_payment_immutable`): money back is a refund in the provider's dashboard, recorded beside
  the receipt. Ordinary money — and now an amount / currency change on a live row — is refused while
  Paidy or a card holds the order. `trg_guard_cash_order_amount_during_hold` freezes the order total,
  discount, shipping and currency during a hold (Reject, then change the order).
- **Ordered observations (QC10).** `record_square_refund` / `record_square_dispute` take a per-case
  advisory lock (first insert included) and the upsert refuses older observations; terminal states
  never revert.
- **Recovery (QC05–QC09, QC11).** A refund / dispute whose payment the Hub does not know yet recovers
  the parent first and is quarantined (retried), never ignored, until its ancestry is known; a payment
  Square cannot show is quarantined. The attempt search answers found / absent / incomplete — an
  incomplete search never cancels by key. The webhook answers 200 once the event is stored and processes
  it in the background (`EdgeRuntime.waitUntil`). square-reconcile walks the Events API and ListRefunds
  from durable checkpoints (`square_sync_state`, every page, resumable), lists disputes, refreshes every
  non-terminal refund whatever its capture age, orders holds fairly (`reconciled_at`), and ends
  ok | degraded | failed (`reconcile_last_run` / `reconcile_last_ok`; bell at most every 6 h).
  `square_ops_health()` feeds the panel's health strip ("Checks not running" after 3 h without a good run).
- **Accuracy (QC13–QC15).** The report is **Card activity (estimated)** with `fees_missing`; it is not
  bank money. The Square HTTP deadline covers the body read. "Square risk HIGH" no longer claims the hold
  was voided — the panel shows Square's state on its own line.

- **Independent review of the fix (same day).** A provider receipt is written only inside the
  finalizer's own marker (`app.provider_recording` = the capture id, set and cleared around the INSERT),
  so no other SQL path can mint one even with matching evidence. `decide_square_case` takes its locks in
  the finalizer's order (submission → order → card row) — a decision racing a Finish no longer
  deadlocks — and reuses a claimed submission only when it is exactly the capture. Net-after-refund
  confirms through review-payment-submission (refunds synced first; anything but a clean sync is
  "unverified", never recorded). The reconcile walker uses one clock per run, drops a cursor Square
  refuses and re-reads the window, scans disputes on a rolling cursor, touches every hold it looks at,
  and labels an Events API that is not enabled "not enabled" rather than an alarm. A saved decision on
  a case that stays open says so ("Decision saved — case still open").
- **Second review pass (same day).** One lock order for every writer on a card payment — the
  submission, then the order, then the card row: `apply_square_payment_state` (webhook / reconcile)
  now takes the submission lock first, so a state change can no longer deadlock with a Finish or a
  decision (reproduced on the old body, gone now). A decision never replaces or rejects a Confirm
  still inside its 5-minute lease (`confirm_in_progress`; the decision itself is saved). The hourly
  refund check on recent captures goes round-robin by `reconciled_at`, so every capture is reached.
  An Events API client error counts as "not enabled" only before the API has ever answered for that
  environment; after a successful read the same error alarms. `rpc('set_config')` is not callable on
  live (no `public.set_config`), so the recording marker cannot be set by a client.
- **Known limits (owner decisions, not code).** A receipt recorded on the wrong order is corrected by
  a refund in Square plus a new payment on the right order — never by editing the receipt. Test orders
  that hold a provider receipt cannot be deleted. Finance "Collected" stays gross of a card refund made
  after the payment was recorded; the refund is on the card row and in the Card activity report.

Tests: 74 SQL acceptance checks (`development/sql/square-closeout-qc-acceptance.sql`) on a Postgres
copy of the live schema; the QC10 two-session race (`square-closeout-qc-race.sh`, reproduced on the old
body, ends COMPLETED on the new) and two deadlock races (`square-closeout-qc-deadlock.sh`: decide vs Finish, and a
state change vs a Finish — each reproduced on the earlier body, none now); `development/square-closeout-qc.test.ts` (17) +
`square-integrity.test.ts` (14); `src/test/square-ops.test.ts` (27).

## Docs-gap fixes (2026-10-05, HUB-1..HUB-9)

Review of the integration against developer.squareup.com (Project doc
`claude/square-docs-gap-review-2026-10-05.md`). Migration
`20261110100000_square_docs_gap.sql`; acceptance `development/sql/square-docs-gap-acceptance.sql`
(15 passed; 5 before the migration); deno `development/square-integrity.test.ts` (HUB-1, HUB-4).

- **HUB-1** `_shared/square.ts` `call()`: a money-moving write (CreatePayment, Complete, Cancel,
  CancelByIdempotencyKey) whose earlier try may have reached Square (network, timeout, 5xx, 429) and
  whose same-key retry then got a 4xx is AMBIGUOUS (`ambiguous_then_<code>`): the card route leaves the
  attempt `unknown` (202) and it is resolved by reading Square — never closed as `failed` while a hold
  may exist. A first-try 4xx and every read are unchanged.
- **HUB-2** DisputeState `INQUIRY_CLOSED` ("the inquiry is complete") counts as closed in
  `square_ops_health`, `decide_square_case`, the due-date index, the evidence bells and the Hub panel
  (`DISPUTE_CLOSED_STATES`). `record_square_dispute` does NOT treat it as terminal and square-reconcile
  keeps re-reading it: Square's docs do not say whether a closed inquiry can be escalated on the same
  dispute id, so a later open state is still recorded.
- **HUB-3** risk rising to HIGH after filing → bell `card_risk_high` once (no exception, so
  square-reconcile does NOT void the hold by itself); Confirm refuses 409 `risk_high`; the reviewer
  Rejects (void). The order is not fraud-cancelled on this path. Whether such a hold should be voided
  automatically within the hour is an OPEN OWNER DECISION (today only filing-time HIGH is automatic).
- **HUB-4** CreatePayment sends `buyer_email_address` (the Hub customer's email, plain address only).
- **HUB-5** a decline answered as a FAILED payment with HTTP 200 counts toward the fraud rule.
- **HUB-6** Reject on a PENDING payment → 409 `card_pending`, no `card_void_failed` bell.
- **HUB-7** no `capture_by` → `authorized_at` + 7 days in SQL (expired vs voided; the hold warning),
  matching `card-rules.ts` `cardHoldDeadline`.
- **HUB-8** evidence reminders only for `EVIDENCE_REQUIRED` / `INQUIRY_EVIDENCE_REQUIRED` and not after
  staff recorded `evidence_submitted`.
- **HUB-9** this file (steps 5, 6, 8, webhook list); the live `square-reconcile` cron recorded in the
  migration (created only when missing).

