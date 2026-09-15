CREATE OR REPLACE FUNCTION public.expire_web_layaway_atomic(
  p_account_id uuid,
  p_source     text DEFAULT 'system'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_status    text;
  v_invoice   text;
  v_web_ref   text;
  v_paid      numeric;
  v_due       timestamptz;
  v_restored  integer := 0;
  v_cancelled integer := 0;
  v_now       timestamptz := now();
BEGIN
  SELECT status::text, invoice_number, web_reference, total_paid, transfer_due_at
    INTO v_status, v_invoice, v_web_ref, v_paid, v_due
    FROM public.layaway_accounts
   WHERE id = p_account_id AND source_channel = 'web'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_web_layaway');
  END IF;
  IF v_status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_active', 'status', v_status);
  END IF;

  -- Money received, in either of the two places it can show: the cached total
  -- and the ledger itself. INVARIANT 1 makes payments authoritative, so both
  -- are checked and either one stops the expiry.
  IF coalesce(v_paid, 0) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_paid');
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments
              WHERE account_id = p_account_id AND voided_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'payment_exists');
  END IF;

  -- INVARIANT 12: an account with an unconfirmed submission does not move.
  -- The customer may have transferred and be waiting on review; expiring the
  -- plan out from under that submission would release the piece and strand
  -- their money.
  IF EXISTS (SELECT 1 FROM public.payment_submissions
              WHERE account_id = p_account_id
                AND status IN ('submitted', 'under_review')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'submission_pending');
  END IF;

  UPDATE public.layaway_accounts
     SET status     = 'cancelled',
         expired_at = v_now,
         updated_at = v_now,
         notes      = COALESCE(notes || E'\n', '')
                      || 'Expired ' || to_char(v_now AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI')
                      || ' PHT — deposit not received by the deadline'
                      || COALESCE(' (' || to_char(v_due AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI') || ' PHT)', '')
   WHERE id = p_account_id;

  UPDATE public.layaway_schedule
     SET status = 'cancelled', updated_at = v_now
   WHERE account_id = p_account_id AND status IN ('pending', 'overdue');
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  -- Stock back on sale, once, from the lines this plan was holding.
  WITH restored AS (
    UPDATE public.website_product_variants v
       SET stock_qty = v.stock_qty + i.quantity, updated_at = v_now
      FROM public.layaway_account_items i
     WHERE i.account_id = p_account_id AND v.id = i.variant_id
     RETURNING v.id
  )
  SELECT count(*) INTO v_restored FROM restored;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('layaway_account', p_account_id, 'web_layaway_expired',
          jsonb_build_object(
            'invoice_number', v_invoice, 'web_reference', v_web_ref,
            'transfer_due_at', v_due, 'expired_at', v_now,
            'schedule_rows_cancelled', v_cancelled, 'stock_lines_restored', v_restored,
            'source', p_source),
          auth.uid());

  RETURN jsonb_build_object('ok', true, 'web_reference', v_web_ref,
                            'invoice_number', v_invoice,
                            'schedule_rows_cancelled', v_cancelled,
                            'stock_lines_restored', v_restored);
END $$;

