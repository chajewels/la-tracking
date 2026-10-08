-- 20261126100000_record_live_paidy_pr3_body.sql
-- RECORD-ONLY (Bug #280 rule): the body of expire_paidy_checkout_attempts
-- exactly as 20261125100000_paidy_pr3_recovery.sql leaves it on live
-- (expected md5 b6d33a3a3c60760c0ce040f18ae727f8 — the patch migration
-- self-checks it). Grants untouched. Re-running is a no-op.
CREATE OR REPLACE FUNCTION public.expire_paidy_checkout_attempts(p_cash_order_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.paidy_checkout_attempts a
     SET status = 'expired', ended_at = now(), end_reason = coalesce(a.end_reason, 'timeout'),
         -- PA04 (2026-10-08): the result is named honestly. verified_empty =
         -- the sweep read the window's payment back from Paidy and it holds
         -- nothing; unverified_no_id = the Hub never learned a payment id
         -- (callback and webhook both lost), so there was nothing to ask
         -- Paidy for — the lock is released on time alone and a late
         -- authorisation is still filed or released by the sweep.
         verification = CASE WHEN a.verified_empty_at IS NOT NULL THEN 'verified_empty' ELSE 'unverified_no_id' END
   WHERE a.status = 'open' AND a.expires_at <= now()
     AND (p_cash_order_id IS NULL OR a.cash_order_id = p_cash_order_id)
     -- A window that knows its payment id ends only once the sweep has
     -- verified with Paidy that it holds nothing (verified_empty_at).
     AND (a.paidy_payment_id IS NULL OR a.verified_empty_at IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1 FROM public.paidy_payments pp
        WHERE pp.cash_order_id = a.cash_order_id
          AND (pp.status = 'captured'
               OR (pp.status = 'authorized'
                   AND coalesce(pp.expires_at, pp.authorized_at + interval '30 days') > now()
                   AND NOT EXISTS (SELECT 1 FROM public.payment_submissions s
                                    WHERE s.paidy_payment_id = pp.id AND s.status IN ('rejected','cancelled')))))
     -- PA04: ORDER-CORRELATED guard — only an unprocessed, unparked
     -- notification that names THIS order, or one the sweep has not yet
     -- classified, holds the window. A stuck event on another order never
     -- hides every customer's other payment methods; parked events (other
     -- environment, unknown id) never hold anything.
     AND NOT EXISTS (
       SELECT 1 FROM public.paidy_webhook_events e
        WHERE e.processed_at IS NULL AND e.parked_reason IS NULL
          AND e.received_at >= a.started_at
          AND (e.cash_order_id = a.cash_order_id OR e.cash_order_id IS NULL));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$function$
;
