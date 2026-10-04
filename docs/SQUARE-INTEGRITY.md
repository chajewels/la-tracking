# Square payment integrity — plan (4 Oct 2026)

Source: `Square-Payment-Integration-Deep-Review-2026-10-04.md` (SQ01–SQ23 + section 8).
Owner answers: 1A all 23 + settlement report + operator panel · 2A refunds stay in the Square Dashboard, Hub records each one and staff record the decision · 3A while a hold is active/uncertain every other payment option is hidden; after a verified decline/void she may pay again herself · 4A cardholder name (pre-filled, editable) + "billing same as delivery" (on by default), never the gift recipient · 5A card.gs lookup returns customer + amount + version; amount changed → sign again; owner deploys card.gs · 6A CSP enforced on the card page, report-only elsewhere · production keys later (new optional secrets, sandbox unchanged) · fraud → auto-cancel the invoice.

## Live facts read before planning (read-only, 4 Oct)
- `square_mode` = test, sandbox app id + location `L1TQG8H202QYA`. 3 sandbox rows (2 captured, 1 voided), 0 open holds. 2 `square` cash_payments.
- `square_webhook_events`: 11 synced, 9 `ignored_unknown` (declined test payments arriving before / without a Hub row — exactly SQ03).
- Live bodies (read 4 Oct, after the Paidy follow-up was applied) — prosrc md5, the values the migration's pre-check guards: `finalize_cash_submission_atomic` ebb5309c38b192d8e301277d9f14b9ae · `terminate_web_order_atomic` 8422cf9aa5bcc8b94036f4e8ee3d6ce4 · `cash_order_payment_lock` 98b0bd6c102ec9067f7d433f7cde166c (each byte-identical to its repo copy). (pg_get_functiondef md5s, which include the header, differ: d0bd57f8… / 115d73a4… / 82dcd756….) All three are full replacements built from those bodies; the file aborts if live has moved (Bug #280 rule).
- terminate_web_order_atomic's INVARIANT 12 guard only sees submitted/under_review — not a confirmed-but-unrecorded claim and not a card attempt/hold. System cancel with money received raises `refund_decision_required`.
- Square docs (fact sheet): idempotency_key ≤45, reference_id ≤40; CancelPaymentByIdempotencyKey always answers success; ListPayments by location + time window; Events API is off by default (`PUT /v2/events/enable`, personal token only, 28 days, only events while enabled); `dispute.state.changed` deprecated → `dispute.state.updated`; webhook retried 11× over 24 h; CSP domains documented except 3DS issuer frames (Square: relax frame-src).

## Fraud rule (sent to owner)
Fraud = 5 refused card attempts on one order in 24 h, OR 10 across the customer's orders in 24 h, OR Square `risk_evaluation.risk_level = HIGH`.
Action: void any hold first → cancel the invoice through `terminate_web_order_atomic` (source `system`, web stock back) → reason + audit + bell. Never when money is captured or other money was received (bell to staff instead). Revive stays `revive_web_cash_order_atomic`.

## Target model
One durable **card attempt** per CreatePayment (`square_card_attempts`), written under the order lock BEFORE Square is called, with the immutable request (amount, currency, location, environment, idempotency key, reference). Square's `reference_id` = attempt reference → every webhook / listing correlates to an attempt. One unresolved commitment per order across all routes (`square_order_unresolved`, folded into the Paidy follow-up's `cash_order_payment_lock` as `card_payment_unresolved`). Provider truth always wins over a local "no charge" conclusion. Every state change + submission disposition + audit + bell happens in one SQL transaction (bells are the durable outbox).

States — attempt: reserved → authorized | declined | failed | mismatch | unknown → (cancelling → cancelled) | risk_cancelled. Hold (`square_payments.status`): authorized → captured | voided | expired | failed; `exception` column for captured-after-close / captured-unallocated / amount mismatch / unfiled hold.

## Hub — branch `fix/square-integrity` → PR into develop (not merged)
### Migration `20261104100000_square_integrity.sql` (one file, self-check at the end)
1. `square_card_attempts` (+ RLS staff select, indexes; unique idempotency_key, unique reference).
2. `square_payments` new columns: attempt_id, reference, environment, location_id, currency, provider_status, provider_version, provider_updated_at, captured_amount_jpy, cash_payment_id (unique), risk_level, verification, provider_verification, action/action_started_at/action_by, exception/exception_at/exception_note/exception_resolved_at/_by, agreement_customer_id, agreement_amount_jpy, agreement_received_at, terms_received_at, billing_summary. Backfill from live rows.
3. `square_webhook_events` → durable inbox: status, attempts, processing_started_at, next_attempt_at, completed_at, last_error, object_id. Backfill.
4. `square_refunds`, `square_disputes` (one row per provider id, lifecycle + staff decision).
5. Guard trigger `guard_provider_submission` on `payment_submissions` (CARD rules; Paidy's own rules stay in the Paidy follow-up's `trg_guard_payment_submission_paidy`): nothing is `square` without its hold; a card submission cannot change method/amount/order/customer/hold, is never linked after filing, never cancelled (Reject voids), never re-queued once rejected; and while `square_order_unresolved` no OTHER submission enters the queue for that order (insert or restore, any route, staff included).
6. Functions (SECURITY DEFINER, service_role only unless noted): `square_order_unresolved`, `reserve_square_attempt` (order lock, exact integer yen, pending/active gates, caps 5/order 10/customer), `resolve_square_attempt` (CAS + fraud counters), `file_square_authorization_atomic` (record + submission + audit + bell, idempotent, unfiled-hold exception), `apply_square_payment_state` (provider truth, COMPLETED never hidden, submission disposition, bells), `claim_square_action`/`release_square_action` (Confirm/Reject mutually exclusive before calling Square), `record_square_refund`, `record_square_dispute`, `ring_square_deadline_bells` (hold warning 2 days before Square's actual deadline; dispute reminders 3 d / 1 d; stamp only with the bell), `claim_square_event`/`finish_square_event`, `square_fraud_cancel`, staff-callable `decide_square_case`, `square_settlement_report`. `reserve_square_attempt` also refuses `paidy_in_progress`; `file_square_authorization_atomic` files a hold that arrives after Paidy took the order as `unfiled_hold / paidy_in_progress` (the edge voids it).
7. Replace live `finalize_cash_submission_atomic` (md5-guarded; built from the Paidy follow-up body, prosrc md5 ebb5309c…): Square needs a captured row, same order + customer, JPY, exact integer captured amount, not already allocated; links `square_payments.cash_payment_id`; method/link mismatch refused.
8. Replace live `terminate_web_order_atomic` (md5-guarded): automated paths also stand down for a confirmed-unrecorded claim; every termination (and its preview) answers `card_payment_unresolved` while a card attempt/hold/capture is unresolved, staff included.
9. Replace live `cash_order_payment_lock` (md5-guarded, Paidy follow-up body 98b0bd6c…): adds `card_payment_unresolved` after the `paidy_*` reasons, so Paidy start/filing, the website, the customer portal, submit-cash-payment and auto-expire all follow card money through the one answer.

### Edge functions (deploy-only Lovable message, separate from SQL)
- `_shared/square.ts`: per-environment secrets (`SQUARE_PRODUCTION_ACCESS_TOKEN` / `SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY`, fallback to current), 15 s timeout, bounded retry with jitter on 429/5xx/network, error kinds (refusal / rate_limited / auth / client / ambiguous), `version_token` on Complete, cancel-by-idempotency-key, list payments, refunds, disputes, search events; risk_evaluation, processing_fee, card verification fields.
- `_shared/card-rules.ts`: exact integer yen, fixed `nextSquareRowStatus` (provider COMPLETED wins), deadline from `capture_by`, attempt reference/key, evidence category, JST capture date. Tests updated (unsafe expectations removed).
- `_shared/square-sync.ts` (new): one sync used by webhook, reconcile, website and reviewer.
- `website`: card route rewritten around reserve → create → resolve/file; unknown outcome answers "being confirmed" (never "not charged"); stale amount refused; billing + evidence; universal gate on Paidy/transfer/card; order detail returns the attempt state.
- `square-webhook`: inbox (claim → process → finish), checked writes, retry, quarantine, refund/dispute records, 5xx on failure.
- `square-reconcile` (NEW, hourly :53): stuck events, unknown attempts (list → file or cancel-by-key), active holds, captured-unrecorded, refunds/disputes refresh, deadline bells, Events API when enabled.
- `review-payment-submission`: Square Confirm reads before and after capture, claim before Square, Finish recording, exact checks, date_paid = capture day JST; Reject claims first, reads Square, voids, verifies.
- `auto-expire-cash-orders`: hold warning moved to reconcile; new terminate reason handled.
- `edit-payment-submission`, `submit-cash-payment`: provider-aware refusals + active-card gate (via `cash_order_payment_lock`).
- `customer-portal`: `card_processing` on a cash order while the lock says `card_payment_unresolved` (portal hides Submit Payment and says the card payment is being processed).

### Hub UI
- Payments Hub: Square "Finish recording", no method relabel on provider rows, card state line.
- New **Card payments** operator panel: active holds, unknown attempts, captured-unrecorded/exceptions, refunds (record decision), disputes (deadline, record decision), webhook failures, unmatched events; settlement report (gross captures, refunds, disputes, Square fees, net; CSV).

## Storefront — branch `fix/card-integrity` → PR into develop (not merged)
Pay-card page: cardholder name + billing-same-as-delivery; billingContact from those (never the recipient, name not split); expected amount sent and checked; SDK destroy on failed attach/unmount; action try/catch; outcome states (authorized / being confirmed / declined / too many / cancelled for safety); CSP enforced (nonce, strict-dynamic) on `/account/orders/[id]/pay-card`, report-only elsewhere + `/api/csp-report`; agreement sign URL carries a signed context (order, customer, amount, version); gate requires the lookup's customer + amount to match.

## card.gs + card.html (owner deploys)
Full updated `Card.gs`: verifies the signed context (HMAC with `CJ_LOOKUP_TOKEN`), stores customer id + amount + context-verified, lookup returns `customer_id`, `amount_jpy`, `agreement_version`, `signed_at`, `bound`. `card.html`: forwards `ctx` and `amount` in the POST (two lines).

## Checks
Hub: tsc, vitest (card-rules + new), deno tests (signature, sync, filing), function-drift-audit 0/0/0 for the patched functions, migration dry-run on live in BEGIN…ROLLBACK (read-only result). Storefront: check:terms, check:i18n, check:analytics, check:money, check:contrast, typecheck, lint, tests, build. CI green on both PRs. Independent review subagent; findings fixed. Browser visual checks on previews (desktop + 375 px).

## Prepared, not sent
Release commands · Lovable msg 1 SQL-apply only · Lovable msg 2 deploy-only · cron SQL · Square Dashboard steps (events incl. `dispute.state.updated`, Events API enable) · production go-live steps · Card.gs + card.html.
