## RETROACTIVE ENROLLMENT AWARD (added 2026-05-20)

  On enrollment, join-loyalty-program looks back
  `system_settings.loyalty_enrollment_grace_days` (integer, default
  3 if missing/invalid) days for the single most-recent qualifying
  order whose DP/full payment was confirmed within that window
  (via RPC `get_recent_qualifying_order(p_customer_id, p_lookback_days)`)
  and awards it by invoking award-loyalty-points. Customers who
  enroll later than the window get no retroactive award.

  "Confirmed within N days" semantics:
    - Layaway DP: `payment_submissions.updated_at` when status
      flipped to `'confirmed'`
    - Cash full payment: `cash_orders.completed_at`
    - NEVER `date_paid` (customer-reported, can be backdated)

  Qualifying order rules:
    - Layaway: `loyalty_jpy_amount >= 10000` OR `loyalty_jpy_amount IS NULL`
      (NULL is permitted — typical when a non-member created the order;
      derived at enrollment time, see below)
    - Cash: `loyalty_jpy_amount >= 10000` OR `loyalty_jpy_amount IS NULL`
      (mirrors layaway as of 2026-08-16 — previously cash had NO NULL
      tolerance and no derive path, so cash orders created while the
      customer was not yet a member never qualified; see Bug entry in
      docs/FIXED-BUGS.md)
    - Layaway status NOT IN ('cancelled', 'forfeited',
      'final_forfeited')
    - Cash status NOT IN ('cancelled', 'expired')

  NULL loyalty_jpy_amount derivation (layaway AND cash, as of 2026-08-16):
    - If the matched layaway order has `loyalty_jpy_amount IS NULL`,
      join-loyalty-program calls
      `derive_order_loyalty_jpy(p_account_id => row.account_id)` to
      populate the value for THAT ONE ACCOUNT ONLY before invoking
      award-loyalty-points.
    - If the matched cash order has `loyalty_jpy_amount IS NULL`,
      join-loyalty-program calls the sibling RPC
      `derive_cash_order_loyalty_jpy(p_cash_order_id => cashOrderId)` to
      populate the value for THAT ONE CASH ORDER ONLY before invoking
      award-loyalty-points. Same non-blocking try/warn pattern as the
      layaway call — a derive failure never fails enrollment.
    - Derivation formula (inside both RPCs):
        JPY → loyalty_jpy_amount = total_amount
        PHP → loyalty_jpy_amount = round(total_amount / php_jpy_rate)
      `shipping_fee` is deliberately NOT subtracted on the cash side —
      matches layaway, which has no shipping column at all, so the two
      formulas stay in lockstep on the JPY basis they do share.
    - NON-NEGOTIABLE: derive_order_loyalty_jpy / derive_cash_order_loyalty_jpy
      are the ONLY write paths for loyalty_jpy_amount in this flow. Never
      bulk-update across the customer's other accounts or orders. Only the
      single account_id / cash_order_id returned by
      get_recent_qualifying_order is ever touched.
    - award-loyalty-points re-reads the now-populated value; its
      `>= 10000` gate still applies, so trivially small orders are
      skipped naturally.

  Wiring:
    - Only fires on the NEW-member path (NOT the already_enrolled
      early-return).
    - Wrapped in try/catch — any failure logs but never fails
      enrollment. The customer is already enrolled before this
      block runs.
    - Reuses award-loyalty-points (does not reimplement award
      logic). Service-role fetch, awaited so the inner ledger
      writes complete before the function returns.


  award-loyalty-points is now IDEMPOTENT per source:
    - Step 4b (after `not_enrolled` gate, before any ledger write):
      `SELECT 1 FROM loyalty_transactions WHERE transaction_type='earned'
       AND (account_id = $1 OR cash_order_id = $2) LIMIT 1`
    - On hit → returns `{ skipped: true, reason: 'already_awarded' }`
      and writes NOTHING (no txn, lot, member update, sheet, or
      email).
    - Invisible to existing review-payment-submission callers (each
      order is awarded exactly once today). Becomes load-bearing for
      the retroactive enrollment path: if review-payment-submission
      already awarded an order and the customer enrolls within the
      grace window, the retroactive call is a no-op.

## EMAIL SENDING — LOVABLE WORKSPACE RATE LIMIT (added 2026-05-20)

  Transactional email is sent via send-transactional-email (sole sender),
  which uses Lovable-managed email. Subject to Lovable's workspace cap:
    - 100 emails per HOUR per workspace (hard limit; the binding constraint)
    - 50,000 transactional emails per MONTH included (not the bottleneck)
    - Higher hourly limit only via Lovable Support request

  Architecture: send-reminders / award flows enqueue onto the
  'transactional_emails' pgmq queue; a queue worker calls the email API.
    - reminder_logs.delivery_status='sent' means ENQUEUED, not provider-delivered.
    - Provider 429 (rate_limited "High demand") occurs in the queue worker,
      downstream of reminder_logs — so 429s do NOT appear in reminder_logs.
    - On 429 the message stays queued and retries with backoff over the
      following hours: no mail lost, but delivery delayed.

### Reminder cron (LOCKED — do not re-add a second job)
  Canonical: jobid 1 'daily-send-reminders', schedule '0 0 * * *' (= 8 AM PHT).
  REMOVED 2026-05-20: jobid 14 'daily-payment-reminders' ('2 0 * * *') — a
  DUPLICATE hitting the same /send-reminders endpoint 2 min later, doubling the
  hourly burst (~146/hr) past the 100/hr cap. Both produced identical batches
  (the function ignores the body payload). NEVER re-add a second reminder cron.

### Bug #114 (send-reminders RateLimitError) — root cause + status
  Root cause: the duplicate cron doubled the midnight burst past Lovable's
  100/hr cap, returning 429 rate_limited. Code fix 8ea5b2a (retry + backoff)
  handles transient 429s; queue redelivery prevents mail loss. Duplicate cron
  removed 2026-05-20 — that was the real volume fix.

### Standing risk + mitigations (priority order)
  Even the deduped single reminder batch hits ~100/hr on peak days
  (103 on 2026-05-15, 101 on 2026-05-07) before payment-confirmation emails
  share the hour. Dedup alone is NOT sufficient.
    1. Raise the Lovable hourly cap via Lovable Support (fastest, no code).
    2. Consolidate reminders per RECIPIENT into one digest (cuts volume +
       better UX) — a send-reminders change.
    3. Pace the queue worker to <=90/hr so over-cap days spill gracefully.
    4. Connect own Resend account to escape the workspace cap (largest lift).


## NEWSLETTER CAMPAIGNS — DEDICATED PROVIDER (added 2026-09-22)

  Newsletter campaigns are MARKETING mail and are sent through their OWN
  provider (Resend) on their OWN sender subdomain — NEVER through
  send-transactional-email. Two reasons, both non-negotiable:
    1. The Lovable-managed transactional API does not permit bulk/marketing
       sending.
    2. A campaign's complaint and bounce rate must never be able to damage
       delivery of payment, penalty, loyalty or portal email. The campaign
       sender is news@news.chajewelsjp.com — a SUBDOMAIN, so its reputation is
       scored separately from chajewelsjp.com.

### Sending stays OFF until setup is complete
  Both conditions must hold or nothing is sent:
    1. secret RESEND_API_KEY is set, and
    2. secret/env NEWSLETTER_DOMAIN_VERIFIED = "true".
  While off:
    - campaign-queue "send to list" is refused 409 sending_disabled with the
      reason in plain words (recipients are NOT snapshotted, nothing is lost).
    - campaign-queue with test_email returns the fully rendered HTML and sends
      nothing (logged to email_send_log as 'skipped').
    - process-newsletter-campaigns returns { skipped: true, reason } and leaves
      every recipient pending.

### Setup steps (in order)
  1. In Resend, add the domain news.chajewelsjp.com (a subdomain — do NOT add
     chajewelsjp.com, and do NOT reuse the Lovable-managed email subdomain:
     that one's DNS is delegated to Lovable nameservers and a second provider
     cannot verify records inside it).
  2. Add the SPF, DKIM and DMARC records Resend shows for
     news.chajewelsjp.com at the DNS provider, and wait for Verified.
  3. Save the Resend API key as the RESEND_API_KEY secret.
  4. Set NEWSLETTER_DOMAIN_VERIFIED = "true".
  5. Optional overrides: NEWSLETTER_FROM_EMAIL (default
     news@news.chajewelsjp.com), NEWSLETTER_FROM_NAME (default "Cha Jewels").
  6. Send a test first (campaign-queue with test_email) and read the footer:
     registered name Ｃｈａ Ｊｅｗｅｌｓ株式会社, the registered address, and a
     working unsubscribe link. The same URL is sent as List-Unsubscribe /
     List-Unsubscribe-Post (one-click) by the provider adapter.

### Rate cap — CONFIG, not a constant
  system_settings.newsletter_rate_per_hour (jsonb scalar, DEFAULT 60 when
  missing or invalid). The worker runs every 10 minutes and takes one sixth of
  the hourly allowance per run, so the default is 10 per run = 60/hour.
  Because the provider is dedicated, this budget is NOT shared with
  transactional mail (which stays bound by Lovable's 100/hour workspace cap) —
  raise it once the sending domain is warmed up:
    UPDATE system_settings SET value = '120'::jsonb
     WHERE key = 'newsletter_rate_per_hour';
  Warm-up guidance: stay at 60/hour for the first sends, then raise gradually.
  A provider 429 stops that run and leaves the remaining recipients pending —
  no mail lost, delivery delayed to the next tick.

### Pipeline
  campaign-queue (staff JWT + manage_website_content)
    { campaign_id } → from status 'draft' only: snapshots active subscribers
    (unsubscribed_at IS NULL) filtered by campaign audience, one recipient row
    each with the language they will receive, total = pending count, status
    'queued', queued_at now.
    { campaign_id, test_email } → renders and sends ONE copy per language the
    campaign has, subject prefixed "[TEST] ", no recipient rows, returns the
    HTML.
  Language rule: recipient language = subscriber language; a subscriber whose
  language is missing from the campaign falls back to the other one — EXCEPT a
  JA subscriber is SKIPPED when only the EN version exists and it mentions
  layaway (financial terms half-understood are worse than no email).
  process-newsletter-campaigns (cron */10, Vault-backed service key)
    Oldest queued campaign first, 5 concurrent, recipients re-checked for
    unsubscribed_at at send time (→ 'skipped'), recordEmailAttempt() per
    recipient, campaign → 'sending' on first send and 'sent' when no pending
    rows remain.
  campaign-cancel (staff JWT + manage_website_content)
    { campaign_id } → queued/sending become 'cancelled'; pending recipients
    become 'skipped'. Already-sent recipients are never rewritten.
