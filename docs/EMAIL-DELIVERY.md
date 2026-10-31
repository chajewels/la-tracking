<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

## EMAIL DELIVERY MONITORING — NON-NEGOTIABLE (added 2026-09-13)

  Why: from 2026-09-04 02:03 UTC to 2026-09-13 every runtime send was refused
  by the Lovable email API (400 missing_unsubscribe) and nobody noticed for
  nine days — the direct send helper wrote nothing to email_send_log and the
  storefront helper logged only to the function log. 773 customer emails lost.

  EVERY email attempt is logged. `_shared/email-log.ts` recordEmailAttempt()
  is called by BOTH senders on every outcome (sent | failed | suppressed |
  skipped). 'skipped' is the storefront helper declining to send — no address,
  a test customer at an address the owner does not read, or no API key — and it
  MUST leave a row: without one, "the customer got no email" cannot be told
  apart from "the send was never reached", and the function log that would
  settle it retains only minutes. A row absent from email_send_log therefore
  means exactly one thing: the send was never reached. 'skipped' counts as
  neither accepted nor refused in email_delivery_report, so it never moves the
  verdict. The Hub helper has no silent skip — it throws instead.
    - _shared/transactional-email-templates/send-email.ts   channel 'hub'
    - _shared/storefront-email.ts                            channel 'storefront'
  process-email-queue already wrote email_send_log (channel NULL/'queue').
  A new sender that bypasses these helpers MUST call recordEmailAttempt()
  itself; otherwise the report's 'silent' verdict is the only thing that
  will catch it. email_send_log columns added: channel, request_id (the
  Lovable request_id from the refusal body, for support tickets).
  Sent rows never carry idempotency_key (partial unique index) — the key is
  kept in metadata instead.

  FIRST REFUSAL ALERTS AT ONCE: recordEmailAttempt() on a 'failed' outcome
  inserts staff_notifications type 'email_send_refused' at most once per 24h.

  DAILY VERDICT: RPC email_delivery_report(p_hours DEFAULT 24) compares the
  customer emails the Hub should have sent in the window (reminder_logs,
  payments, cash_payments, portal payment_submissions, rejections,
  penalty_fees, approved waivers, forfeitures, loyalty_transactions,
  pre-expiry warnings, web orders placed/closed; test customers excluded)
  against email_send_log accepted / refused. Verdict:
    refused  = attempts refused and NONE accepted
    silent   = events happened but no attempt logged (a sender bypasses the log)
    degraded = some refused, some accepted
    ok       = otherwise
  Cron 'email-health-check' at 00:50 UTC (after the morning chain, Vault
  pattern) → edge function email-health-check (service role or
  system_health permission) → upserts system_settings.email_health_status
  and inserts staff_notifications type 'email_delivery_outage' (once per
  20h) whenever the verdict is not ok.

  VISIBLE IN THE HUB (src/components/system/EmailHealthIndicator.tsx):
    sidebar footer pill (always), Dashboard banner (only when not ok),
    Settings → General → "Email delivery" card with "Run check now".
  All three read the same RPC via src/hooks/useEmailHealth.ts.

  The report is REPORT-ONLY. Nothing re-sends automatically; a replay job
  was explicitly declined by the owner (2026-09-13).

## Payment reminders (added 2026-10-04)

`web-payment-reminder-sweep` sends `order-payment-due` / `layaway-deposit-due`
through `sendStorefrontEmail`, so every attempt leaves an `email_send_log` row
(channel `storefront`, `metadata.reference` = the order reference). Each
reminder also has its own `web_payment_reminders` row (claimed → sent / skipped /
failed / suppressed), and a claim that never reached the sender still shows
there. `email_delivery_report` is NOT taught to expect reminders (plan D9);
silence from them is normal while `web_payment_reminders_mode` is off. Staff see
both per order under **Customer emails** (get_order_email_history).
docs/WEB-PAYMENT-REMINDERS.md.

## Payment lifecycle emails (added 2026-10-06)

The addendum emails (received, voided/restored, refund issued/received, neutral
cancel, card hold released, web-layaway routine emails, web loyalty, store
credit) all go through `sendStorefrontEmail`, so each attempt leaves an
`email_send_log` row (channel `storefront`; labels `order-update-<variant>`,
`layaway-update-<variant>`, `web-loyalty-<variant>`, `store-credit-issued`,
`order-cancelled`, `order-payment-not-accepted`). Full table:
docs/CHECKOUT-CHOICE.md "Every payment cycle reaches her".

## One in-call retry (2026-10-02)

Both senders (`sendTemplateEmail`, `sendStorefrontEmail`) go through
`_shared/email-retry.ts` `sendLovableEmailWithRetry`: on a TRANSIENT error only
(`lovable_api_key_registry_lookup_failed`, HTTP 5xx, or a network failure with
no HTTP status) they wait 2 s and send ONCE more with the identical payload and
the SAME idempotency_key, so the API dedupes and a second email is impossible.
Everything else (suppressed, 429, any other 4xx/403, validation) is not retried.
Only the FINAL outcome is logged — one email_send_log row per logical send; a
success after retry carries `metadata.retried = true` and `first_error_type`.
This is NOT a replay job; nothing is re-sent later (2026-09-13 decision stands).
Reason: three `registry_lookup_failed` refusals (25 Sep, 27 Sep, 2 Oct, all in
the 00:00 UTC reminder burst) while sends 1 s either side with the same key
were accepted.


## Exception — B02 card refund email replay (2026-10-08)

Owner decision 2026-10-08 (Square QA plan v2): the ONE automatic re-send in the Hub. square-reconcile
(hourly) re-sends a card 「返金を受け付けました」 (`refund_received`) email for a COMPLETED Square refund on a
website order when `email_send_log` holds no `sent` row for its key `refund-received-square-<refund id>` —
the same key square-sync used, so the customer can never receive it twice. Only refunds that arrive after
the release (`square_refunds.refund_email_replay`), after a 30-minute grace, at most 3 re-sends, then bell
`refund_email_failed`. Everything else stays REPORT-ONLY. docs/SQUARE.md "QA/QC review fixes".

## 2026-10-31 outage — every Hub e-mail refused with `missing_unsubscribe`, and the extension trigger blocks Lovable's fix (recorded 2026-11-01)

**What is happening (owner-confirmed 2026-11-01).** Since 2026-10-31 20:50 JST every Hub e-mail is
refused by the Lovable e-mail API with HTTP 400 `missing_unsubscribe`, message *"Transactional emails
must include an unsubscribe_token"*. This is the OPPOSITE of the September refusal recorded in
`send-transactional-email/index.ts` ("do not set unsubscribe_token manually"): same error code, reversed
meaning. Lovable has moved the project into its required managed-email update (Lovable → More → Emails
shows "Email update needs changes first"), and until that update completes nothing sends. Every
attempt is still logged (`email_send_log` status `failed`), so `email_delivery_report()` reads
*refused* and the health card / Dashboard banner show the outage. REPORT-ONLY still holds: nothing
re-sends by itself; the owner re-sends what matters by hand once the emails work again.

**The blocker Lovable reported.** Its migration stops every time on ONE item: `public.notify_extension_event()`
(trigger `trg_notify_extension_event`, AFTER INSERT OR UPDATE on `public.extension_requests`) called
`/functions/v1/send-transactional-email` through `net.http_post` to send the customer's
"extension-requested" copy. Lovable will not delete that endpoint while a database trigger depends on
it, and its guide forbids e-mail SQL changes, so the Hub removes the dependency itself.

**The fix (PR `fix/extension-email-off-db-trigger`, migration `20270227100000_extension_trigger_no_email_call.sql`).**
- The trigger function keeps BOTH `staff_notify` calls (bell on request, bell on status change) with
  identical arguments and the same outer `EXCEPTION WHEN OTHERS THEN NULL`; only the inner
  customer-e-mail block (customer lookup, portal URL, amount string, the HTTP POST) and the eight
  variables it alone used are removed. The trigger itself is untouched; `CREATE OR REPLACE` keeps the
  ACL. The migration refuses unless live carries the recorded body (whitespace-collapsed md5
  `783e7cb6f20561335d87c4b717461ba5`, the drift-audit hash) or is already this body (replay = no-op),
  and rolls back if the new body still contains an e-mail call or not exactly 2 `staff_notify` calls.
  Live md5 could not be checked from the repo (no SQL was run) — UNVERIFIED until the owner's apply.
- `request-extension` now sends the CUSTOMER copy right after the staff copy: same template
  `extension-requested`, same templateData (customerName, invoiceNumber, reason, currency,
  remainingBalance, portalUrl), only when `customers.email` is non-empty (trimmed), its own try/catch
  (a mail failure never fails the request), idempotency key `extension-requested:<extension_requests.id>:customer`
  so a retry cannot double-send. Portal link via `buildPortalLinkForCustomerId` (PORTAL LINK RULE) —
  the trigger's own token lookup is retired with it.
- NOT touched (Lovable rewrites them in its update): `send-transactional-email`, `process-email-queue`,
  `_shared/transactional-email-templates/send-email.ts`, `_shared/storefront-email.ts`, `auth-email-hook`.

**Remaining steps, in order.**
1. Release the PR `develop` → `main` (migration + `request-extension` in the same PR, Git Workflow rule).
2. Owner-approved apply of `20270227100000` through the Lovable database connection (one sender, Claude Code).
3. Deploy `request-extension` (Lovable; source assertion on the new customer block, e.g.
   `grep -c ':customer\`' supabase/functions/request-extension/index.ts` → 1).
4. Owner presses "Try again" in Lovable → More → Emails.
5. REVIEW LOVABLE'S REWRITE BEFORE PUBLISH — especially that every sender still calls
   `recordEmailAttempt()` (the `email_send_log` rows feed `email_delivery_report()` and the health card),
   that `renderEmail` is still the only renderer, that layaway emails stay English-only, and that
   package.json / bun.lock are untouched (DEPENDENCIES ARE FROZEN). Any dropped logging is a defect to
   fix before the first live send.
6. Confirm the first successful send in `email_send_log`, then close the OPEN entry in docs/FIXED-BUGS.md.

## Rules moved from CLAUDE.md (2026-10-28)

Moved verbatim from CLAUDE.md on 2026-10-28 (Option A split); CLAUDE.md keeps a one-line pointer and every money rule.

## EMAIL DELIVERY MONITORING — NON-NEGOTIABLE (2026-09-13)

  Full text: docs/EMAIL-DELIVERY.md (moved verbatim 2026-09-24).

  - Both senders retry ONCE in-call (2 s, same idempotency_key) on transient errors only — _shared/email-retry.ts; never add a replay job. ONE exception (B02): square-reconcile re-sends an unsent card refund email (max 3, then bell refund_email_failed; docs/EMAIL-DELIVERY.md).
  - EVERY email attempt is logged via _shared/email-log.ts recordEmailAttempt()
    (sent | failed | suppressed | skipped) by both senders. A new sender that
    bypasses the helpers MUST call recordEmailAttempt() itself. A row absent from
    email_send_log means the send was never reached.
  - Sent rows never carry idempotency_key (kept in metadata).
  - The first refusal raises bell 'email_send_refused' (max once/24h).
  - email_delivery_report(p_hours) gives the verdict (refused / silent /
    degraded / ok); cron email-health-check 00:50 UTC raises
    'email_delivery_outage'. Shown in the sidebar pill, Dashboard banner and
    Settings. REPORT-ONLY — nothing re-sends automatically (owner decision),
    except the B02 card refund email above.
  - Render email ONLY with renderEmail (_shared/render-email.ts); never
    renderAsync — it splits UTF-8 across stream chunks (U+FFFD). CI-guarded.
