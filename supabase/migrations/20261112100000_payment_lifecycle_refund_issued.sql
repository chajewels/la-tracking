-- Website payment lifecycle — addendum §9 #8 (owner directive 2026-10-06):
-- "Refund pending never followed up".
--
-- WHAT CHANGES
--   mark_web_order_refund_issued_atomic — the ONE writer that moves a CANCELLED
--   WEBSITE cash order's refund decision from 'refund_pending' to
--   'refund_issued' once staff have actually sent the money back. Before this,
--   cash_orders.refund_status was written only at cancel
--   (terminate_web_order_atomic — checked live 2026-10-06: the only function
--   whose body mentions refund_status), so "refund pending" stayed pending for
--   ever and the customer was never told the refund was made.
--
--   It locks the order, refuses unless it is a web order, cancelled, and its
--   refund decision is still refund_pending; records HOW and WHEN the refund
--   was sent (method bank_transfer | paidy | card | cash | other, a day), adds
--   staff's optional note to refund_note (kept, never overwritten), and writes
--   one audit_logs row (action refund_marked_issued). The amount reported is
--   the money actually received on the order — the same sum
--   terminate_web_order_atomic used for the refund decision (non-voided
--   cash_payments, LOYALTY- redemptions excluded: points are never refunded,
--   CLAUDE.md STORE CREDIT / LOYALTY rule 9).
--
--   It moves no money, writes no payment row and touches no other column.
--   The edge function mark-refund-issued calls it and then emails the
--   customer 「返金が完了しました」 (once per order).
--
-- FUNCTION RULES (CLAUDE.md, Bug #280): a NEW function (no live body to start
-- from); nothing existing is redefined. REVOKE/GRANT asserted below.
-- TS mirror of the refusal order: supabase/functions/_shared/refund-issued-rules.ts.

SET lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.mark_web_order_refund_issued_atomic(
  p_order_id uuid,
  p_user_id uuid,
  p_method text,
  p_refunded_on date,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_order   public.cash_orders%ROWTYPE;
  v_amount  numeric(12,2);
  v_note    text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_method  text := lower(btrim(COALESCE(p_method, '')));
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'user_identity_required');
  END IF;

  SELECT * INTO v_order FROM public.cash_orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_order.source_channel IS DISTINCT FROM 'web' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_web_order');
  END IF;
  IF v_order.status::text <> 'cancelled' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_cancelled', 'status', v_order.status::text);
  END IF;
  IF v_order.refund_status IS DISTINCT FROM 'refund_pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_refund_pending', 'refund_status', v_order.refund_status);
  END IF;
  IF v_method NOT IN ('bank_transfer', 'paidy', 'card', 'cash', 'other') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_method');
  END IF;
  IF p_refunded_on IS NULL OR p_refunded_on > (now() AT TIME ZONE 'Asia/Manila')::date THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_date');
  END IF;

  SELECT COALESCE(SUM(amount_paid), 0) INTO v_amount
    FROM public.cash_payments
   WHERE cash_order_id = p_order_id AND voided_at IS NULL
     AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';

  UPDATE public.cash_orders
     SET refund_status = 'refund_issued',
         refund_note = CASE
           WHEN v_note IS NULL THEN refund_note
           WHEN refund_note IS NULL OR btrim(refund_note) = '' THEN v_note
           ELSE refund_note || E'\n' || v_note END
   WHERE id = p_order_id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('cash_order', p_order_id, 'refund_marked_issued',
          jsonb_build_object('refund_status', 'refund_pending'),
          jsonb_build_object('refund_status', 'refund_issued', 'method', v_method, 'refunded_on', p_refunded_on,
                             'amount', v_amount, 'currency', v_order.currency::text, 'note', v_note,
                             'invoice_number', v_order.invoice_number, 'web_reference', v_order.web_reference),
          p_user_id);

  RETURN jsonb_build_object('ok', true, 'amount', v_amount, 'currency', v_order.currency::text,
                            'method', v_method, 'refunded_on', p_refunded_on,
                            'reference', COALESCE(v_order.web_reference, v_order.invoice_number));
END
$fn$;

REVOKE ALL ON FUNCTION public.mark_web_order_refund_issued_atomic(uuid, uuid, text, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_web_order_refund_issued_atomic(uuid, uuid, text, date, text) TO service_role;
COMMENT ON FUNCTION public.mark_web_order_refund_issued_atomic(uuid, uuid, text, date, text) IS
  'Addendum §9 #8: a cancelled WEB cash order whose refund decision is refund_pending → refund_issued once staff have sent the money back (method bank_transfer|paidy|card|cash|other, day, optional note appended to refund_note). Audited (refund_marked_issued). Moves no money. Called only by the mark-refund-issued edge function. service_role only.';
