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
