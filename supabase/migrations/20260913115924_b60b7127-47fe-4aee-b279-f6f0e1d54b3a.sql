-- Email delivery monitoring (owner decision 2026-09-13, after the nine-day
-- missing_unsubscribe outage that ran silently because the redeployed direct
-- send helper never wrote email_send_log and the storefront helper logged only
-- to the function log).
--
-- Three parts:
--   A. email_send_log gains channel / request_id so every attempt from every
--      sender (Hub template helper, storefront helper, queue worker) lands in
--      one table with the Lovable request_id for support.
--   B. email_delivery_report(p_hours): expected customer emails (from the Hub's
--      own event tables) against attempts accepted / refused in the same window,
--      plus the current refusal streak. Staff-readable (role check inside).
--   C. Daily cron 'email-health-check' at 00:50 UTC (after the morning chain)
--      → edge function email-health-check, which stores the verdict in
--      system_settings.email_health_status and raises a staff notification
--      when nothing is being accepted.

-- A. one log for every attempt
ALTER TABLE public.email_send_log
  ADD COLUMN IF NOT EXISTS channel text,
  ADD COLUMN IF NOT EXISTS request_id text;
COMMENT ON COLUMN public.email_send_log.channel IS 'hub (transactional-email-templates/send-email.ts), storefront (_shared/storefront-email.ts), queue (process-email-queue), system (suppression webhooks).';
COMMENT ON COLUMN public.email_send_log.request_id IS 'Lovable email API request_id from the error body, when the send was refused.';
CREATE INDEX IF NOT EXISTS idx_email_send_log_status_created ON public.email_send_log (status, created_at DESC);

-- B. expected vs accepted
CREATE OR REPLACE FUNCTION public.email_delivery_report(p_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_since timestamptz := now() - make_interval(hours => GREATEST(1, COALESCE(p_hours, 24)));
  v_expected jsonb;
  v_expected_total integer;
  v_sent integer; v_failed integer; v_suppressed integer;
  v_last_sent timestamptz; v_first_fail timestamptz; v_last_fail timestamptz;
  v_streak_start timestamptz; v_newest_error text; v_newest_request_id text;
  v_sf_sent integer; v_sf_failed integer;
BEGIN
  -- Staff only. Customers hold authenticated sessions too, so the role check
  -- lives inside the function, not in the grant.
  IF auth.uid() IS NOT NULL AND NOT (
       public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'finance')
    OR public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'csr')) THEN
    RAISE EXCEPTION 'staff role required' USING ERRCODE = '42501';
  END IF;

  -- Events that each produce one customer email. Test customers excluded.
  SELECT jsonb_build_object(
    'payment_reminders', (SELECT count(*) FROM reminder_logs rl JOIN customers c ON c.id = rl.customer_id
                            WHERE rl.created_at >= v_since AND NOT c.is_test),
    'layaway_payment_confirmations', (SELECT count(*) FROM payments p JOIN layaway_accounts la ON la.id = p.account_id JOIN customers c ON c.id = la.customer_id
                            WHERE p.created_at >= v_since AND p.voided_at IS NULL AND NOT c.is_test AND la.invoice_number ~ '^[0-9]+$'),
    'cash_payment_confirmations', (SELECT count(*) FROM cash_payments cp JOIN cash_orders co ON co.id = cp.cash_order_id JOIN customers c ON c.id = co.customer_id
                            WHERE cp.created_at >= v_since AND cp.voided_at IS NULL AND NOT c.is_test),
    'portal_submission_acknowledgements', (SELECT count(*) FROM payment_submissions ps JOIN customers c ON c.id = ps.customer_id
                            WHERE ps.created_at >= v_since AND ps.portal_token IS NOT NULL AND NOT c.is_test),
    'payment_rejections', (SELECT count(*) FROM payment_submissions ps JOIN customers c ON c.id = ps.customer_id
                            WHERE ps.status = 'rejected' AND ps.updated_at >= v_since AND NOT c.is_test),
    'penalties_applied', (SELECT count(*) FROM penalty_fees f JOIN layaway_accounts la ON la.id = f.account_id JOIN customers c ON c.id = la.customer_id
                            WHERE f.created_at >= v_since AND NOT c.is_test),
    'waivers_approved', (SELECT count(*) FROM penalty_waiver_requests w JOIN layaway_accounts la ON la.id = w.account_id JOIN customers c ON c.id = la.customer_id
                            WHERE w.approved_at >= v_since AND NOT c.is_test),
    'accounts_forfeited', (SELECT count(*) FROM layaway_accounts la JOIN customers c ON c.id = la.customer_id
                            WHERE la.forfeited_at >= v_since AND NOT c.is_test),
    'loyalty_events', (SELECT count(*) FROM loyalty_transactions x JOIN loyalty_members m ON m.id = x.member_id JOIN customers c ON c.id = m.customer_id
                            WHERE x.created_at >= v_since AND NOT c.is_test AND x.transaction_type IN ('earned','expired','redeemed','tier_changed','bonus','birthday_bonus')),
    'loyalty_pre_expiry_warnings', (SELECT count(*) FROM loyalty_members m JOIN customers c ON c.id = m.customer_id
                            WHERE m.pre_expiry_warned_at >= v_since AND NOT c.is_test),
    'web_orders_placed', (SELECT count(*) FROM cash_orders co JOIN customers c ON c.id = co.customer_id
                            WHERE co.created_at >= v_since AND co.source_channel = 'web' AND NOT c.is_test),
    'web_orders_closed', (SELECT count(*) FROM cash_orders co JOIN customers c ON c.id = co.customer_id
                            WHERE co.source_channel = 'web' AND NOT c.is_test
                              AND (co.cancelled_at >= v_since OR co.expired_at >= v_since))
  ) INTO v_expected;

  SELECT COALESCE(sum((value)::integer), 0) INTO v_expected_total FROM jsonb_each_text(v_expected);

  SELECT count(*) FILTER (WHERE status = 'sent'),
         count(*) FILTER (WHERE status IN ('failed','dlq')),
         count(*) FILTER (WHERE status = 'suppressed'),
         max(created_at) FILTER (WHERE status = 'sent'),
         min(created_at) FILTER (WHERE status IN ('failed','dlq')),
         max(created_at) FILTER (WHERE status IN ('failed','dlq')),
         count(*) FILTER (WHERE status = 'sent' AND channel = 'storefront'),
         count(*) FILTER (WHERE status IN ('failed','dlq') AND channel = 'storefront')
    INTO v_sent, v_failed, v_suppressed, v_last_sent, v_first_fail, v_last_fail, v_sf_sent, v_sf_failed
    FROM email_send_log WHERE created_at >= v_since;

  -- Current refusal streak: first failure after the newest accepted send,
  -- across the whole log (not just the window), so a nine-day outage shows
  -- its true start date.
  SELECT min(created_at) INTO v_streak_start FROM email_send_log
   WHERE status IN ('failed','dlq')
     AND created_at > COALESCE((SELECT max(created_at) FROM email_send_log WHERE status = 'sent'), '-infinity'::timestamptz);

  SELECT left(error_message, 400), request_id INTO v_newest_error, v_newest_request_id
    FROM email_send_log WHERE status IN ('failed','dlq') ORDER BY created_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'window_hours', GREATEST(1, COALESCE(p_hours, 24)),
    'since', v_since,
    'generated_at', now(),
    'expected', v_expected,
    'expected_total', v_expected_total,
    'sent', v_sent,
    'failed', v_failed,
    'suppressed', v_suppressed,
    'storefront', jsonb_build_object('sent', v_sf_sent, 'failed', v_sf_failed),
    'last_sent_at', (SELECT max(created_at) FROM email_send_log WHERE status = 'sent'),
    'last_sent_in_window_at', v_last_sent,
    'first_failure_in_window_at', v_first_fail,
    'last_failure_at', v_last_fail,
    'refusal_streak_started_at', v_streak_start,
    'newest_error', v_newest_error,
    'newest_request_id', v_newest_request_id,
    -- verdict: refused = attempts refused and nothing accepted; silent = events
    -- happened but no attempt was even logged (a sender is bypassing the log);
    -- degraded = some refused, some accepted; ok otherwise.
    'status', CASE
      WHEN v_failed > 0 AND v_sent = 0 THEN 'refused'
      WHEN v_expected_total > 0 AND v_sent = 0 AND v_failed = 0 THEN 'silent'
      WHEN v_failed > 0 THEN 'degraded'
      ELSE 'ok' END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.email_delivery_report(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.email_delivery_report(integer) TO authenticated, service_role;

-- C. daily check, Vault-backed like every other cron (CLAUDE.md CRON AUTH RULE)
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'email-health-check';
SELECT cron.schedule('email-health-check', '50 0 * * *', $cron$
  SELECT net.http_post(
    url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/email-health-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')
    ),
    body := '{}'::jsonb
  );
$cron$);