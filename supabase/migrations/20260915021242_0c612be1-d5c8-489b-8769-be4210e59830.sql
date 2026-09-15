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