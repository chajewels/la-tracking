-- ============================================================================
-- RESERVE FIRST, PAY AFTER STAFF CONFIRM — A2 (the SQL half)
--
-- A1 (20260923140000_reserve_first_a1) built the RPCs. A2 is edge functions and
-- the Hub; this file is the little SQL A2 needs, and nothing else:
--
--   1. reservation_reminded_at on cash_orders and layaway_accounts — the DEDUPE
--      for the internal "still unconfirmed after 24 hours" email to
--      sales@chajewelsjp.com. A column, not the email log: the log is keyed by
--      send, not by order, and "has THIS reservation been chased" is a fact
--      about the order. web-reservation-sweep stamps it only after the email
--      was accepted, so a refused send is retried next hour.
--   2. The staff bell on a new web order says "New reservation — confirm the
--      piece" when the order arrives UNCONFIRMED (ready_confirmed_at IS NULL).
--      A1 stamps ready_confirmed_at = now() on every order written with the
--      switch off, and these triggers run AFTER INSERT, so with
--      web_reservation_mode false the reservation branch can never be taken
--      and every notification reads exactly as it does today.
--   3. email_delivery_report counts the new customer emails as expected
--      events, so a reserve-first send that never reaches email_send_log is
--      caught by the 'silent' verdict like every other sender.
--   4. Hourly cron 'web-reservation-sweep' (Vault pattern) at :23 — a free
--      minute (:00 promotions + loyalty queue, :07 sheet reconcile, :30/:00 fc
--      alerts, :40 auto-expire-cash-orders).
--
-- FUNCTION BODIES START FROM LIVE (CLAUDE.md, Bug #280). The three functions
-- replaced below were md5-matched against the repo's last recorded body in a
-- scratch copy of the baseline plus every later migration; the guard in
-- section 0 makes the same comparison against LIVE and stops, changing
-- nothing, if live carries anything the repo has never seen.
--
-- ADDITIVE ONLY. Two nullable columns, one expanded report, two triggers that
-- gain one branch, one cron job. Nothing is dropped.
-- ============================================================================

-- ---------------------------------------------------------------- 0. guards
DO $guard$
DECLARE
  v_expect CONSTANT text[][] := ARRAY[
    ARRAY['email_delivery_report',     '6bbdad92b00a0aadf42f172a7ad2749f'],
    ARRAY['notify_account_created',    '21bf6dd8a7087452ac1fc468b8c5c124'],
    ARRAY['notify_cash_order_created', '559473603739e9e6cf75aa64660a8360']];
  v_n    integer;
  v_md5  text;
  v_bad  text := '';
  i      integer;
BEGIN
  FOR i IN 1 .. array_length(v_expect, 1) LOOP
    SELECT count(*), min(md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))))
      INTO v_n, v_md5
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_expect[i][1];
    IF v_n <> 1 THEN
      v_bad := v_bad || format(E'\n  %s: %s overloads live, expected exactly 1', v_expect[i][1], v_n);
    ELSIF v_md5 <> v_expect[i][2] THEN
      v_bad := v_bad || format(E'\n  %s: live body md5 %s, expected %s', v_expect[i][1], v_md5, v_expect[i][2]);
    END IF;
  END LOOP;

  -- A1 must already be live: this file reads its columns and the sweep calls
  -- its RPCs.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'cash_orders'
                    AND column_name = 'ready_confirmed_at')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'layaway_accounts'
                    AND column_name = 'ready_confirmed_at')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public'
                    AND p.proname = 'expire_unconfirmed_web_reservations_atomic') THEN
    v_bad := v_bad || E'\n  Reserve-first A1 (20260923140000) is not live';
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'web-reservation-sweep') THEN
    v_bad := v_bad || E'\n  cron job web-reservation-sweep already exists — this migration has run before';
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION E'STOP — live is not the state this migration was written against. Nothing was modified.%', v_bad;
  END IF;
END
$guard$;

-- ------------------------------------------------ 1. the 24-hour reminder dedupe
ALTER TABLE public.cash_orders
  ADD COLUMN IF NOT EXISTS reservation_reminded_at timestamptz;
ALTER TABLE public.layaway_accounts
  ADD COLUMN IF NOT EXISTS reservation_reminded_at timestamptz;

COMMENT ON COLUMN public.cash_orders.reservation_reminded_at IS
  'Reserve-first (A2): when web-reservation-sweep emailed sales@ that this reservation was still unconfirmed after 24 hours. Set once, after the email was accepted. NULL = not chased. Never read by any customer surface.';
COMMENT ON COLUMN public.layaway_accounts.reservation_reminded_at IS
  'Reserve-first (A2): when web-reservation-sweep emailed sales@ that this reservation was still unconfirmed after 24 hours. Set once, after the email was accepted. NULL = not chased. Never read by any customer surface.';

-- ------------------------------------------- 2. staff bell: say it is a reservation
-- Recorded live body (20260915050000) + one branch, taken ONLY when a web plan
-- arrives unconfirmed. The existing web and Hub branches are byte-for-byte
-- what they were.
CREATE OR REPLACE FUNCTION public.notify_account_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_who text;
BEGIN
  BEGIN
    IF NEW.source_channel = 'web' AND NEW.ready_confirmed_at IS NULL THEN
      -- RESERVE-FIRST (A2): no deadline exists yet, so none is named. The
      -- title is the instruction: nothing happens for the customer until a
      -- member of staff confirms the piece.
      v_who := COALESCE(
        (SELECT NULLIF(btrim(c.full_name), '') FROM public.customers c WHERE c.id = NEW.customer_id),
        'a website customer');
      PERFORM public.staff_notify(
        'account_created', 'New reservation — confirm the piece',
        COALESCE(NEW.web_reference, NEW.invoice_number, '?') || ' · ' || v_who
          || ' · layaway ' || public.notify_money_label(NEW.total_amount, NEW.currency::text)
          || ' over ' || COALESCE(NEW.payment_plan_months::text, '?') || ' months'
          || ' · no payment deadline until confirmed · auto-cancels after 72 hours',
        NEW.id, NEW.customer_id, NEW.invoice_number,
        jsonb_build_object(
          'layaway_account_id', NEW.id,
          'source_channel', 'web',
          'web_reference', NEW.web_reference,
          'currency', NEW.currency::text,
          'total_amount', NEW.total_amount,
          'downpayment_amount', NEW.downpayment_amount,
          'reservation', true)
      );
    ELSIF NEW.source_channel = 'web' THEN
      v_who := COALESCE(
        (SELECT NULLIF(btrim(c.full_name), '') FROM public.customers c WHERE c.id = NEW.customer_id),
        'a website customer');
      PERFORM public.staff_notify(
        'account_created', 'Website layaway placed',
        COALESCE(NEW.web_reference, NEW.invoice_number, '?') || ' · ' || v_who
          || ' · ' || public.notify_money_label(NEW.total_amount, NEW.currency::text)
          || ' over ' || COALESCE(NEW.payment_plan_months::text, '?') || ' months · '
          || public.notify_deadline_label(NEW.transfer_due_at),
        NEW.id, NEW.customer_id, NEW.invoice_number,
        jsonb_build_object(
          'layaway_account_id', NEW.id,
          'source_channel', 'web',
          'web_reference', NEW.web_reference,
          'currency', NEW.currency::text,
          'total_amount', NEW.total_amount,
          'downpayment_amount', NEW.downpayment_amount,
          'transfer_due_at', NEW.transfer_due_at)
      );
    ELSE
      -- Unchanged from the baseline.
      PERFORM public.staff_notify(
        'account_created', 'Account created',
        'Inv #' || COALESCE(NEW.invoice_number,'?') || ' created by ' || public.staff_display_name(NEW.created_by_user_id),
        NEW.id, NEW.customer_id, NEW.invoice_number, '{}'::jsonb
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.notify_cash_order_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_who text;
BEGIN
  BEGIN
    IF NEW.source_channel = 'web' AND NEW.ready_confirmed_at IS NULL THEN
      -- RESERVE-FIRST (A2): see notify_account_created.
      v_who := COALESCE(
        (SELECT NULLIF(btrim(c.full_name), '') FROM public.customers c WHERE c.id = NEW.customer_id),
        'a website customer');
      PERFORM public.staff_notify(
        'account_created', 'New reservation — confirm the piece',
        COALESCE(NEW.web_reference, NEW.invoice_number, '?') || ' · ' || v_who
          || ' · ' || public.notify_money_label(NEW.total_amount, NEW.currency::text)
          || ' paid in full · no payment deadline until confirmed · auto-cancels after 72 hours',
        NULL, NEW.customer_id, NEW.invoice_number,
        jsonb_build_object(
          'cash_order_id', NEW.id,
          'source_channel', 'web',
          'web_reference', NEW.web_reference,
          'currency', NEW.currency::text,
          'total_amount', NEW.total_amount,
          'reservation', true)
      );
    ELSIF NEW.source_channel = 'web' THEN
      v_who := COALESCE(
        (SELECT NULLIF(btrim(c.full_name), '') FROM public.customers c WHERE c.id = NEW.customer_id),
        'a website customer');
      PERFORM public.staff_notify(
        'account_created', 'Website order placed',
        COALESCE(NEW.web_reference, NEW.invoice_number, '?') || ' · ' || v_who
          || ' · ' || public.notify_money_label(NEW.total_amount, NEW.currency::text)
          || ' paid in full · ' || public.notify_deadline_label(NEW.transfer_due_at),
        NULL, NEW.customer_id, NEW.invoice_number,
        jsonb_build_object(
          'cash_order_id', NEW.id,
          'source_channel', 'web',
          'web_reference', NEW.web_reference,
          'currency', NEW.currency::text,
          'total_amount', NEW.total_amount,
          'transfer_due_at', NEW.transfer_due_at)
      );
    ELSE
      -- Unchanged.
      PERFORM public.staff_notify(
        'account_created', 'Cash order created',
        'Inv #' || COALESCE(NEW.invoice_number,'?') || ' created by ' || public.staff_display_name(NEW.created_by_user_id),
        NULL, NEW.customer_id, NEW.invoice_number,
        jsonb_build_object('cash_order_id', NEW.id)
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $function$;

-- ----------------------------------------- 3. email_delivery_report: new events
-- Recorded live body (20260913115924) + three expected-event keys. Everything
-- else — the attempt counts, the streak, the verdict — is unchanged.
--
--   web_layaways_placed        one email per web plan written: today's
--                              layaway-plan-created, or layaway-reserved in
--                              reserve mode. It was never counted before,
--                              which under-stated expected_total by every web
--                              plan; counting it is the correction.
--   web_reservations_confirmed one "ready — pay now" email per staff
--                              confirmation. ready_confirmed_by IS NOT NULL is
--                              what separates a staff confirmation from A1's
--                              creation-time stamp (which leaves it NULL), so
--                              with the switch off this key stays 0.
--   web_layaways_closed        layaway-expired (deposit lapsed),
--                              layaway-declined (can't supply) and the
--                              72-hour auto-cancel — one email per plan.
-- Cash "can't supply" and the cash 72-hour auto-cancel set cancelled_at
-- through terminate_web_order_atomic, so web_orders_closed already counts them.
-- The internal sales@ reminder is not a customer email and is not counted.
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
                              AND (co.cancelled_at >= v_since OR co.expired_at >= v_since)),
    -- RESERVE-FIRST (A2), 2026-09-24.
    'web_layaways_placed', (SELECT count(*) FROM layaway_accounts la JOIN customers c ON c.id = la.customer_id
                            WHERE la.created_at >= v_since AND la.source_channel = 'web' AND NOT c.is_test),
    'web_reservations_confirmed', (SELECT count(*) FROM cash_orders co JOIN customers c ON c.id = co.customer_id
                            WHERE co.source_channel = 'web' AND co.ready_confirmed_by IS NOT NULL
                              AND co.ready_confirmed_at >= v_since AND NOT c.is_test)
                          + (SELECT count(*) FROM layaway_accounts la JOIN customers c ON c.id = la.customer_id
                            WHERE la.source_channel = 'web' AND la.ready_confirmed_by IS NOT NULL
                              AND la.ready_confirmed_at >= v_since AND NOT c.is_test),
    'web_layaways_closed', (SELECT count(*) FROM layaway_accounts la JOIN customers c ON c.id = la.customer_id
                            WHERE la.source_channel = 'web' AND NOT c.is_test
                              AND (la.expired_at >= v_since
                                   OR EXISTS (SELECT 1 FROM audit_logs al
                                               WHERE al.entity_type = 'layaway_account' AND al.entity_id = la.id
                                                 AND al.action IN ('web_layaway_reservation_declined', 'web_layaway_reservation_expired')
                                                 AND al.created_at >= v_since)))
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

-- Grants unchanged (CREATE OR REPLACE keeps them); re-asserted so a rebuild
-- from migrations lands the same.
REVOKE ALL ON FUNCTION public.email_delivery_report(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.email_delivery_report(integer) TO authenticated, service_role;

-- ------------------------------------------------------ 4. the hourly sweep
-- Vault-backed like every other cron (CLAUDE.md CRON AUTH RULE). The function
-- does both halves in order: the 24-hour reminder to sales@, then the 72-hour
-- auto-cancel with the customer emails.
SELECT cron.schedule('web-reservation-sweep', '23 * * * *', $cron$
  SELECT net.http_post(
    url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/web-reservation-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')
    ),
    body := '{}'::jsonb
  );
$cron$);

-- ------------------------------------------------------------- 5. proof
DO $proof$
DECLARE
  v_expect CONSTANT text[][] := ARRAY[
    ARRAY['email_delivery_report',     '2cf40cc7318a751a8e8ea1c6d9e80371'],
    ARRAY['notify_account_created',    '78935701fd8e926195520128bb4e7455'],
    ARRAY['notify_cash_order_created', '44b7b024f05bd2d2dd0d164e991dfbc4']];
  v_md5 text;
  v_bad text := '';
  i     integer;
BEGIN
  FOR i IN 1 .. array_length(v_expect, 1) LOOP
    SELECT md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) INTO v_md5
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_expect[i][1];
    IF v_md5 IS DISTINCT FROM v_expect[i][2] THEN
      v_bad := v_bad || format(E'\n  %s: body md5 %s, expected %s', v_expect[i][1], v_md5, v_expect[i][2]);
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'reservation_reminded_at'
         AND table_name IN ('cash_orders', 'layaway_accounts')) <> 2 THEN
    v_bad := v_bad || E'\n  reservation_reminded_at missing on a table';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'web-reservation-sweep' AND schedule = '23 * * * *') THEN
    v_bad := v_bad || E'\n  cron job web-reservation-sweep not scheduled at 23 * * * *';
  END IF;
  IF v_bad <> '' THEN
    RAISE EXCEPTION E'STOP — Reserve-first A2 did not land as predicted; the migration is rolled back.%', v_bad;
  END IF;
END
$proof$;

-- ============================================================================
-- VERIFY (read-only), after apply:
--
-- SELECT p.proname, md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) AS body_md5
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('email_delivery_report', 'notify_account_created', 'notify_cash_order_created')
--  ORDER BY 1;
-- SELECT jobname, schedule FROM cron.job WHERE jobname = 'web-reservation-sweep';
-- SELECT (public.email_delivery_report(24))->'expected';   -- 15 keys, three new
-- ============================================================================