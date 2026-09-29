-- Website orders W2-7 (owner decision 2026-09-27, approved with W2-1..W2-12):
-- a WEB cash order that has received a real payment (web_released_at set —
-- website orders PR 3) is no longer auto-expired at its transfer deadline, and
-- no payment reminder is sent for it. It mirrors layaway, where
-- expire_web_layaway_atomic refuses once any payment exists: "unpaid by the
-- deadline" does not describe a part-paid order, and expiring one kept the
-- money and forced a refund decision.
--
-- Two live functions, each changed by ONE guard and nothing else. Both start
-- from their live bodies (Bug #280): the md5 of pg_get_functiondef is checked
-- first and the migration refuses to run on any other body.
--
--   expire_web_order_atomic(uuid)              live 3f6044fd1e267df17f526de4bb9278e4
--     + lock the order row; refuse 'part_paid_released' when web_released_at
--       is set. Every other refusal stays terminate_web_order_atomic's.
--   web_payment_reminder_eligible(text, uuid)  live 5809da9e0cd909103413258d508bc610
--     + cash branch: AND o.web_released_at IS NULL.
--
-- auto-expire-cash-orders also leaves such orders out of its candidate list
-- (edge function, same PR), so they never take a place in the run's quota;
-- this guard is what makes it true under a race.
--
-- CREATE OR REPLACE keeps each function's ACL (service_role only); nothing is
-- dropped. docs/WEB-ORDER-DRAFTS.md "W2-7".

BEGIN;

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.expire_web_order_atomic(uuid)'::regprocedure)) <> '3f6044fd1e267df17f526de4bb9278e4' THEN
    RAISE EXCEPTION 'expire_web_order_atomic is not the expected live body — start from live (Bug #280)';
  END IF;
  IF md5(pg_get_functiondef('public.web_payment_reminder_eligible(text,uuid)'::regprocedure)) <> '5809da9e0cd909103413258d508bc610' THEN
    RAISE EXCEPTION 'web_payment_reminder_eligible is not the expected live body — start from live (Bug #280)';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.expire_web_order_atomic(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- W2-7: a web order that has received a real payment is never expired by
  -- the clock. Row lock first, so a payment committing now is seen.
  PERFORM 1 FROM public.cash_orders WHERE id = p_order_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.cash_orders WHERE id = p_order_id AND web_released_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'part_paid_released');
  END IF;
  RETURN public.terminate_web_order_atomic(p_order_id, 'expired', NULL, NULL, NULL, NULL, NULL, 'system', false);
END $function$;

CREATE OR REPLACE FUNCTION public.web_payment_reminder_eligible(p_entity_type text, p_entity_id uuid)
 RETURNS TABLE(entity_type text, entity_id uuid, deadline timestamp with time zone, reference text, customer_id uuid, email text, is_test boolean, lang text, currency text, amount numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH e AS (
    SELECT 'cash_order'::text AS entity_type, o.id AS entity_id, o.transfer_due_at AS deadline,
           o.ready_confirmed_at, coalesce(o.web_reference, o.invoice_number::text) AS reference,
           o.customer_id, btrim(cu.email) AS email, coalesce(cu.is_test, false) AS is_test,
           CASE WHEN o.customer_lang = 'en' THEN 'en' ELSE 'ja' END AS lang,   -- pickLang: anything but 'en' is 'ja'
           o.currency::text AS currency, o.remaining_balance AS amount
      FROM public.cash_orders o
      JOIN public.customers cu ON cu.id = o.customer_id
     WHERE (p_entity_type IS NULL OR p_entity_type = 'cash_order')
       AND (p_entity_id IS NULL OR o.id = p_entity_id)
       AND o.source_channel = 'web'
       AND o.status::text = 'pending'
       AND o.payment_status = 'pending_transfer'
       AND o.ready_confirmed_at IS NOT NULL
       AND o.transfer_due_at IS NOT NULL
       AND o.remaining_balance > 0
       AND o.web_released_at IS NULL   -- W2-7: a part-paid web order is not chased
       AND NOT EXISTS (SELECT 1 FROM public.payment_submissions s
                        WHERE s.cash_order_id = o.id AND s.status::text IN ('submitted','under_review'))
    UNION ALL
    SELECT 'layaway'::text, a.id, a.transfer_due_at,
           a.ready_confirmed_at, coalesce(a.web_reference, a.invoice_number::text),
           a.customer_id, btrim(cu.email), coalesce(cu.is_test, false),
           'en'::text,                                   -- layaway emails are English only, always
           a.currency::text, a.downpayment_amount
      FROM public.layaway_accounts a
      JOIN public.customers cu ON cu.id = a.customer_id
     WHERE (p_entity_type IS NULL OR p_entity_type = 'layaway')
       AND (p_entity_id IS NULL OR a.id = p_entity_id)
       AND a.source_channel = 'web'
       AND a.status::text = 'active'
       AND a.ready_confirmed_at IS NOT NULL
       AND a.transfer_due_at IS NOT NULL
       AND coalesce(a.total_paid, 0) = 0
       AND a.downpayment_amount > 0
       AND NOT EXISTS (SELECT 1 FROM public.payment_submissions s
                        WHERE s.account_id = a.id AND s.status::text IN ('submitted','under_review'))
       AND NOT EXISTS (SELECT 1 FROM public.payment_submission_allocations psa
                         JOIN public.payment_submissions s ON s.id = psa.submission_id
                        WHERE psa.account_id = a.id AND s.status::text IN ('submitted','under_review'))
  )
  SELECT e.entity_type, e.entity_id, e.deadline, e.reference, e.customer_id, e.email, e.is_test,
         e.lang, e.currency, e.amount
    FROM e
   WHERE e.email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     -- the storefront test gate: a test customer only at an owner-readable address
     AND (NOT e.is_test OR lower(e.email) = 'chajewelsjapan@gmail.com' OR lower(e.email) LIKE '%@chajewelsjp.com')
     AND e.currency IN ('JPY','PHP')
     AND e.deadline > now() + interval '1 hour'
     AND e.deadline - now() <= CASE WHEN e.deadline - e.ready_confirmed_at <= interval '30 hours'
                                    THEN interval '6 hours' ELSE interval '24 hours' END
     AND NOT EXISTS (SELECT 1 FROM public.web_payment_reminders r
                      WHERE r.entity_type = e.entity_type AND r.entity_id = e.entity_id AND r.deadline = e.deadline)
     AND (SELECT count(*) FROM public.web_payment_reminders r
           WHERE r.entity_type = e.entity_type AND r.entity_id = e.entity_id) < 2
$function$;

COMMIT;
