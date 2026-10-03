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
| D7 | 3-D Secure always (`card.tokenize(verificationDetails)`). |
| **D9** | **Every card payment** needs BOTH the recorded terms tick AND an e-signed **Card Purchase Agreement** ("the document we need fighting disputes"). `card_agreement_min_jpy` exists for later loosening, seeded 0 = all. Reuses the layaway signing flow, keyed by order id. |
| D10 | `dispute.created` webhook → bell `card_dispute_opened` + evidence fields on `square_payments`. |
| D11 | `square_mode` off/test/on (fail-closed) + PUBLIC `square_app_id` / `square_location_id` in Hub settings via `set_square_settings`; `SQUARE_ACCESS_TOKEN` + `SQUARE_WEBHOOK_SIGNATURE_KEY` Lovable secrets only; the website reads the public ids from the Hub (no Vercel env). |
| D12 | Footer card marks ship in the storefront PR (S3), from Square's official logo kit. |
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

## Flow (target; S2–S4 implement it)
1. Staff Confirm the draft → the real order exists (`cash_orders`, yen,
   `payment_status = 'pending_transfer'`).
2. `GET /orders/:id` returns `card: { offered, app_id, location_id, test,
   agreement_required }` when `cardNotOfferedReason()` is null
   (`_shared/card-rules.ts`, S2): `square_mode` on (or test + `customers.is_test`),
   an app id of the mode's family, a location id, JPY, order `pending` /
   `pending_transfer`, `ready_confirmed_at` set, `remaining_balance > 0`, no
   `submitted | under_review` submission. Amount = the Hub's remaining balance,
   shown and sent as-is; the site computes nothing.
3. Agreement first (S4): the pay-card page refuses until the Apps Script lookup
   answers `signed: true` for `doc=card&order=<id>`.
4. The customer tokenises the card (3DS) → `POST /orders/:id/card
   { source_id, verification_token, terms: {accepted_at, version}, agreement }`.
   The Hub re-checks the rule, calls **CreatePayment `autocomplete:false`**
   (idempotency key = order id + attempt, `reference_id` = invoice,
   `statement_description_identifier` "CHA JEWELS"), re-reads the payment,
   then writes one `square_payments` row (`authorized`, brand, last4, 3DS
   status, receipt URL, terms + agreement evidence) and one
   `payment_submissions` row (`payment_method 'square'`, `reference_number` =
   the Square payment id, `proof_url null`, `square_payment_id`), audit row,
   bell `card_authorized`. INVARIANT 12 freezes the deadline.
5. Reviewer **Confirm** (review-payment-submission, cash branch): after the
   atomic claim and before `cash_payments` → **CompletePayment**. Success →
   `captured`; the cash payment is written as today. A hold past Square's
   capture window → submission REJECTED with the note, `expired`
   (Paidy PD4 pattern); any other failure → claim reverted, nothing written.
6. Reviewer **Reject** → **CancelPayment** (void, no fee) → `voided`.
7. `square-webhook` (public): HMAC-SHA256 of notification URL + raw body
   against `x-square-hmacsha256-signature`, timing-safe; every event id lands
   in `square_webhook_events` once; the body is never trusted — the payment is
   re-read from Square. `payment.updated`, `refund.created/updated`,
   `dispute.created` → `disputed_at` / `dispute_id` + bell `card_dispute_opened`.
8. Refunds phase 1: Square Dashboard; the Hub records `refund_status` as today.

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
- `square_webhook_events` (`event_id` PK) — idempotency log.
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

## Owner inputs before S2
1. Square Dashboard: location = Cha Jewels / Japan / JPY; Visa, Mastercard,
   Amex, JCB, Diners, Discover enabled for online; statement descriptor
   "CHA JEWELS"; dispute notification email.
2. Square Developer: Sandbox **Application ID** + **Location ID** (public,
   pasted in chat → Hub settings); sandbox **access token** → Lovable secret
   `SQUARE_ACCESS_TOKEN` only.
3. Webhook subscription to
   `https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/square-webhook` for
   `payment.updated`, `refund.created`, `refund.updated`, `dispute.created` →
   its **signature key** → Lovable secret `SQUARE_WEBHOOK_SIGNATURE_KEY` only.
