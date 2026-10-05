-- Square close-out QC fixes (2026-10-05) — owner: "Review and apply the
-- necessary corrections and acceptance for the full implementation of square
-- payments" (independent quality review QC01–QC15). Plan:
-- claude/square-closeout-qc-plan-2026-10-05.md; docs/SQUARE.md "QC fixes".
--
--   QC01  refunded / refunding captures are never credited in full
--         (finalize_cash_submission_atomic, record_square_refund flag);
--   QC02  a staff decision is recorded apart from the financial resolution
--         (decide_square_case + exception_decision columns);
--   QC03  card / Paidy ledger rows need captured provider evidence, and a card
--         receipt carries its Square payment id (unique);
--   QC04  provider receipts are immutable (no local void / restore / delete);
--   QC10  refund / dispute observations serialised and ordered in the upsert;
--   QC12  order total / discount / shipping and ledger amounts frozen while
--         Paidy or a card holds the order;
--   QC06/07/11  square_sync_state checkpoints, square_payments.reconciled_at,
--         square_ops_health();
--   QC13  square_settlement_report reports fees_missing (estimated net).
--
-- FUNCTION RULES (CLAUDE.md, Bug #280): every replaced body starts from the
-- LIVE body read 2026-10-05 (md5 of prosrc below). finalize, record_square_refund
-- and record_square_dispute are anchored in-place edits whose reversal was
-- checked to give the live text back; guard_cash_payment_paidy and
-- decide_square_case are rewritten (all old rules kept, listed in their
-- headers); square_settlement_report gains one output column (DROP + CREATE,
-- grants re-asserted); apply_square_payment_state gets one inserted lock (the
-- submission before the card row — review round 3 A). The guard below stops the migration if live has moved;
-- replaying it is a no-op (it accepts the already-patched md5).
-- NOT touched: reserve_square_attempt, terminate_web_order_atomic and
-- approve_redemption_atomic (md5-patched by 20261107100000).

DO $guard$
DECLARE r record; v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.finalize_cash_submission_atomic(uuid,uuid,text,date,text)', '15daada758f0ed1446975306b3f4d302', '0fa6a88f98bbbcb8875f822c230613c7'),
    ('public.decide_square_case(text,uuid,text,text)', '55477adcebeb4a979f75e62fc3a49b84', '983c3d19218a2687008677a83f42bbfb'),
    ('public.record_square_refund(text,text,text,bigint,text,timestamptz,timestamptz,jsonb)', '3ab1409bccc05e737c669e38cf77dd52', '05ea98ccb32a917d8ac5124281b21e9d'),
    ('public.record_square_dispute(text,text,text,text,bigint,timestamptz,timestamptz,timestamptz,jsonb)', '6cdfd6e652523fc4c5fc14a45b36b896', '9b1f4391292e7e7211eb58ce0a910e93'),
    ('public.guard_cash_payment_paidy()', '5e1c032aef7ca34e24161f47a0fb0b3f', '3b01fcbecf898942db632c741ed20f02'),
    ('public.square_settlement_report(date,date,boolean)', '768b886dbceb34641af4c4ac90e319ac', '4621668c61e6ac4601996b08c2a8e967'),
    ('public.apply_square_payment_state(text,text,bigint,bigint,text,text,timestamptz,timestamptz,timestamptz,text,text,text,text,jsonb,jsonb,text,uuid)', '086172c85efc69c4c9ad852dea0d6de8', '8ad64c42440eb9dea459007baea8a9df')) AS t(sig, live_md5, new_md5)
  LOOP
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(r.sig);
    IF v_md5 IS NULL THEN
      RAISE EXCEPTION 'STOP — % is not on live; nothing changed', r.sig;
    END IF;
    IF v_md5 NOT IN (r.live_md5, r.new_md5) THEN
      RAISE EXCEPTION 'STOP — % has moved on live (md5 %); re-read it before patching. Nothing changed.', r.sig, v_md5;
    END IF;
  END LOOP;
END
$guard$;

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------
-- QC02: a staff decision is stored apart from the financial resolution.
-- QC11: reconciled_at gives the hourly sweep a fair round-robin order.
ALTER TABLE public.square_payments
  ADD COLUMN IF NOT EXISTS exception_decision    text,
  ADD COLUMN IF NOT EXISTS exception_decided_at  timestamptz,
  ADD COLUMN IF NOT EXISTS exception_decided_by  uuid,
  ADD COLUMN IF NOT EXISTS reconciled_at         timestamptz;
COMMENT ON COLUMN public.square_payments.exception IS
  'Money that needs a person: captured_after_close, captured_unallocated, amount_mismatch, unfiled_hold, risk_high (Square rated it HIGH — the hold may or may not have been voided; status says which), void_unconfirmed, refunded_before_record (Square refunded / is refunding a capture the Hub has not recorded — QC01). exception_decision is what staff decided; exception_resolved_at is set only by verified evidence (the capture recorded on the ledger, a completed full refund, or Square showing the hold closed).';
COMMENT ON COLUMN public.square_payments.exception_decision IS
  'Last staff decision on the exception (decide_square_case): record_on_order | record_net_after_refund | refunded_in_square | voided_in_square | other. A decision never releases the order by itself (QC02).';
ALTER TABLE public.square_payments DROP CONSTRAINT IF EXISTS square_payments_exception_check;
ALTER TABLE public.square_payments ADD CONSTRAINT square_payments_exception_check
  CHECK (exception IS NULL OR exception IN ('captured_after_close','captured_unallocated','amount_mismatch',
                                            'unfiled_hold','risk_high','void_unconfirmed','refunded_before_record'));
CREATE INDEX IF NOT EXISTS idx_square_payments_reconcile ON public.square_payments (reconciled_at NULLS FIRST)
  WHERE status IN ('authorized','captured');

-- QC06/QC07/QC11: durable sync checkpoints and the last reconcile run.
CREATE TABLE IF NOT EXISTS public.square_sync_state (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.square_sync_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS square_sync_state_staff_select ON public.square_sync_state;
CREATE POLICY square_sync_state_staff_select ON public.square_sync_state
  FOR SELECT TO authenticated USING ((SELECT public.is_staff((SELECT auth.uid()))));
REVOKE ALL ON public.square_sync_state FROM anon, authenticated;
GRANT SELECT ON public.square_sync_state TO authenticated;
GRANT ALL ON public.square_sync_state TO service_role;
COMMENT ON TABLE public.square_sync_state IS
  'Square sync checkpoints (QC06/QC07) and the last square-reconcile run (QC11). Keys: events:<env> {through, cursor, window_start}, refunds:<env> {through}, disputes:<env> {through}, reconcile_last_run {at, status, report}, reconcile_last_ok {at}. Written by square-reconcile (service role) only.';

-- QC03: card receipts already on the ledger carry their Square payment id,
-- like Paidy receipts carry their capture id (the unique index then refuses
-- a second row for the same capture).
UPDATE public.cash_payments cp
   SET provider_capture_id = sp.square_payment_id
  FROM public.square_payments sp
 WHERE sp.cash_payment_id = cp.id AND cp.provider_capture_id IS NULL;

-- ---------------------------------------------------------------------------
-- 1b. finalize_cash_submission_atomic — QC01 refund check, QC03 provider_capture_id (live md5 15daada7…)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_cash_submission_atomic(p_submission_id uuid, p_reviewer_user_id uuid, p_reviewer_notes text, p_date_paid date, p_submitted_by_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sub        public.payment_submissions%ROWTYPE;
  v_order      public.cash_orders%ROWTYPE;
  v_payment    public.cash_payments%ROWTYPE;
  v_rec        public.paidy_payments%ROWTYPE;
  v_amount     numeric;
  v_captured   numeric;
  v_capture_id text;
  v_new_paid   numeric;
  v_new_remain numeric;
  v_full       boolean;
  v_status_before text;
  v_status_after  text;
  v_sq         public.square_payments%ROWTYPE;
  v_ref_done   bigint := 0;
  v_ref_open   integer := 0;
  v_net_path   boolean := false;
BEGIN
  SELECT * INTO v_sub FROM public.payment_submissions WHERE id = p_submission_id FOR UPDATE;
  IF v_sub.id IS NULL THEN RETURN jsonb_build_object('error', 'submission_not_found'); END IF;
  IF v_sub.cash_order_id IS NULL THEN RETURN jsonb_build_object('error', 'not_a_cash_submission'); END IF;

  SELECT * INTO v_order FROM public.cash_orders WHERE id = v_sub.cash_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('error', 'cash_order_not_found'); END IF;

  -- Idempotent: already recorded → return it, write nothing.
  IF v_sub.confirmed_payment_id IS NOT NULL THEN
    SELECT * INTO v_payment FROM public.cash_payments WHERE id = v_sub.confirmed_payment_id;
    RETURN jsonb_build_object('ok', true, 'outcome', 'already_recorded',
      'cash_payment', to_jsonb(v_payment), 'cash_order', to_jsonb(v_order),
      'new_total_paid', v_order.total_paid, 'new_remaining', v_order.remaining_balance,
      'is_fully_paid', v_order.remaining_balance <= 0.005, 'status_after', v_order.status::text);
  END IF;

  IF v_sub.status <> 'confirmed' THEN
    RETURN jsonb_build_object('error', 'not_claimed', 'status', v_sub.status::text);
  END IF;
  IF v_order.status::text IN ('cancelled', 'expired') THEN
    RETURN jsonb_build_object('error', 'order_closed', 'status', v_order.status::text);
  END IF;

  v_amount := v_sub.submitted_amount;
  IF v_amount IS NULL OR v_amount <= 0 THEN RETURN jsonb_build_object('error', 'bad_amount'); END IF;

  -- A Paidy payment is recorded only as Paidy's own capture, bound to THIS
  -- order, customer and exact amount, never refunded, never twice (R02/R14/R17).
  IF v_sub.paidy_payment_id IS NOT NULL OR v_sub.payment_method = 'paidy' THEN
    SELECT * INTO v_rec FROM public.paidy_payments WHERE id = v_sub.paidy_payment_id FOR UPDATE;
    IF v_rec.id IS NULL OR v_rec.status <> 'captured' THEN
      RETURN jsonb_build_object('error', 'paidy_not_captured');
    END IF;
    IF v_rec.cash_order_id <> v_order.id OR v_rec.customer_id IS DISTINCT FROM v_order.customer_id
       OR v_sub.customer_id IS DISTINCT FROM v_order.customer_id THEN
      RETURN jsonb_build_object('error', 'paidy_binding_mismatch');
    END IF;
    IF v_order.currency::text <> 'JPY' OR v_amount <> trunc(v_amount) OR v_rec.amount_jpy <> v_amount THEN
      RETURN jsonb_build_object('error', 'paidy_amount_mismatch', 'submitted', v_amount, 'authorized', v_rec.amount_jpy);
    END IF;
    SELECT coalesce(sum((c->>'amount')::numeric), 0) INTO v_captured
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_rec.last_payload->'captures') = 'array'
                                     THEN v_rec.last_payload->'captures' ELSE '[]'::jsonb END) c;
    IF v_captured <> v_amount THEN
      RETURN jsonb_build_object('error', 'paidy_amount_mismatch', 'submitted', v_amount, 'captured', v_captured);
    END IF;
    IF coalesce(v_rec.refund_jpy, 0) <> 0
       OR EXISTS (SELECT 1 FROM public.paidy_refunds WHERE paidy_payment_row = v_rec.id) THEN
      RETURN jsonb_build_object('error', 'paidy_refunded');
    END IF;
    v_capture_id := v_rec.capture_id;
    IF v_capture_id IS NULL THEN RETURN jsonb_build_object('error', 'paidy_not_captured'); END IF;
    IF EXISTS (SELECT 1 FROM public.cash_payments WHERE provider_capture_id = v_capture_id) THEN
      RETURN jsonb_build_object('error', 'capture_already_recorded');
    END IF;
  END IF;

  -- Square (2026-10-04, SQ08/SQ10/SQ12): card money is recorded only from a
  -- hold the Hub holds as CAPTURED, on this order and customer, in JPY, for
  -- exactly the captured integer yen, and only once (cash_payment_id). A card
  -- label without its hold, or a hold under another label, is refused.
  IF lower(coalesce(v_sub.payment_method, '')) = 'square' OR v_sub.square_payment_id IS NOT NULL THEN
    IF lower(coalesce(v_sub.payment_method, '')) <> 'square' OR v_sub.square_payment_id IS NULL THEN
      RETURN jsonb_build_object('error', 'square_link_mismatch');
    END IF;
    SELECT * INTO v_sq FROM public.square_payments WHERE id = v_sub.square_payment_id FOR UPDATE;
    IF v_sq.id IS NULL THEN RETURN jsonb_build_object('error', 'square_payment_missing'); END IF;
    IF v_sq.status <> 'captured' THEN
      RETURN jsonb_build_object('error', 'square_not_captured', 'square_status', v_sq.status);
    END IF;
    IF v_sq.cash_payment_id IS NOT NULL THEN
      RETURN jsonb_build_object('error', 'square_already_allocated', 'cash_payment_id', v_sq.cash_payment_id);
    END IF;
    IF v_sq.cash_order_id <> v_order.id OR v_sq.customer_id IS DISTINCT FROM v_order.customer_id
       OR v_sq.customer_id IS DISTINCT FROM v_sub.customer_id THEN
      RETURN jsonb_build_object('error', 'square_order_mismatch');
    END IF;
    IF v_order.currency::text <> 'JPY' OR coalesce(v_sq.currency, 'JPY') <> 'JPY' THEN
      RETURN jsonb_build_object('error', 'square_currency_mismatch');
    END IF;
    -- QC01 (2026-10-05): money Square has refunded, or is refunding, is never
    -- credited in full. Completed refunds are summed (and refunded_money on
    -- the payment as a floor); a refund neither COMPLETED nor FAILED/REJECTED
    -- is pending. The only way to record the net is an explicit admin/finance
    -- decision (decide_square_case record_net_after_refund), which files a
    -- 'card_net_after_refund' submission for exactly captured − completed.
    SELECT coalesce(sum(amount_jpy) FILTER (WHERE status = 'COMPLETED'), 0),
           count(*) FILTER (WHERE status NOT IN ('COMPLETED','FAILED','REJECTED'))
      INTO v_ref_done, v_ref_open
      FROM public.square_refunds WHERE square_payment_row = v_sq.id;
    v_ref_done := greatest(v_ref_done, coalesce(v_sq.refund_jpy, 0)::bigint);
    v_net_path := v_sub.submission_type = 'card_net_after_refund'
                  AND v_sq.exception_decision = 'record_net_after_refund';
    IF v_ref_open > 0 OR (v_ref_done > 0 AND NOT v_net_path) THEN
      UPDATE public.square_payments
         SET exception = 'refunded_before_record', exception_at = now(),
             exception_note = 'Square reports a refund on this capture (completed ¥' || v_ref_done
                              || ', pending refunds ' || v_ref_open || ') — it was not recorded in full',
             exception_resolved_at = NULL, updated_at = now()
       WHERE id = v_sq.id AND (exception IS DISTINCT FROM 'refunded_before_record' OR exception_resolved_at IS NOT NULL);
      RETURN jsonb_build_object('error', 'square_refunded', 'refunded_jpy', v_ref_done, 'pending_refunds', v_ref_open);
    END IF;
    IF v_sq.captured_amount_jpy IS NULL OR v_amount <> trunc(v_amount)
       OR v_amount <> (v_sq.captured_amount_jpy - CASE WHEN v_net_path THEN v_ref_done ELSE 0 END)::numeric THEN
      RETURN jsonb_build_object('error', 'square_amount_mismatch',
        'captured_amount_jpy', v_sq.captured_amount_jpy, 'submitted_amount', v_amount,
        'refunded_jpy', v_ref_done, 'net_after_refund', v_net_path);
    END IF;
    -- QC03: the ledger row carries Square's payment id (unique), so one
    -- capture can never be credited twice and the cash_payments guard can
    -- check the row against its captured payment.
    v_capture_id := v_sq.square_payment_id;
    IF EXISTS (SELECT 1 FROM public.cash_payments WHERE provider_capture_id = v_capture_id) THEN
      RETURN jsonb_build_object('error', 'capture_already_recorded');
    END IF;
  END IF;

  -- INVARIANT 4 on the LOCKED balance.
  IF v_amount > v_order.remaining_balance + 0.005 THEN
    RETURN jsonb_build_object('error', 'exceeds_remaining',
      'submitted_amount', v_amount, 'remaining_balance', v_order.remaining_balance);
  END IF;

  -- The ledger guard accepts a card / Paidy row only inside this recording
  -- (transaction-local marker = the capture being recorded; review #6).
  PERFORM set_config('app.provider_recording', coalesce(v_capture_id, ''), true);
  INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, date_paid, payment_method,
         reference_number, remarks, entered_by_user_id, submitted_by_type, submitted_by_name, provider_capture_id)
  VALUES (v_order.id, v_amount, v_order.currency, coalesce(p_date_paid, v_sub.payment_date),
          v_sub.payment_method, v_sub.reference_number, v_sub.notes, p_reviewer_user_id,
          p_submitted_by_type, v_sub.sender_name, v_capture_id)
  RETURNING * INTO v_payment;
  PERFORM set_config('app.provider_recording', '', true);

  -- The card capture is now credited: bind it to this ledger row (unique).
  IF v_sq.id IS NOT NULL THEN
    UPDATE public.square_payments
       SET cash_payment_id = v_payment.id,
           -- recording the capture is what resolves its open exception (QC02)
           exception_resolved_at = CASE WHEN exception IS NOT NULL AND exception_resolved_at IS NULL THEN now() ELSE exception_resolved_at END,
           exception_resolved_by = CASE WHEN exception IS NOT NULL AND exception_resolved_at IS NULL THEN p_reviewer_user_id ELSE exception_resolved_by END,
           updated_at = now()
     WHERE id = v_sq.id;
  END IF;

  v_status_before := v_order.status::text;
  v_new_paid   := round(v_order.total_paid + v_amount, 2);
  v_new_remain := greatest(0, round(v_order.remaining_balance - v_amount, 2));
  v_full       := v_new_remain <= 0.005;
  v_status_after := CASE WHEN v_full THEN 'completed' ELSE v_status_before END;

  UPDATE public.cash_orders
     SET total_paid = v_new_paid,
         remaining_balance = v_new_remain,
         status = CASE WHEN v_full THEN 'completed'::public.cash_order_status ELSE status END,
         completed_at = CASE WHEN v_full THEN now() ELSE completed_at END
   WHERE id = v_order.id
  RETURNING * INTO v_order;

  UPDATE public.payment_submissions
     SET status = 'confirmed',
         reviewer_user_id = p_reviewer_user_id,
         reviewer_notes = nullif(p_reviewer_notes, ''),
         confirmed_payment_id = v_payment.id,
         processing_started_at = NULL,
         updated_at = now()
   WHERE id = v_sub.id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('cash_payment_submission', v_sub.id, 'confirm',
          jsonb_build_object('status', 'claimed', 'order_status', v_status_before),
          jsonb_build_object('cash_payment_id', v_payment.id, 'amount_confirmed', v_amount,
            'remaining_after', v_new_remain, 'status_after', v_status_after,
            'date_paid', v_payment.date_paid, 'provider_capture_id', v_capture_id,
            'path', 'finalize_cash_submission_atomic'),
          p_reviewer_user_id);

  RETURN jsonb_build_object('ok', true, 'outcome', 'recorded',
    'cash_payment', to_jsonb(v_payment), 'cash_order', to_jsonb(v_order),
    'new_total_paid', v_new_paid, 'new_remaining', v_new_remain,
    'is_fully_paid', v_full, 'status_after', v_status_after);
END
$function$;

-- ---------------------------------------------------------------------------
-- 1c. record_square_refund — QC10 serialised + ordered upsert, QC01 flag (live md5 3ab1409b…)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_square_refund(p_refund_id text, p_square_payment_id text, p_status text, p_amount_jpy bigint, p_reason text, p_provider_created_at timestamp with time zone, p_provider_updated_at timestamp with time zone, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sq    public.square_payments%ROWTYPE;
  v_order public.cash_orders%ROWTYPE;
  v_old   public.square_refunds%ROWTYPE;
  v_new   public.square_refunds%ROWTYPE;
  v_st    text := upper(coalesce(p_status, 'PENDING'));
BEGIN
  -- Locked: a recording (finalize) and this refund serialise on the payment (review #4).
  SELECT * INTO v_sq FROM public.square_payments WHERE square_payment_id = p_square_payment_id FOR UPDATE;
  IF v_sq.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_payment'); END IF;
  SELECT * INTO v_order FROM public.cash_orders WHERE id = v_sq.cash_order_id;
  -- QC10 (2026-10-05): one writer per provider case at a time, including the
  -- very first insert (two first observations used to both pass the check).
  PERFORM pg_advisory_xact_lock(hashtextextended('square_refund:' || p_refund_id, 0));
  SELECT * INTO v_old FROM public.square_refunds WHERE square_refund_id = p_refund_id FOR UPDATE;
  IF v_old.id IS NOT NULL AND p_provider_updated_at IS NOT NULL AND v_old.provider_updated_at IS NOT NULL
     AND p_provider_updated_at < v_old.provider_updated_at THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'stale', true);
  END IF;
  -- A terminal provider state never goes back to an open one (QC10).
  IF v_old.id IS NOT NULL AND v_old.status IN ('COMPLETED','FAILED','REJECTED') AND v_st NOT IN ('COMPLETED','FAILED','REJECTED') THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'stale', true, 'terminal', v_old.status);
  END IF;
  INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id,
         amount_jpy, status, reason, provider_created_at, provider_updated_at, last_payload)
  VALUES (p_refund_id, v_sq.id, p_square_payment_id, v_sq.cash_order_id, greatest(coalesce(p_amount_jpy, 0), 0),
          v_st, left(p_reason, 500), p_provider_created_at, p_provider_updated_at, p_payload)
  ON CONFLICT (square_refund_id) DO UPDATE
     SET status = EXCLUDED.status, amount_jpy = EXCLUDED.amount_jpy, reason = coalesce(EXCLUDED.reason, square_refunds.reason),
         provider_updated_at = coalesce(EXCLUDED.provider_updated_at, square_refunds.provider_updated_at),
         last_payload = EXCLUDED.last_payload, updated_at = now()
   WHERE square_refunds.provider_updated_at IS NULL OR EXCLUDED.provider_updated_at IS NULL
      OR EXCLUDED.provider_updated_at >= square_refunds.provider_updated_at
  RETURNING * INTO v_new;
  IF v_new.id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'stale', true);
  END IF;
  -- QC01: a refund (not failed) on captured card money the Hub has not
  -- recorded is flagged, so it is never recorded in full by mistake.
  IF v_st NOT IN ('FAILED','REJECTED') AND v_sq.status = 'captured' AND v_sq.cash_payment_id IS NULL THEN
    UPDATE public.square_payments
       SET exception = 'refunded_before_record', exception_at = now(),
           exception_note = 'Square refund ' || p_refund_id || ' (' || v_st || ') on a capture the Hub has not recorded',
           updated_at = now()
     WHERE id = v_sq.id AND status = 'captured' AND cash_payment_id IS NULL
       AND exception_resolved_at IS NULL AND exception IS DISTINCT FROM 'refunded_before_record';
  END IF;
  IF v_old.id IS NULL OR v_old.status IS DISTINCT FROM v_new.status THEN
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    VALUES ('card_refunded',
            CASE v_st WHEN 'COMPLETED' THEN 'Card refund completed' WHEN 'FAILED' THEN 'Card refund FAILED'
                      WHEN 'REJECTED' THEN 'Card refund REJECTED' ELSE 'Card refund started' END,
            coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · ¥' || to_char(v_new.amount_jpy, 'FM999,999,999')
              || ' refund ' || lower(v_st)
              || CASE WHEN v_st IN ('FAILED','REJECTED') THEN ' — the customer has NOT been paid back.'
                      ELSE '. Record the decision on the order (Website → Card payments → Refunds).' END,
            v_order.customer_id, v_order.invoice_number,
            jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                               'refund_id', p_refund_id, 'status', v_st, 'test', v_sq.test));
    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json)
    VALUES ('square_refund', v_new.id, 'square_refund_state', jsonb_build_object('status', v_old.status),
            jsonb_build_object('status', v_st, 'amount_jpy', v_new.amount_jpy, 'refund_id', p_refund_id));
  END IF;
  RETURN jsonb_build_object('ok', true, 'changed', v_old.id IS NULL OR v_old.status IS DISTINCT FROM v_new.status,
                            'refund', to_jsonb(v_new));
END
$function$;

-- ---------------------------------------------------------------------------
-- 1d. record_square_dispute — QC10 serialised + ordered upsert (live md5 6cdfd6e6…)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_square_dispute(p_dispute_id text, p_square_payment_id text, p_state text, p_reason text, p_amount_jpy bigint, p_due_at timestamp with time zone, p_provider_created_at timestamp with time zone, p_provider_updated_at timestamp with time zone, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sq    public.square_payments%ROWTYPE;
  v_order public.cash_orders%ROWTYPE;
  v_old   public.square_disputes%ROWTYPE;
  v_new   public.square_disputes%ROWTYPE;
  v_st    text := upper(coalesce(p_state, 'UNKNOWN'));
BEGIN
  SELECT * INTO v_sq FROM public.square_payments WHERE square_payment_id = p_square_payment_id;
  IF v_sq.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_payment'); END IF;
  SELECT * INTO v_order FROM public.cash_orders WHERE id = v_sq.cash_order_id;
  -- QC10 (2026-10-05): one writer per provider case at a time, including the
  -- very first insert (two first observations used to both pass the check).
  PERFORM pg_advisory_xact_lock(hashtextextended('square_dispute:' || p_dispute_id, 0));
  SELECT * INTO v_old FROM public.square_disputes WHERE square_dispute_id = p_dispute_id FOR UPDATE;
  IF v_old.id IS NOT NULL AND p_provider_updated_at IS NOT NULL AND v_old.provider_updated_at IS NOT NULL
     AND p_provider_updated_at < v_old.provider_updated_at THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'stale', true);
  END IF;
  -- A terminal provider state never goes back to an open one (QC10).
  IF v_old.id IS NOT NULL AND v_old.state IN ('WON','LOST','ACCEPTED') AND v_st NOT IN ('WON','LOST','ACCEPTED') THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'stale', true, 'terminal', v_old.state);
  END IF;
  INSERT INTO public.square_disputes (square_dispute_id, square_payment_row, square_payment_id, cash_order_id,
         amount_jpy, state, reason, due_at, provider_created_at, provider_updated_at, last_payload)
  VALUES (p_dispute_id, v_sq.id, p_square_payment_id, v_sq.cash_order_id, p_amount_jpy, v_st, left(p_reason, 200),
          p_due_at, p_provider_created_at, p_provider_updated_at, p_payload)
  ON CONFLICT (square_dispute_id) DO UPDATE
     SET state = EXCLUDED.state, amount_jpy = coalesce(EXCLUDED.amount_jpy, square_disputes.amount_jpy),
         reason = coalesce(EXCLUDED.reason, square_disputes.reason), due_at = coalesce(EXCLUDED.due_at, square_disputes.due_at),
         provider_updated_at = coalesce(EXCLUDED.provider_updated_at, square_disputes.provider_updated_at),
         last_payload = EXCLUDED.last_payload, updated_at = now()
   WHERE square_disputes.provider_updated_at IS NULL OR EXCLUDED.provider_updated_at IS NULL
      OR EXCLUDED.provider_updated_at >= square_disputes.provider_updated_at
  RETURNING * INTO v_new;
  IF v_new.id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'stale', true);
  END IF;
  -- The first dispute also stamps the hold (legacy columns kept for the UI).
  UPDATE public.square_payments SET disputed_at = coalesce(disputed_at, now()), dispute_id = coalesce(dispute_id, p_dispute_id),
         updated_at = now()
   WHERE id = v_sq.id AND disputed_at IS NULL;
  IF v_old.id IS NULL OR v_old.state IS DISTINCT FROM v_new.state THEN
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    VALUES (CASE WHEN v_old.id IS NULL THEN 'card_dispute_opened' ELSE 'card_dispute_updated' END,
            CASE WHEN v_old.id IS NULL THEN 'Card dispute opened' ELSE 'Card dispute ' || lower(v_st) END,
            coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · '
              || coalesce('¥' || to_char(v_new.amount_jpy, 'FM999,999,999'), '') || ' · ' || coalesce(v_new.reason, 'no reason given')
              || ' · state ' || v_st
              || coalesce(' · evidence due ' || to_char(v_new.due_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') || ' JST', '')
              || '. Evidence is submitted in the Square Dashboard; record the decision in Website → Card payments.',
            v_order.customer_id, v_order.invoice_number,
            jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                               'dispute_id', p_dispute_id, 'state', v_st, 'due_at', v_new.due_at, 'test', v_sq.test));
    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json)
    VALUES ('square_dispute', v_new.id, 'square_dispute_state', jsonb_build_object('state', v_old.state),
            jsonb_build_object('state', v_st, 'due_at', v_new.due_at, 'dispute_id', p_dispute_id));
  END IF;
  RETURN jsonb_build_object('ok', true, 'changed', v_old.id IS NULL OR v_old.state IS DISTINCT FROM v_new.state,
                            'dispute', to_jsonb(v_new));
END
$function$;

-- ---------------------------------------------------------------------------
-- 2. guard_cash_payment_paidy — provider binding on the ledger (QC03, QC04,
--    QC12). Full replace of the live body (md5 5e1c032a…, read 2026-10-05):
--    every rule of the old body is kept (Paidy lock, card lock, card's own
--    recording) and these are added:
--      * a provider row ('square' / 'paidy' label, or any provider_capture_id)
--        is inserted only with matching CAPTURED provider evidence — same
--        order, exact yen, JPY, not refunded, not already recorded — so a
--        label alone can never manufacture card or Paidy credit;
--      * once written, a provider row is IMMUTABLE: no void, un-void, amount /
--        currency / order / method / capture-id change, no delete. Money that
--        goes back to the customer is a refund in the provider's dashboard,
--        recorded beside the receipt (square_refunds / paidy_refunds), never a
--        local void that reopens the invoice while the provider has the money;
--      * an amount or currency change on any live row counts like new money,
--        so it is refused while Paidy or a card holds the order (QC12).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_cash_payment_paidy()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_lock      text;
  v_old_prov  boolean := false;
  v_new_prov  boolean := false;
  v_method    text;
  v_done      bigint;
  v_open      integer;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    v_old_prov := lower(coalesce(OLD.payment_method, '')) IN ('square','paidy') OR OLD.provider_capture_id IS NOT NULL;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    v_new_prov := lower(coalesce(NEW.payment_method, '')) IN ('square','paidy') OR NEW.provider_capture_id IS NOT NULL;
  END IF;

  -- A provider receipt is never deleted.
  IF TG_OP = 'DELETE' THEN
    IF v_old_prov THEN
      RAISE EXCEPTION 'provider_payment_immutable: a card or Paidy receipt cannot be deleted — refund it in the provider''s dashboard; the refund is recorded beside the receipt'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  -- A provider receipt keeps its money facts for good.
  IF TG_OP = 'UPDATE' AND v_old_prov THEN
    IF NEW.amount_paid IS DISTINCT FROM OLD.amount_paid
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.cash_order_id IS DISTINCT FROM OLD.cash_order_id
       OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
       OR NEW.provider_capture_id IS DISTINCT FROM OLD.provider_capture_id
       OR NEW.voided_at IS DISTINCT FROM OLD.voided_at THEN
      RAISE EXCEPTION 'provider_payment_immutable: a card or Paidy receipt cannot be voided, restored or changed — refund it in the provider''s dashboard; the refund is recorded beside the receipt'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- Nothing becomes a provider row after it was written.
  IF TG_OP = 'UPDATE' AND v_new_prov THEN
    RAISE EXCEPTION 'provider_evidence_required: an existing payment cannot be relabelled as a card or Paidy payment'
      USING ERRCODE = 'P0001';
  END IF;

  -- A new provider row needs its captured provider payment (QC03).
  IF TG_OP = 'INSERT' AND v_new_prov THEN
    v_method := lower(coalesce(NEW.payment_method, ''));
    IF NEW.cash_order_id IS NULL OR NEW.voided_at IS NOT NULL OR NEW.provider_capture_id IS NULL
       OR v_method NOT IN ('square','paidy')
       -- Only inside finalize_cash_submission_atomic, which sets this
       -- transaction-local marker to the capture it is recording: a direct
       -- INSERT, even with real evidence, would credit nothing on the order
       -- and bind nothing, leaving the money stuck (review #6).
       OR NEW.provider_capture_id IS DISTINCT FROM nullif(current_setting('app.provider_recording', true), '') THEN
      RAISE EXCEPTION 'provider_evidence_required: a card or Paidy payment is written only by the Hub''s own recording, bound to its captured provider payment'
        USING ERRCODE = 'P0001';
    END IF;
    PERFORM 1 FROM public.cash_orders WHERE id = NEW.cash_order_id FOR UPDATE;
    IF v_method = 'square' THEN
      SELECT coalesce(sum(r.amount_jpy) FILTER (WHERE r.status = 'COMPLETED'), 0),
             count(*) FILTER (WHERE r.status NOT IN ('COMPLETED','FAILED','REJECTED'))
        INTO v_done, v_open
        FROM public.square_payments sp JOIN public.square_refunds r ON r.square_payment_row = sp.id
       WHERE sp.square_payment_id = NEW.provider_capture_id;
      IF NOT EXISTS (
           SELECT 1 FROM public.square_payments sp
            WHERE sp.square_payment_id = NEW.provider_capture_id
              AND sp.cash_order_id = NEW.cash_order_id
              AND sp.status = 'captured' AND sp.cash_payment_id IS NULL
              AND coalesce(sp.currency, 'JPY') = 'JPY' AND NEW.currency::text = 'JPY'
              AND sp.captured_amount_jpy IS NOT NULL
              AND v_open = 0
              AND NEW.amount_paid = (sp.captured_amount_jpy - greatest(v_done, coalesce(sp.refund_jpy, 0)::bigint))::numeric
              AND NEW.amount_paid > 0) THEN
        RAISE EXCEPTION 'provider_evidence_required: no captured, unrecorded card payment % on this order for exactly this amount', NEW.provider_capture_id
          USING ERRCODE = 'P0001';
      END IF;
      v_lock := public.cash_order_payment_lock(NEW.cash_order_id);
      IF v_lock LIKE 'paidy%' THEN
        RAISE EXCEPTION 'paidy_in_progress: % — this order is being paid with Paidy. No other payment, store credit or loyalty discount can be added until staff Reject the Paidy payment.', v_lock
          USING ERRCODE = 'P0001';
      END IF;
    ELSE
      IF NOT EXISTS (
           SELECT 1 FROM public.paidy_payments pp
            WHERE pp.capture_id = NEW.provider_capture_id
              AND pp.cash_order_id = NEW.cash_order_id
              AND pp.status = 'captured'
              AND NEW.currency::text = 'JPY' AND pp.amount_jpy = NEW.amount_paid
              AND coalesce(pp.refund_jpy, 0) = 0
              AND NOT EXISTS (SELECT 1 FROM public.paidy_refunds pr WHERE pr.paidy_payment_row = pp.id)) THEN
        RAISE EXCEPTION 'provider_evidence_required: no captured, unrefunded Paidy payment % on this order for exactly this amount', NEW.provider_capture_id
          USING ERRCODE = 'P0001';
      END IF;
      IF public.square_order_unresolved(NEW.cash_order_id) THEN
        RAISE EXCEPTION 'card_payment_unresolved — this order has a card payment waiting for Confirm or Reject. No other payment, store credit or loyalty discount can be added until staff Confirm or Reject the card payment.'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Ordinary (non-provider) money: only what would newly count on a cash
  -- order is checked — a live insert, an un-void, a live row moved onto
  -- another order, a relabel, or an amount / currency change on a live row.
  IF NEW.cash_order_id IS NULL OR NEW.voided_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.voided_at IS NULL
     AND OLD.cash_order_id IS NOT DISTINCT FROM NEW.cash_order_id
     AND OLD.payment_method IS NOT DISTINCT FROM NEW.payment_method
     AND OLD.amount_paid IS NOT DISTINCT FROM NEW.amount_paid
     AND OLD.currency IS NOT DISTINCT FROM NEW.currency THEN
    RETURN NEW;
  END IF;
  -- Serialise with the Paidy and card writers, which lock the order row too.
  PERFORM 1 FROM public.cash_orders WHERE id = NEW.cash_order_id FOR UPDATE;
  v_lock := public.cash_order_payment_lock(NEW.cash_order_id);
  IF v_lock LIKE 'paidy%' THEN
    RAISE EXCEPTION 'paidy_in_progress: % — this order is being paid with Paidy. No other payment, store credit or loyalty discount can be added until staff Reject the Paidy payment.', v_lock
      USING ERRCODE = 'P0001';
  END IF;
  IF v_lock = 'card_payment_unresolved' THEN
    RAISE EXCEPTION 'card_payment_unresolved — this order has a card payment waiting for Confirm or Reject. No other payment, store credit or loyalty discount can be added until staff Confirm or Reject the card payment.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_cash_payment_paidy() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.guard_cash_payment_paidy() IS
  'Ledger guard on cash_payments (owner 2026-10-04; QC03/QC04/QC12 2026-10-05). A card/Paidy row (label or provider_capture_id) is inserted only with matching captured provider evidence and is then immutable (no void, restore, change or delete — refunds are recorded beside the receipt). Ordinary money (insert, un-void, move, relabel, amount/currency change) is refused while Paidy holds the order (paidy_*) or a card payment is unresolved (card_payment_unresolved).';

DROP TRIGGER IF EXISTS trg_guard_cash_payment_paidy ON public.cash_payments;
CREATE TRIGGER trg_guard_cash_payment_paidy
  BEFORE INSERT OR UPDATE OR DELETE ON public.cash_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_cash_payment_paidy();

-- ---------------------------------------------------------------------------
-- 3. guard_cash_order_amount_during_hold (QC12): the order's money facts do
--    not change while Paidy or a card holds the order — the provider holds a
--    fixed amount. Amend by Reject (void) and paying again.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_cash_order_amount_during_hold()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_lock text;
BEGIN
  IF NEW.total_amount IS NOT DISTINCT FROM OLD.total_amount
     AND NEW.currency IS NOT DISTINCT FROM OLD.currency
     AND NEW.discount_amount IS NOT DISTINCT FROM OLD.discount_amount
     AND NEW.discount_value IS NOT DISTINCT FROM OLD.discount_value
     AND NEW.discount_type IS NOT DISTINCT FROM OLD.discount_type
     AND NEW.shipping_fee IS NOT DISTINCT FROM OLD.shipping_fee THEN
    RETURN NEW;
  END IF;
  v_lock := public.cash_order_payment_lock(NEW.id);
  IF v_lock LIKE 'paidy%' THEN
    RAISE EXCEPTION 'paidy_in_progress: % — this order is being paid with Paidy, so its total, discount and shipping cannot change. Reject the Paidy payment first.', v_lock
      USING ERRCODE = 'P0001';
  END IF;
  IF v_lock = 'card_payment_unresolved' THEN
    RAISE EXCEPTION 'card_payment_unresolved — this order has a card payment waiting for Confirm or Reject, so its total, discount and shipping cannot change. Reject the card payment first (the hold is voided), then change the order.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_cash_order_amount_during_hold() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_guard_cash_order_amount_during_hold ON public.cash_orders;
CREATE TRIGGER trg_guard_cash_order_amount_during_hold
  BEFORE UPDATE OF total_amount, currency, discount_amount, discount_value, discount_type, shipping_fee ON public.cash_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_cash_order_amount_during_hold();

-- ---------------------------------------------------------------------------
-- 4. decide_square_case — a decision is recorded; money is resolved only by
--    provider or ledger evidence (QC02). Full replace of the live body
--    (md5 55477adc…).
--    exception decisions (admin / finance, note required):
--      record_on_order (alias recorded_manually) — hands the capture to the
--          normal Confirm path: a claimed card submission is created (or the
--          existing one returned); review-payment-submission reads Square and
--          the finalizer records it. The gate opens when the ledger row exists.
--      record_net_after_refund — completed partial refund, none pending: a
--          claimed submission for exactly captured − completed refunds.
--      refunded_in_square — resolves only when COMPLETED refunds cover the
--          capture and none is pending.
--      voided_in_square — resolves only when Square shows the hold closed.
--      other — a note; resolves nothing.
--    refund / dispute decisions must match the provider state.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.decide_square_case(p_kind text, p_id uuid, p_decision text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_n        int := 0;
  v_dec      text := btrim(coalesce(p_decision, ''));
  v_sq       public.square_payments%ROWTYPE;
  v_order    public.cash_orders%ROWTYPE;
  v_rf       public.square_refunds%ROWTYPE;
  v_dp       public.square_disputes%ROWTYPE;
  v_done     bigint := 0;
  v_open     integer := 0;
  v_claim    uuid;
  v_busy     boolean := false;
  v_sub      uuid;
  v_amount   bigint;
  v_resolved boolean := false;
  v_err      text := NULL;
BEGIN
  IF v_uid IS NULL OR NOT public.is_staff(v_uid) THEN
    RAISE EXCEPTION 'not_staff' USING ERRCODE = '42501';
  END IF;
  IF v_dec = '' THEN RETURN jsonb_build_object('error', 'decision_required'); END IF;

  IF p_kind = 'refund' THEN
    IF v_dec NOT IN ('order_cancelled_refunded','partial_refund_order_kept','refund_failed_followed_up','other') THEN
      RETURN jsonb_build_object('error', 'bad_decision');
    END IF;
    SELECT * INTO v_rf FROM public.square_refunds WHERE id = p_id FOR UPDATE;
    IF v_rf.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    -- A staff decision is an annotation of what Square reports (QC02).
    IF (v_dec IN ('order_cancelled_refunded','partial_refund_order_kept') AND v_rf.status <> 'COMPLETED')
       OR (v_dec = 'refund_failed_followed_up' AND v_rf.status NOT IN ('FAILED','REJECTED')) THEN
      RETURN jsonb_build_object('error', 'state_mismatch', 'square_status', v_rf.status);
    END IF;
    UPDATE public.square_refunds SET decision = v_dec, decision_note = left(p_note, 1000), decided_at = now(),
           decided_by = v_uid, updated_at = now() WHERE id = p_id;
  ELSIF p_kind = 'dispute' THEN
    IF v_dec NOT IN ('evidence_submitted','accepted','won','lost','other') THEN
      RETURN jsonb_build_object('error', 'bad_decision');
    END IF;
    SELECT * INTO v_dp FROM public.square_disputes WHERE id = p_id FOR UPDATE;
    IF v_dp.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    IF (v_dec = 'won' AND v_dp.state <> 'WON') OR (v_dec = 'lost' AND v_dp.state <> 'LOST')
       OR (v_dec = 'accepted' AND v_dp.state <> 'ACCEPTED')
       OR (v_dec = 'evidence_submitted' AND v_dp.state IN ('WON','LOST','ACCEPTED')) THEN
      RETURN jsonb_build_object('error', 'state_mismatch', 'square_state', v_dp.state);
    END IF;
    UPDATE public.square_disputes SET decision = v_dec, decision_note = left(p_note, 1000), decided_at = now(),
           decided_by = v_uid, updated_at = now() WHERE id = p_id;
  ELSIF p_kind = 'exception' THEN
    IF v_dec = 'recorded_manually' THEN v_dec := 'record_on_order'; END IF;
    IF v_dec NOT IN ('record_on_order','record_net_after_refund','refunded_in_square','voided_in_square','other') THEN
      RETURN jsonb_build_object('error', 'bad_decision');
    END IF;
    IF coalesce(btrim(p_note), '') = '' THEN RETURN jsonb_build_object('error', 'note_required'); END IF;
    -- Card money decisions: admin or finance only (CLAUDE.md, Bug #170).
    IF NOT (public.has_role(v_uid, 'admin') OR public.has_role(v_uid, 'finance')) THEN
      RETURN jsonb_build_object('error', 'not_permitted');
    END IF;
    -- Locks in finalize_cash_submission_atomic's order — the claimed
    -- submission, then the order, then the card row — so the two never
    -- deadlock (review #5).
    SELECT id INTO v_claim FROM public.payment_submissions
     WHERE square_payment_id = p_id AND status = 'confirmed' AND confirmed_payment_id IS NULL
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
    SELECT * INTO v_order FROM public.cash_orders
     WHERE id = (SELECT cash_order_id FROM public.square_payments WHERE id = p_id) FOR UPDATE;
    SELECT * INTO v_sq FROM public.square_payments WHERE id = p_id FOR UPDATE;
    -- A Confirm still inside its 5-minute lease (review-payment-submission's
    -- claim, PAIDY_CONFIRM_LEASE_MS) is never pulled from under it (review B).
    SELECT coalesce(processing_started_at > now() - interval '5 minutes', false) INTO v_busy
      FROM public.payment_submissions WHERE id = v_claim;
    v_busy := coalesce(v_busy, false);
    IF v_sq.id IS NULL OR NOT (v_sq.exception IS NOT NULL OR (v_sq.status = 'captured' AND v_sq.cash_payment_id IS NULL)) THEN
      RETURN jsonb_build_object('error', 'not_found');
    END IF;
    SELECT coalesce(sum(amount_jpy) FILTER (WHERE status = 'COMPLETED'), 0),
           count(*) FILTER (WHERE status NOT IN ('COMPLETED','FAILED','REJECTED'))
      INTO v_done, v_open
      FROM public.square_refunds WHERE square_payment_row = v_sq.id;
    v_done := greatest(v_done, coalesce(v_sq.refund_jpy, 0)::bigint);

    -- The decision itself is always recorded (QC02: decision ≠ resolution).
    UPDATE public.square_payments
       SET exception_decision = v_dec, exception_decided_at = now(), exception_decided_by = v_uid,
           exception_note = left(coalesce(exception_note, '') || ' | decision: ' || v_dec || ' — ' || p_note, 1000),
           updated_at = now()
     WHERE id = v_sq.id;

    IF v_dec = 'other' THEN
      NULL; -- a note: nothing is resolved

    ELSIF v_dec = 'voided_in_square' THEN
      IF v_sq.status IN ('voided','expired','failed','rejected') THEN v_resolved := true;
      ELSE v_err := 'void_not_verified'; END IF;

    ELSIF v_dec = 'refunded_in_square' THEN
      IF v_busy THEN
        v_err := 'confirm_in_progress';
      ELSIF v_sq.status = 'captured' AND v_open = 0 AND v_sq.captured_amount_jpy IS NOT NULL
         AND v_done >= v_sq.captured_amount_jpy THEN
        v_resolved := true;
        -- The claimed Confirm can never record refunded money: close it.
        UPDATE public.payment_submissions
           SET status = 'rejected', processing_started_at = NULL, updated_at = now(),
               reviewer_notes = left('Card capture refunded in full in Square (verified): ' || p_note, 1000)
         WHERE id = v_claim;
      ELSE
        v_err := 'refund_not_verified';
      END IF;

    ELSE -- record_on_order / record_net_after_refund
      IF v_sq.status <> 'captured' OR v_sq.cash_payment_id IS NOT NULL THEN
        v_err := CASE WHEN v_sq.cash_payment_id IS NOT NULL THEN 'already_recorded' ELSE 'not_captured' END;
      ELSIF v_order.status::text IN ('cancelled','expired') THEN
        v_err := 'order_closed';
      ELSIF v_dec = 'record_on_order' AND (v_done > 0 OR v_open > 0) THEN
        v_err := 'square_refunded';
      ELSIF v_dec = 'record_net_after_refund' AND v_open > 0 THEN
        v_err := 'refund_pending';
      ELSIF v_dec = 'record_net_after_refund' AND (v_done <= 0 OR v_done >= v_sq.captured_amount_jpy) THEN
        v_err := CASE WHEN v_done <= 0 THEN 'no_refund' ELSE 'fully_refunded' END;
      ELSE
        v_amount := v_sq.captured_amount_jpy - CASE WHEN v_dec = 'record_net_after_refund' THEN v_done ELSE 0 END;
        IF v_amount > v_order.remaining_balance + 0.005 THEN
          v_err := 'exceeds_remaining';
        ELSIF v_dec = 'record_on_order' AND v_claim IS NOT NULL
              AND (SELECT submitted_amount = v_amount AND submission_type = 'cash_payment'
                     FROM public.payment_submissions WHERE id = v_claim) THEN
          v_sub := v_claim; -- the existing claimed Confirm is exactly this capture
        ELSIF v_busy THEN
          v_err := 'confirm_in_progress'; -- never replace a Confirm that is running
        ELSE
          IF v_claim IS NOT NULL THEN
            UPDATE public.payment_submissions
               SET status = 'rejected', processing_started_at = NULL, updated_at = now(),
                   reviewer_notes = left('Replaced by a recording for the captured amount (staff decision): ' || p_note, 1000)
             WHERE id = v_claim;
          END IF;
          INSERT INTO public.payment_submissions (customer_id, cash_order_id, submitted_amount, payment_date, payment_method,
                 reference_number, sender_name, notes, status, reviewer_user_id, square_payment_id, submission_type)
          VALUES (coalesce(v_sq.customer_id, v_order.customer_id), v_order.id, v_amount,
                  coalesce((v_sq.captured_at AT TIME ZONE 'Asia/Tokyo')::date, current_date), 'square',
                  NULL, NULL,
                  left(CASE WHEN v_dec = 'record_net_after_refund'
                            THEN 'Card capture less completed refunds (¥' || v_done || '), recorded by staff decision: '
                            ELSE 'Card capture recorded by staff decision: ' END || p_note, 1000),
                  'confirmed', v_uid, v_sq.id,
                  CASE WHEN v_dec = 'record_net_after_refund' THEN 'card_net_after_refund' ELSE 'cash_payment' END)
          RETURNING id INTO v_sub;
        END IF;
      END IF;
    END IF;

    IF v_resolved THEN
      UPDATE public.square_payments SET exception_resolved_at = now(), exception_resolved_by = v_uid, updated_at = now()
       WHERE id = v_sq.id;
    END IF;
    INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
    VALUES ('square_exception', p_id, 'square_case_decided',
            jsonb_build_object('decision', v_dec, 'note', left(p_note, 1000), 'resolved', v_resolved, 'error', v_err,
                               'submission_id', v_sub, 'refunds_completed_jpy', v_done, 'refunds_pending', v_open), v_uid);
    IF v_err IS NOT NULL THEN
      RETURN jsonb_build_object('error', v_err, 'decision_recorded', true, 'resolved', false,
                                'refunds_completed_jpy', v_done, 'refunds_pending', v_open);
    END IF;
    RETURN jsonb_build_object('ok', true, 'resolved', v_resolved, 'decision', v_dec, 'submission_id', v_sub,
                              'next', CASE WHEN v_sub IS NOT NULL THEN 'confirm_submission' END);
  ELSE
    RETURN jsonb_build_object('error', 'bad_kind');
  END IF;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('square_' || p_kind, p_id, 'square_case_decided',
          jsonb_build_object('decision', v_dec, 'note', left(p_note, 1000)), v_uid);
  RETURN jsonb_build_object('ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.decide_square_case(text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_square_case(text, uuid, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. square_settlement_report → card activity, ESTIMATED net (QC13). Same
--    figures plus fees_missing (captures whose processing fee Square has not
--    reported yet — counted as 0, so net is an overestimate that day). Bank
--    payouts are not read; the Square Dashboard is the bank truth.

-- ---------------------------------------------------------------------------
-- apply_square_payment_state — one lock order (review 2026-10-05 A)
-- ---------------------------------------------------------------------------
-- Anchored in-place edit of the LIVE body (md5 of prosrc 086172c8…): it now
-- locks the latest submission before the card row, the order finalize and
-- decide_square_case use. Nothing else changes; removing the inserted PERFORM
-- gives the live text back (checked).
CREATE OR REPLACE FUNCTION public.apply_square_payment_state(p_square_payment_id text, p_provider_status text, p_amount_jpy bigint, p_refunded_jpy bigint, p_currency text, p_provider_version text, p_provider_updated_at timestamp with time zone, p_captured_at timestamp with time zone, p_capture_by timestamp with time zone, p_card_brand text, p_card_last4 text, p_receipt_url text, p_risk_level text, p_provider_verification jsonb, p_payload jsonb, p_source text, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sq     public.square_payments%ROWTYPE;
  v_order  public.cash_orders%ROWTYPE;
  v_sub    public.payment_submissions%ROWTYPE;
  v_ps     text := upper(coalesce(p_provider_status, ''));
  v_from   text;
  v_to     text;
  v_exc    text := NULL;
  v_subact text := NULL;
  v_ref    text;
  v_amt    text;
BEGIN
  -- One lock order everywhere (review 2026-10-05 A): the latest submission,
  -- then the card row — the order finalize_cash_submission_atomic and
  -- decide_square_case take — so a webhook / reconcile state change never
  -- deadlocks with a Finish or a staff decision on the same payment.
  PERFORM 1 FROM public.payment_submissions
   WHERE square_payment_id = (SELECT id FROM public.square_payments WHERE square_payment_id = p_square_payment_id)
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  SELECT * INTO v_sq FROM public.square_payments WHERE square_payment_id = p_square_payment_id FOR UPDATE;
  IF v_sq.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_payment'); END IF;
  SELECT * INTO v_order FROM public.cash_orders WHERE id = v_sq.cash_order_id;
  v_from := v_sq.status;
  v_ref := coalesce(v_order.web_reference, v_order.invoice_number, '');
  v_amt := '¥' || to_char(coalesce(p_amount_jpy, round(v_sq.amount_jpy)::bigint), 'FM999,999,999');

  -- The payment exists in Square and in the Hub: its attempt is answered. An
  -- attempt still open (lost answer recovered by webhook/reconcile, a
  -- cancel-by-key that put it back to unknown) would lock the order forever
  -- (review 2026-10-04 #1) — close it; this row carries the lock from here.
  UPDATE public.square_card_attempts
     SET status = CASE WHEN v_ps IN ('CANCELED','FAILED') THEN 'cancelled' ELSE 'authorized' END,
         square_payment_id = coalesce(square_payment_id, p_square_payment_id),
         resolved_at = coalesce(resolved_at, now()), updated_at = now()
   WHERE status IN ('reserved','unknown','cancelling')
     AND (id = v_sq.attempt_id OR (v_sq.reference IS NOT NULL AND reference = v_sq.reference));

  -- An older observation never overwrites a newer one.
  IF p_provider_updated_at IS NOT NULL AND v_sq.provider_updated_at IS NOT NULL
     AND p_provider_updated_at < v_sq.provider_updated_at THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'stale', true, 'status', v_from);
  END IF;

  -- The rule: Square COMPLETED is captured whatever the Hub concluded before;
  -- captured never goes back; APPROVED means the hold is live (a local
  -- "voided/expired" was wrong); CANCELED/FAILED close a live hold only.
  v_to := CASE
    WHEN v_ps = 'COMPLETED' THEN 'captured'
    WHEN v_from = 'captured' THEN 'captured'
    WHEN v_ps = 'APPROVED' THEN 'authorized'
    WHEN v_ps = 'CANCELED' AND v_from = 'authorized' THEN
      CASE WHEN coalesce(p_capture_by, v_sq.capture_by) IS NOT NULL AND now() >= coalesce(p_capture_by, v_sq.capture_by)
           THEN 'expired' ELSE 'voided' END
    WHEN v_ps = 'FAILED' AND v_from = 'authorized' THEN 'failed'
    ELSE v_from END;

  IF v_to = 'captured' AND v_from <> 'captured' THEN
    IF v_from IN ('voided','expired','failed','rejected') THEN v_exc := 'captured_after_close'; END IF;
    IF coalesce(p_currency, 'JPY') <> 'JPY' OR p_amount_jpy IS DISTINCT FROM round(v_sq.amount_jpy)::bigint THEN
      v_exc := 'amount_mismatch';
    END IF;
  ELSIF v_to = 'authorized' AND v_from IN ('voided','expired','failed','rejected') THEN
    v_exc := 'void_unconfirmed';
  END IF;

  UPDATE public.square_payments
     SET status = v_to,
         provider_status = coalesce(nullif(v_ps, ''), provider_status),
         provider_version = coalesce(p_provider_version, provider_version),
         provider_updated_at = coalesce(p_provider_updated_at, provider_updated_at),
         captured_at = CASE WHEN v_to = 'captured' AND captured_at IS NULL THEN coalesce(p_captured_at, now()) ELSE captured_at END,
         captured_amount_jpy = CASE WHEN v_to = 'captured' AND captured_amount_jpy IS NULL THEN p_amount_jpy ELSE captured_amount_jpy END,
         voided_at = CASE WHEN v_to IN ('voided','expired') AND v_from = 'authorized' THEN now()
                          WHEN v_to = 'authorized' THEN NULL ELSE voided_at END,
         voided_reason = CASE WHEN v_to IN ('voided','expired') AND v_from = 'authorized' THEN coalesce(p_source, 'square')
                              WHEN v_to = 'authorized' THEN NULL ELSE voided_reason END,
         capture_by = coalesce(p_capture_by, capture_by),
         refund_jpy = greatest(coalesce(p_refunded_jpy, 0), 0),
         card_brand = coalesce(card_brand, p_card_brand),
         card_last4 = coalesce(card_last4, p_card_last4),
         receipt_url = coalesce(p_receipt_url, receipt_url),
         risk_level = coalesce(p_risk_level, risk_level),
         provider_verification = coalesce(p_provider_verification, provider_verification),
         last_payload = coalesce(p_payload, last_payload),
         last_webhook_at = CASE WHEN p_source = 'webhook' THEN now() ELSE last_webhook_at END,
         exception = CASE WHEN v_exc IS NOT NULL THEN v_exc ELSE exception END,
         exception_at = CASE WHEN v_exc IS NOT NULL THEN now() ELSE exception_at END,
         exception_note = CASE WHEN v_exc IS NOT NULL THEN 'Square ' || v_ps || ' while the Hub had ' || v_from ELSE exception_note END,
         exception_resolved_at = CASE WHEN v_exc IS NOT NULL THEN NULL ELSE exception_resolved_at END,
         updated_at = now()
   WHERE id = v_sq.id
  RETURNING * INTO v_sq;

  SELECT * INTO v_sub FROM public.payment_submissions WHERE square_payment_id = v_sq.id
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;

  IF v_to IN ('voided','expired','failed') AND v_from = 'authorized' THEN
    -- The hold is gone: a submission still waiting is rejected so she can pay
    -- again (owner 3A). A claimed Confirm is left to its own read-back.
    IF v_sub.id IS NOT NULL AND v_sub.status::text IN ('submitted','under_review') THEN
      UPDATE public.payment_submissions
         SET status = 'rejected',
             reviewer_notes = 'Card hold closed by Square (' || v_ps || ', ' || v_to || ') — nothing was charged.',
             updated_at = now()
       WHERE id = v_sub.id;
      v_subact := 'rejected';
    END IF;
    IF coalesce(p_source, '') NOT IN ('void') THEN
      INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
      VALUES ('card_closed_externally', 'Card hold closed by Square',
              v_ref || ' · ' || v_amt || ' — Square reports the hold as ' || v_ps || ' (' || v_to || '). Nothing was charged; '
                || CASE WHEN v_subact = 'rejected' THEN 'the submission was rejected and the customer can pay again.' ELSE 'no submission was waiting.' END,
              v_order.customer_id, v_order.invoice_number,
              jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                                 'status', v_to, 'source', p_source, 'test', v_sq.test));
    END IF;
  ELSIF v_to = 'captured' AND v_from <> 'captured' THEN
    IF v_sub.id IS NULL OR v_sub.status::text IN ('rejected','cancelled') THEN
      IF v_exc IS NULL THEN
        v_exc := 'captured_unallocated';
        UPDATE public.square_payments SET exception = v_exc, exception_at = now(),
               exception_note = 'Captured with no live submission', exception_resolved_at = NULL
         WHERE id = v_sq.id;
      END IF;
    END IF;
    -- A reviewer's Confirm that already claimed the submission (status
    -- 'confirmed', not yet recorded) is the Hub's own capture: no "captured
    -- outside the Hub" bell for it (webhook racing the Confirm, Finish recording).
    IF v_exc IS NOT NULL
       OR (coalesce(p_source, '') <> 'capture'
           AND NOT (v_sub.id IS NOT NULL AND v_sub.status::text = 'confirmed' AND v_sub.confirmed_payment_id IS NULL)) THEN
      INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
      VALUES (CASE WHEN v_exc IS NOT NULL THEN 'card_capture_exception' ELSE 'card_captured_externally' END,
              CASE WHEN v_exc IS NOT NULL THEN 'Card money captured — needs a decision' ELSE 'Card captured outside the Hub' END,
              v_ref || ' · ' || v_amt || ' — Square shows this card payment COMPLETED'
                || CASE WHEN v_exc IS NOT NULL THEN ' (' || v_exc || '). Open Website → Card payments to record it or refund it in the Square Dashboard.'
                        ELSE '. Open Payments Hub and press Confirm / Finish recording to record it.' END,
              v_order.customer_id, v_order.invoice_number,
              jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                                 'exception', v_exc, 'source', p_source, 'test', v_sq.test));
    END IF;
  ELSIF v_exc = 'void_unconfirmed' THEN
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    VALUES ('card_void_failed', 'Card hold is still live',
            v_ref || ' · ' || v_amt || ' — the Hub had this hold as ' || v_from || ' but Square still holds it (APPROVED). Void it from Payments Hub or the Square Dashboard.',
            v_order.customer_id, v_order.invoice_number,
            jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id, 'test', v_sq.test));
  END IF;

  IF v_to IS DISTINCT FROM v_from OR v_exc IS NOT NULL THEN
    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
    VALUES ('square_payment', v_sq.id, 'square_state',
            jsonb_build_object('status', v_from),
            jsonb_build_object('status', v_to, 'provider_status', v_ps, 'exception', v_exc, 'submission', v_subact,
                               'source', p_source, 'square_payment_id', p_square_payment_id),
            p_user_id);
  END IF;

  RETURN jsonb_build_object('ok', true, 'changed', v_to IS DISTINCT FROM v_from, 'from', v_from, 'to', v_to,
                            'exception', v_exc, 'submission_action', v_subact, 'square_row_id', v_sq.id,
                            'cash_order_id', v_sq.cash_order_id);
END
$function$;


-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.square_settlement_report(date, date, boolean);
CREATE FUNCTION public.square_settlement_report(p_from date, p_to date, p_include_test boolean DEFAULT false)
RETURNS TABLE (day date, captures integer, gross_jpy bigint, fees_jpy bigint, refunds_completed_jpy bigint,
               refunds_open_jpy bigint, disputes_lost_jpy bigint, net_jpy bigint, fees_missing integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $fn$
  WITH cap AS (
    SELECT (sp.captured_at AT TIME ZONE 'Asia/Tokyo')::date AS d,
           count(*)::int AS n,
           sum(coalesce(sp.captured_amount_jpy, 0))::bigint AS gross,
           sum(coalesce((SELECT sum((f->'amount_money'->>'amount')::bigint)
                           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(sp.last_payload->'processing_fee') = 'array'
                                                          THEN sp.last_payload->'processing_fee' ELSE '[]'::jsonb END) f), 0))::bigint AS fees,
           count(*) FILTER (WHERE jsonb_typeof(sp.last_payload->'processing_fee') IS DISTINCT FROM 'array'
                               OR jsonb_array_length(sp.last_payload->'processing_fee') = 0)::int AS fees_missing
      FROM public.square_payments sp
     WHERE sp.status = 'captured' AND sp.captured_at IS NOT NULL AND (p_include_test OR NOT sp.test)
     GROUP BY 1
  ), ref AS (
    SELECT (coalesce(r.provider_updated_at, r.updated_at) AT TIME ZONE 'Asia/Tokyo')::date AS d,
           sum(CASE WHEN r.status = 'COMPLETED' THEN r.amount_jpy ELSE 0 END)::bigint AS done,
           sum(CASE WHEN r.status = 'PENDING' THEN r.amount_jpy ELSE 0 END)::bigint AS open
      FROM public.square_refunds r JOIN public.square_payments sp ON sp.id = r.square_payment_row
     WHERE (p_include_test OR NOT sp.test)
     GROUP BY 1
  ), dis AS (
    SELECT (coalesce(d.provider_updated_at, d.updated_at) AT TIME ZONE 'Asia/Tokyo')::date AS d,
           sum(CASE WHEN d.state = 'LOST' OR d.state = 'ACCEPTED' THEN coalesce(d.amount_jpy, 0) ELSE 0 END)::bigint AS lost
      FROM public.square_disputes d JOIN public.square_payments sp ON sp.id = d.square_payment_row
     WHERE (p_include_test OR NOT sp.test)
     GROUP BY 1
  ), days AS (
    SELECT d FROM cap UNION SELECT d FROM ref UNION SELECT d FROM dis
  )
  SELECT days.d, coalesce(cap.n, 0), coalesce(cap.gross, 0), coalesce(cap.fees, 0), coalesce(ref.done, 0),
         coalesce(ref.open, 0), coalesce(dis.lost, 0),
         coalesce(cap.gross, 0) - coalesce(cap.fees, 0) - coalesce(ref.done, 0) - coalesce(dis.lost, 0),
         coalesce(cap.fees_missing, 0)
    FROM days LEFT JOIN cap ON cap.d = days.d LEFT JOIN ref ON ref.d = days.d LEFT JOIN dis ON dis.d = days.d
   WHERE days.d BETWEEN p_from AND p_to
   ORDER BY days.d;
$fn$;
REVOKE ALL ON FUNCTION public.square_settlement_report(date, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.square_settlement_report(date, date, boolean) TO authenticated, service_role;
COMMENT ON FUNCTION public.square_settlement_report(date, date, boolean) IS
  'Card ACTIVITY by Japan day with an ESTIMATED net (QC13, 2026-10-05): captures and gross (invoice credit), Square processing fees as reported on the payment (fees_missing = captures with no fee reported yet, counted as 0), completed / pending refunds and lost or accepted disputes by their last Square update day. Not bank money: payouts, withheld dispute funds and fee adjustments are in the Square Dashboard. SECURITY INVOKER: staff only through RLS.';

-- ---------------------------------------------------------------------------
-- 6. square_ops_health — one read for the operator panel (QC11).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.square_ops_health()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_uid uuid := auth.uid(); v jsonb;
BEGIN
  -- Staff only (review #2: current_user is the owner inside SECURITY
  -- DEFINER, so it can never identify the caller).
  IF v_uid IS NULL OR NOT public.is_staff(v_uid) THEN
    RAISE EXCEPTION 'not_staff' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'last_run',            (SELECT value FROM public.square_sync_state WHERE key = 'reconcile_last_run'),
    'last_ok_at',          (SELECT value->>'at' FROM public.square_sync_state WHERE key = 'reconcile_last_ok'),
    'events_backlog',      (SELECT count(*) FROM public.square_webhook_events WHERE status IN ('received','processing','failed','quarantined')),
    'events_dead',         (SELECT count(*) FROM public.square_webhook_events WHERE status = 'dead'),
    'holds_live',          (SELECT count(*) FROM public.square_payments WHERE status = 'authorized'),
    'attempts_open',       (SELECT count(*) FROM public.square_card_attempts WHERE status IN ('reserved','unknown','cancelling')),
    'captured_unrecorded', (SELECT count(*) FROM public.square_payments WHERE status = 'captured' AND cash_payment_id IS NULL AND exception_resolved_at IS NULL),
    'exceptions_open',     (SELECT count(*) FROM public.square_payments WHERE exception IS NOT NULL AND exception_resolved_at IS NULL),
    'refunds_open',        (SELECT count(*) FROM public.square_refunds WHERE status NOT IN ('COMPLETED','FAILED','REJECTED')),
    'disputes_open',       (SELECT count(*) FROM public.square_disputes WHERE state NOT IN ('WON','LOST','ACCEPTED')),
    'checkpoints',         (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) FROM public.square_sync_state
                             WHERE key NOT IN ('reconcile_last_run','reconcile_last_ok'))
  ) INTO v;
  RETURN v;
END
$fn$;
REVOKE ALL ON FUNCTION public.square_ops_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.square_ops_health() TO authenticated;

-- ---------------------------------------------------------------------------
-- Self-checks: everything above is in place, or the whole migration rolls back.
-- ---------------------------------------------------------------------------
DO $check$
DECLARE r record; v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.finalize_cash_submission_atomic(uuid,uuid,text,date,text)', '0fa6a88f98bbbcb8875f822c230613c7'),
    ('public.decide_square_case(text,uuid,text,text)', '983c3d19218a2687008677a83f42bbfb'),
    ('public.record_square_refund(text,text,text,bigint,text,timestamptz,timestamptz,jsonb)', '05ea98ccb32a917d8ac5124281b21e9d'),
    ('public.record_square_dispute(text,text,text,text,bigint,timestamptz,timestamptz,timestamptz,jsonb)', '9b1f4391292e7e7211eb58ce0a910e93'),
    ('public.guard_cash_payment_paidy()', '3b01fcbecf898942db632c741ed20f02'),
    ('public.square_settlement_report(date,date,boolean)', '4621668c61e6ac4601996b08c2a8e967'),
    ('public.apply_square_payment_state(text,text,bigint,bigint,text,text,timestamptz,timestamptz,timestamptz,text,text,text,text,jsonb,jsonb,text,uuid)', '8ad64c42440eb9dea459007baea8a9df')) AS t(sig, new_md5)
  LOOP
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(r.sig);
    IF v_md5 IS DISTINCT FROM r.new_md5 THEN
      RAISE EXCEPTION 'STOP — % did not store the expected body (md5 %); rolled back', r.sig, v_md5;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_cash_payment_paidy'
                  AND tgrelid = 'public.cash_payments'::regclass AND NOT tgisinternal AND (tgtype & 8) <> 0) THEN
    RAISE EXCEPTION 'STOP — trg_guard_cash_payment_paidy does not cover DELETE; rolled back';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_cash_order_amount_during_hold'
                  AND tgrelid = 'public.cash_orders'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'STOP — trg_guard_cash_order_amount_during_hold is missing; rolled back';
  END IF;
  IF has_function_privilege('authenticated', 'public.guard_cash_payment_paidy()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_cash_order_amount_during_hold()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.decide_square_case(text,uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.square_ops_health()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.square_settlement_report(date,date,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — a guard or staff function is executable by the wrong role; rolled back';
  END IF;
  IF to_regclass('public.square_sync_state') IS NULL THEN
    RAISE EXCEPTION 'STOP — square_sync_state missing; rolled back';
  END IF;
  IF EXISTS (SELECT 1 FROM public.square_payments sp JOIN public.cash_payments cp ON cp.id = sp.cash_payment_id
              WHERE cp.provider_capture_id IS DISTINCT FROM sp.square_payment_id) THEN
    RAISE EXCEPTION 'STOP — a recorded card receipt lacks its Square payment id; rolled back';
  END IF;
END
$check$;