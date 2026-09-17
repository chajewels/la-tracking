-- LIVE SNAPSHOT — captured read-only, NOT a migration. Do not apply this file.
--
--   function  : public.reactivate_web_layaway_atomic(p_account_id uuid, p_transfer_due_at timestamp with time zone, p_reason text, p_user_id uuid, p_source text)
--   captured  : 2026-09-17 05:50:22.096422+00 (SELECT pg_get_functiondef(oid))
--   md5       : ff6447f90e6fd38ebed7176a36abb9db
--   length    : 4922 bytes
--
-- The md5 and length above are of the text BELOW this header, which is the
-- pg_get_functiondef output byte for byte — header excluded. To re-verify:
--
--   SELECT md5(pg_get_functiondef(p.oid)), length(pg_get_functiondef(p.oid))
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'reactivate_web_layaway_atomic';
--
-- Captured for the live-vs-repo diff pass (DIFF-FINDINGS.md beside this file).
-- The repo is NOT evidence about live — see CLAUDE.md, "A SQL EDITOR CHANGE
-- THAT IS NEVER COMMITTED IS INVISIBLE TO EVERY LATER REBUILD".

CREATE OR REPLACE FUNCTION public.reactivate_web_layaway_atomic(p_account_id uuid, p_transfer_due_at timestamp with time zone, p_reason text, p_user_id uuid DEFAULT NULL::uuid, p_source text DEFAULT 'staff'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status    text;
  v_expired   timestamptz;
  v_invoice   text;
  v_web_ref   text;
  v_paid      numeric;
  v_old_due   timestamptz;
  v_short     jsonb;
  v_taken     integer := 0;
  v_restored  integer := 0;
  v_reason    text := btrim(coalesce(p_reason, ''));
  v_now       timestamptz := now();
BEGIN
  IF v_reason = '' THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  IF p_transfer_due_at IS NULL THEN
    RETURN jsonb_build_object('error', 'deadline_required');
  END IF;
  IF p_transfer_due_at <= v_now THEN
    RETURN jsonb_build_object('error', 'deadline_in_past', 'transfer_due_at', p_transfer_due_at);
  END IF;

  SELECT status::text, expired_at, invoice_number, web_reference, total_paid, transfer_due_at
    INTO v_status, v_expired, v_invoice, v_web_ref, v_paid, v_old_due
    FROM public.layaway_accounts
   WHERE id = p_account_id AND source_channel = 'web'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_web_layaway');
  END IF;

  IF v_status <> 'cancelled' OR v_expired IS NULL THEN
    RETURN jsonb_build_object('error', 'not_expired', 'status', v_status,
                              'expired_at', v_expired);
  END IF;

  IF coalesce(v_paid, 0) > 0 THEN
    RETURN jsonb_build_object('error', 'already_paid');
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments
              WHERE account_id = p_account_id AND voided_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'payment_exists');
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'variant_id', i.variant_id, 'title', i.title, 'sku', i.sku,
           'wanted', i.quantity, 'available', coalesce(v.stock_qty, 0)))
    INTO v_short
    FROM public.layaway_account_items i
    LEFT JOIN public.website_product_variants v ON v.id = i.variant_id
   WHERE i.account_id = p_account_id
     AND (v.id IS NULL OR v.stock_qty < i.quantity);
  IF v_short IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'out_of_stock', 'lines', v_short);
  END IF;

  WITH taken AS (
    UPDATE public.website_product_variants v
       SET stock_qty = v.stock_qty - i.quantity, updated_at = v_now
      FROM public.layaway_account_items i
     WHERE i.account_id = p_account_id AND v.id = i.variant_id
       AND v.stock_qty >= i.quantity
     RETURNING v.id
  )
  SELECT count(*) INTO v_taken FROM taken;

  SELECT count(*) INTO v_restored
    FROM public.layaway_account_items WHERE account_id = p_account_id;

  IF v_taken <> v_restored THEN
    RAISE EXCEPTION 'reactivate_web_layaway: took % of % lines — a piece sold during the reactivation; nothing applied', v_taken, v_restored;
  END IF;

  UPDATE public.layaway_accounts
     SET status          = 'active',
         expired_at      = NULL,
         transfer_due_at = p_transfer_due_at,
         updated_at      = v_now,
         notes           = COALESCE(notes || E'\n', '')
                           || 'Reactivated ' || to_char(v_now AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI')
                           || ' PHT — new deposit deadline '
                           || to_char(p_transfer_due_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI')
                           || ' PHT — ' || v_reason
   WHERE id = p_account_id;

  UPDATE public.layaway_schedule
     SET status = 'pending', updated_at = v_now
   WHERE account_id = p_account_id AND status = 'cancelled';
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  INSERT INTO public.audit_logs (entity_type, entity_id, action,
                                 old_value_json, new_value_json, performed_by_user_id)
  VALUES ('layaway_account', p_account_id, 'web_layaway_reactivated',
          jsonb_build_object('status', 'cancelled', 'expired_at', v_expired,
                             'transfer_due_at', v_old_due),
          jsonb_build_object('status', 'active', 'expired_at', NULL,
                             'transfer_due_at', p_transfer_due_at,
                             'invoice_number', v_invoice, 'web_reference', v_web_ref,
                             'schedule_rows_restored', v_restored,
                             'stock_lines_taken', v_taken,
                             'reason', v_reason, 'source', p_source),
          coalesce(p_user_id, auth.uid()));

  RETURN jsonb_build_object('ok', true,
                            'web_reference', v_web_ref,
                            'invoice_number', v_invoice,
                            'transfer_due_at', p_transfer_due_at,
                            'schedule_rows_restored', v_restored,
                            'stock_lines_taken', v_taken);
END $function$
