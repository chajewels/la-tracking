-- email_send_log.status: admit 'skipped' and 'rate_limited'.
--
-- WHAT IS BROKEN. The CHECK constraint admits seven values:
--   pending, sent, suppressed, failed, bounced, complained, dlq
-- Two writers emit values outside that list, so every one of their rows is
-- rejected on insert:
--
--   1. 'skipped'      _shared/storefront-email.ts (#53). The whole point of
--                     #53 was that a declined send must leave a row, so that
--                     "the customer got no email" can be told apart from "the
--                     send was never reached". #53 shipped on the stated
--                     assumption that this column had no check constraint.
--                     That assumption was wrong.
--   2. 'rate_limited' process-email-queue/index.ts, the isRateLimited branch.
--                     Pre-dates #53 and was missed by it.
--
-- AND BOTH FAIL SILENTLY. recordEmailAttempt() logs the insert error and
-- returns — by design, so that a logging failure can never turn a skipped
-- email into a failed customer order. The 'rate_limited' insert in
-- process-email-queue does not even destructure `error`. So the rows vanish,
-- nothing raises, and the code reads as though it handles the case. That is
-- worse than the gap #53 set out to close: an untrue record of having a record.
--
-- EXPOSURE. Zero rows have actually been lost to the 'skipped' half. The
-- skip-logging code has never been deployed: main@9fb6f8ae, the tip deployed
-- on 2026-09-13, has recordEmailAttempt x4 and no 'skipped' at all; #53
-- (818b0a06, 2026-09-14) is not an ancestor of it. The skip path first reaches
-- production with the 29-function deploy. 'rate_limited' has been live longer,
-- but process-email-queue has had no cron since 2026-09-14 and its last
-- activity of any kind was 2026-09-09, so its loss is bounded too.
--
-- 'suppressed' IS NOT A SUBSTITUTE. It means the provider suppressed the
-- send — a hard bounce, a complaint, an unsubscribe. 'skipped' means the Hub
-- chose not to send: no address on file, a test customer at an address the
-- owner does not read, or no API key configured. Collapsing the two destroys
-- exactly the distinction the column exists to record, and would make a
-- missing address look like a deliverability problem.
--
-- VERDICT IMPACT: NONE. email_delivery_report computes its verdict from
--   v_sent   = count(*) FILTER (WHERE status = 'sent')
--   v_failed = count(*) FILTER (WHERE status IN ('failed','dlq'))
-- and nothing else: refused = failed>0 AND sent=0; silent = expected>0 AND
-- sent=0 AND failed=0; degraded = failed>0; ok otherwise. Neither new value
-- appears in either filter, so no verdict, count or timestamp moves. That is
-- deliberate: a skipped send is a decision, not a delivery failure.
--
-- THE TWO PARTIAL UNIQUE INDEXES ARE LEFT ALONE, and neither new value is
-- added to them:
--   idx_email_send_log_idempotency_active  (idempotency_key)
--       WHERE idempotency_key IS NOT NULL AND status IN ('pending','sent')
--   idx_email_send_log_message_sent_unique (message_id) WHERE status = 'sent'
-- A skip row DOES carry idempotency_key — recordEmailAttempt stores the key on
-- every non-'sent' row — so it is the index's own status filter, not a null
-- key, that keeps it out. That is the behaviour we want: two skips sharing an
-- idempotency key must BOTH land (a retry after a skip is a real second
-- event), and adding 'skipped' to that index would make the retry fail the
-- insert. A skip has no message_id, and is not 'sent', so the second index
-- cannot see it either.
--
-- DROP AND RECREATE with the full nine values. The live constraint was read
-- from pg_constraint before writing this, not taken from the baseline —
-- the layaway_account_items lesson. Verified 2026-09-15: live definition
-- matches the baseline exactly, seven values, no 'skipped'.

ALTER TABLE public.email_send_log
  DROP CONSTRAINT IF EXISTS email_send_log_status_check;

ALTER TABLE public.email_send_log
  ADD CONSTRAINT email_send_log_status_check CHECK (
    status = ANY (ARRAY[
      'pending'::text,      -- queued, not yet handed to the provider
      'sent'::text,         -- provider accepted it
      'suppressed'::text,   -- the PROVIDER refused to send (bounce, complaint)
      'failed'::text,       -- the provider rejected the attempt
      'bounced'::text,      -- returned after acceptance
      'complained'::text,   -- recipient marked it spam
      'dlq'::text,          -- dead-lettered out of the queue
      'skipped'::text,      -- WE chose not to send: no address, test customer,
                            -- or no API key. Not a delivery failure.
      'rate_limited'::text  -- provider rate limit; the queue will retry
    ])
  );

COMMENT ON COLUMN public.email_send_log.status IS
  'Outcome of one email attempt. sent = provider accepted. failed / dlq = refused, and only these two plus sent move email_delivery_report''s verdict. suppressed = the PROVIDER declined. skipped = the HUB declined to send (no address / test customer / no API key) — a decision, not a failure. rate_limited = provider throttled, queue retries. bounced / complained arrive after acceptance.';
