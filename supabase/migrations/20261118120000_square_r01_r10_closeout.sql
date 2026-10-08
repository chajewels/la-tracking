-- Square QA reassessment R01–R10 close-out (owner decisions 2026-10-08 13:14 JST:
-- R05 = refuse, R01 = include). Project doc: claude/square-r01-r10-closeout-plan-2026-10-08.md
--
--   R05  Money already refunded through Square can never come back a second time
--        as store credit. terminate_web_order_atomic (web orders) and
--        cancel_cash_order_atomic (Hub cash orders) refuse 'store_credit_issued'
--        — and any minting — while a square_refunds row for the order is not
--        FAILED / REJECTED (card_already_refunded). The preview says so
--        (card_refunded) so the Hub greys the choice with the reason.
--   R01  square_card_attempts.search_cursor / search_pages: the payment search
--        resumes where the previous hour stopped instead of re-reading page 1.
--   R02  note_square_attempt_stuck also touches updated_at (the ordering key),
--        so 30 forever-waiting attempts cannot starve attempt 31.
--   R05 race  record_square_refund locks the order before the payment and rings
--        card_refund_after_credit when a refund lands on an order already
--        cancelled with store credit (section 4b).
--
-- Function bodies are patched IN PLACE from the live text behind an md5 guard
-- (Bug #280): the helper STOPS, changing nothing, if a function has moved or an
-- anchor is not found exactly once. Re-running is a no-op. Grants are untouched
-- (CREATE OR REPLACE keeps the ACL).

ALTER TABLE public.square_card_attempts
  ADD COLUMN IF NOT EXISTS search_cursor text,
  ADD COLUMN IF NOT EXISTS search_pages integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.square_card_attempts.search_cursor IS
  'R01 (2026-10-08): Square ListPayments cursor where the last incomplete recovery search stopped; the next run resumes here. Cleared when the search ends (found / absent).';
COMMENT ON COLUMN public.square_card_attempts.search_pages IS
  'R01: pages already read by earlier incomplete searches (reporting only).';

-- ---------------------------------------------------------------------------
-- 1. The patch helper (session-only).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.cj_patch(p_sig text, p_before text, p_edits jsonb)
RETURNS void LANGUAGE plpgsql AS $p$
DECLARE
  v_fn   regprocedure;
  v_def  text;
  v_new  text;
  e      jsonb;
  v_n    integer;
  v_done boolean := true;
BEGIN
  v_fn := to_regprocedure(p_sig);
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — % is not on live; nothing changed', p_sig;
  END IF;
  v_def := pg_get_functiondef(v_fn);
  FOR e IN SELECT * FROM jsonb_array_elements(p_edits) LOOP
    IF position(e ->> 'new' IN v_def) = 0 THEN v_done := false; END IF;
  END LOOP;
  IF v_done THEN
    RAISE NOTICE '% already patched — no change', p_sig;
    RETURN;
  END IF;
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION 'STOP — % has moved on live (md5 %); re-read it before patching. Nothing changed.', p_sig, md5(v_def);
  END IF;
  v_new := v_def;
  FOR e IN SELECT * FROM jsonb_array_elements(p_edits) LOOP
    v_n := (length(v_new) - length(replace(v_new, e ->> 'old', ''))) / length(e ->> 'old');
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'STOP — % anchor found % times, expected 1: %', p_sig, v_n, left(e ->> 'old', 120);
    END IF;
    v_new := replace(v_new, e ->> 'old', e ->> 'new');
  END LOOP;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> md5(v_new) THEN
    RAISE EXCEPTION 'STOP — % did not store the patched body exactly; rolled back', p_sig;
  END IF;
END
$p$;

-- ---------------------------------------------------------------------------
-- 2. R05 — terminate_web_order_atomic (live md5 253f2f2ecc0897f0378471d0b2ee3a59
--    after the 2026-10-08 11:45 apply).
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch(
  'public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)',
  '253f2f2ecc0897f0378471d0b2ee3a59',
  jsonb_build_array(
    jsonb_build_object('old', $o$  v_order_date date; v_split jsonb := NULL; v_card_paid boolean := false;$o$,
                       'new', $n$  v_order_date date; v_split jsonb := NULL; v_card_paid boolean := false;
  v_card_refunded boolean := false;$n$),
    jsonb_build_object('old', $o$    -- Cancellation credit rule (owner 2026-10-06/08): same day as order_date →
    -- 100 %; later → 30 % of the money paid kept, 70 % credit. No override.
    v_split := public.cancellation_credit_split(v_currency, v_order_date, v_money_received, v_now);$o$,
                       'new', $n$    -- R05 (owner 2026-10-08, refuse): money already given back through Square
    -- (any refund not FAILED / REJECTED — pending counts, it is committed) can
    -- never come back a second time as store credit. Staff see the reason and
    -- use "refund pending" → "Mark refund issued" instead.
    v_card_refunded := EXISTS (SELECT 1 FROM public.square_refunds
                                WHERE cash_order_id = p_order_id AND status NOT IN ('FAILED','REJECTED'));
    IF NOT p_preview AND p_refund_status = 'store_credit_issued' AND v_card_refunded THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'card_already_refunded',
        'status', v_status);
    END IF;
    -- Cancellation credit rule (owner 2026-10-06/08): same day as order_date →
    -- 100 %; later → 30 % of the money paid kept, 70 % credit. No override.
    v_split := public.cancellation_credit_split(v_currency, v_order_date, v_money_received, v_now);$n$),
    jsonb_build_object('old', $o$      'paid_by_card', v_card_paid,
      'refund_decision_required', (v_money_received > 0),$o$,
                       'new', $n$      'paid_by_card', v_card_paid,
      'card_refunded', v_card_refunded,
      'refund_decision_required', (v_money_received > 0),$n$)
  ));

-- ---------------------------------------------------------------------------
-- 3. R05 — cancel_cash_order_atomic (live md5 10c6d3320a2d25c3e2ed5c85af6146f7).
--    Hub cash orders cannot take a card today; the guard is cheap and keeps the
--    two cancel paths saying the same thing (ACCOUNT-SCOPE rule).
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch(
  'public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text)',
  '10c6d3320a2d25c3e2ed5c85af6146f7',
  jsonb_build_array(
    jsonb_build_object('old', $o$  v_order_date date; v_shopify_id text; v_split jsonb;$o$,
                       'new', $n$  v_order_date date; v_shopify_id text; v_split jsonb;
  v_card_refunded boolean := false;$n$),
    jsonb_build_object('old', $o$  v_issue_amount := GREATEST(0, (v_split ->> 'credit')::numeric - v_partial_credit);
  IF p_preview THEN
    RETURN jsonb_build_object(
      'preview', true, 'invoice_number', v_invoice, 'status', v_status,$o$,
                       'new', $n$  v_issue_amount := GREATEST(0, (v_split ->> 'credit')::numeric - v_partial_credit);
  -- R05 (owner 2026-10-08, refuse): money already given back through Square
  -- never comes back again as store credit — the cancel itself is refused so
  -- staff pick the refund path, exactly as on a web order.
  v_card_refunded := EXISTS (SELECT 1 FROM public.square_refunds
                              WHERE cash_order_id = p_cash_order_id AND status NOT IN ('FAILED','REJECTED'));
  IF NOT p_preview AND v_card_refunded AND v_issue_amount > 0 THEN
    RAISE EXCEPTION 'card_already_refunded: money on this order was already refunded through Square — it cannot be issued again as store credit' USING ERRCODE='P0001';
  END IF;
  IF p_preview THEN
    RETURN jsonb_build_object(
      'preview', true, 'invoice_number', v_invoice, 'status', v_status,
      'card_refunded', v_card_refunded,$n$)
  ));

-- ---------------------------------------------------------------------------
-- 4. R02 — note_square_attempt_stuck (live md5 b19a6684d2dda530315e358b0808acdf):
--    a waiting attempt advances in the updated_at ordering the reconcile uses.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch(
  'public.note_square_attempt_stuck(uuid)',
  'b19a6684d2dda530315e358b0808acdf',
  jsonb_build_array(
    jsonb_build_object('old', $o$  UPDATE public.square_card_attempts
     SET stuck_runs = stuck_runs + 1
   WHERE id = p_attempt_id AND status IN ('reserved','unknown','cancelling')$o$,
                       'new', $n$  UPDATE public.square_card_attempts
     SET stuck_runs = stuck_runs + 1, updated_at = now()   -- R02: fair ordering for the next run
   WHERE id = p_attempt_id AND status IN ('reserved','unknown','cancelling')$n$)
  ));

-- ---------------------------------------------------------------------------
-- 4b. R05 race — record_square_refund (live md5 631924c17ece37aa7323de78f9897abd,
--     unchanged since 20261108100000). Two things:
--     (a) the ORDER row is locked before the payment row (the same order
--         finalize_cash_submission_atomic uses: order → payment), so a cancel
--         with store credit in flight finishes before this refund is seen —
--         and the cancel, holding the same lock, sees this refund if it lands
--         first. No deadlock with finalize; no window between the two writers.
--     (b) a refund (not FAILED / REJECTED) landing on an order that ALREADY holds
--         a cancellation store-credit lot rings card_refund_after_credit once
--         per refund, so a human voids the lot (Settings → Store Credit) — the
--         Hub can refuse the credit (R05) but cannot stop a refund made in the
--         Square Dashboard afterwards.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch(
  'public.record_square_refund(text,text,text,bigint,text,timestamptz,timestamptz,jsonb)',
  '631924c17ece37aa7323de78f9897abd',
  jsonb_build_array(
    jsonb_build_object('old', $o$  -- Locked: a recording (finalize) and this refund serialise on the payment (review #4).
  SELECT * INTO v_sq FROM public.square_payments WHERE square_payment_id = p_square_payment_id FOR UPDATE;
  IF v_sq.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_payment'); END IF;
  SELECT * INTO v_order FROM public.cash_orders WHERE id = v_sq.cash_order_id;$o$,
                       'new', $n$  -- Locked: a recording (finalize) and this refund serialise on the payment (review #4).
  -- R05 race (2026-10-08): the ORDER is locked first (order → payment, as in
  -- finalize), so a cancel-with-store-credit in flight and this refund never
  -- overlap: whichever commits second sees the other's row.
  SELECT * INTO v_sq FROM public.square_payments WHERE square_payment_id = p_square_payment_id;
  IF v_sq.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_payment'); END IF;
  SELECT * INTO v_order FROM public.cash_orders WHERE id = v_sq.cash_order_id FOR UPDATE;
  SELECT * INTO v_sq FROM public.square_payments WHERE square_payment_id = p_square_payment_id FOR UPDATE;$n$),
    jsonb_build_object('old', $o$    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json)
    VALUES ('square_refund', v_new.id, 'square_refund_state', jsonb_build_object('status', v_old.status),
            jsonb_build_object('status', v_st, 'amount_jpy', v_new.amount_jpy, 'refund_id', p_refund_id));
  END IF;$o$,
                       'new', $n$    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json)
    VALUES ('square_refund', v_new.id, 'square_refund_state', jsonb_build_object('status', v_old.status),
            jsonb_build_object('status', v_st, 'amount_jpy', v_new.amount_jpy, 'refund_id', p_refund_id));
    -- R05 (2026-10-08): the order already holds a cancellation store-credit
    -- lot — the same money is now going back twice. One bell per refund.
    IF v_st NOT IN ('FAILED','REJECTED') AND EXISTS (
         SELECT 1 FROM public.store_credit_lots l
          WHERE l.source_cash_order_id = v_sq.cash_order_id AND l.source_type = 'cancelled_cash' AND l.status <> 'voided')
       AND NOT EXISTS (SELECT 1 FROM public.staff_notifications n
                        WHERE n.type = 'card_refund_after_credit' AND n.metadata ->> 'refund_id' = p_refund_id) THEN
      INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
      VALUES ('card_refund_after_credit', 'Card refund on an order that already has store credit',
              coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · ¥' || to_char(v_new.amount_jpy, 'FM999,999,999')
                || ' refunded in Square (' || lower(v_st) || ') but this order was cancelled with STORE CREDIT. The customer is being paid back twice: void the store-credit lot (Settings → Store Credit) or reverse the Square refund.',
              v_order.customer_id, v_order.invoice_number,
              jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                                 'refund_id', p_refund_id, 'status', v_st, 'test', v_sq.test));
    END IF;
  END IF;$n$)
  ));

-- ---------------------------------------------------------------------------
-- 5. Self-check.
-- ---------------------------------------------------------------------------
DO $chk$
BEGIN
  IF position('card_already_refunded' IN pg_get_functiondef('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'self-check: terminate_web_order_atomic lacks card_already_refunded';
  END IF;
  IF position('card_already_refunded' IN pg_get_functiondef('public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'self-check: cancel_cash_order_atomic lacks card_already_refunded';
  END IF;
  IF position('updated_at = now()   -- R02' IN pg_get_functiondef('public.note_square_attempt_stuck(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'self-check: note_square_attempt_stuck lacks the R02 touch';
  END IF;
  IF position('card_refund_after_credit' IN pg_get_functiondef('public.record_square_refund(text,text,text,bigint,text,timestamptz,timestamptz,jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'self-check: record_square_refund lacks card_refund_after_credit';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='square_card_attempts' AND column_name='search_cursor') THEN
    RAISE EXCEPTION 'self-check: search_cursor missing';
  END IF;
END
$chk$;
