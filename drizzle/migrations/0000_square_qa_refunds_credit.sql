-- 20261118100000_square_qa_refunds_credit.sql (renumbered from 20261117100000 — a record-only Paidy migration already held that version; same content)
-- Square QA/QC review 2026-10-06 (S01, S04, S05) + B01 + B02 data + the
-- cancellation store-credit rule. Owner plan v2 approved 2026-10-08 10:31 JST
-- (project doc claude/square-s01-s05-plan-2026-10-08.md).
--
-- S05  ring_square_deadline_bells: a Square refund still not COMPLETED /
--      FAILED / REJECTED rings 'card_refund_pending' at 7 days (every day
--      counts, owner E1) and again at 14 days ("contact Square support").
--      square_ops_health shows the oldest pending refund.
-- S01  note_square_attempt_stuck: square-reconcile counts runs in which a card
--      attempt's payment search could not finish; the 3rd rings
--      'card_attempt_stuck' once.
-- S04  reassign_order_owner_atomic refuses 'card_order' (any card attempt,
--      card payment or card submission on the order), preview included.
-- B01  mark_web_order_refund_issued_atomic: a card-paid order is refunded in
--      Square — method must be 'card', at least one COMPLETED Square refund
--      must exist, and the amount recorded is what Square COMPLETED (owner E7),
--      never the gross. The same request repeated after success returns the
--      same answer. terminate_web_order_atomic refuses 'refund_issued' at
--      cancel time on a card-paid order (card_refund_needs_square).
-- B02  square_refunds.refund_email_replay: square-reconcile may re-send the
--      「返金を受け付けました」 email only for refunds that arrive from now on
--      (existing rows are marked false here — never replayed).
-- RULE Cancellation store credit (owner 2026-10-06 13:04 + E3–E6):
--      website and Hub cash orders: cancelled on the order's Japan date →
--      100 % credit; later → 30 % of the money paid is kept, 70 % is credit.
--      No override. Shopify keeps 100 % (unchanged).
--      cancellation_credit_split() is the one formula; terminate_web_order_atomic
--      (store_credit_issued) and cancel_cash_order_atomic (Hub) use it.
--
-- Every function change is an md5-guarded in-place patch of the LIVE body
-- (read 2026-10-08 through the Lovable database tool; the repo copies were
-- byte-identical to live — prosrc md5 compared):
--   ring_square_deadline_bells(timestamptz)                    f609ffe12ac97074b9527adc3071bc97
--   square_ops_health()                                        d296cf8f63dd8691cea424f9644b84a2
--   reassign_order_owner_atomic(text,uuid,uuid,numeric,text,uuid,boolean,boolean)
--                                                              bfb7f94d5e57dc56465e25a08050977f
--   mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text)
--                                                              5c5051464ec4e7c54ddceed0616bc4fe
--   terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)
--                                                              8df3c2f2ab0557dfc8ed5c5d8d34eb7b
--   cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text) 1d3a1f5004e7b12127f5c6f0604bea55
-- Signatures unchanged; grants re-asserted.
-- ---------------------------------------------------------------------------

-- 0. Columns.
ALTER TABLE public.square_refunds
  ADD COLUMN IF NOT EXISTS warned_7d_at timestamptz,
  ADD COLUMN IF NOT EXISTS warned_14d_at timestamptz,
  ADD COLUMN IF NOT EXISTS refund_email_replay boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS email_resends integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_given_up_at timestamptz;
COMMENT ON COLUMN public.square_refunds.refund_email_replay IS
  'B02 (2026-10-08): square-reconcile may re-send the refund-received email for this refund when no sent row exists. Rows that existed before the release are false (never replayed).';

-- Existing refunds predate the replay: never re-sent. Runs once — a later
-- re-run finds no column to add and no row still at the default from before.
DO $b02$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.square_sync_state WHERE key = 'b02_replay_cutoff') THEN
    UPDATE public.square_refunds SET refund_email_replay = false;
    INSERT INTO public.square_sync_state (key, value) VALUES ('b02_replay_cutoff', jsonb_build_object('at', now()));
  END IF;
END
$b02$;

ALTER TABLE public.square_card_attempts
  ADD COLUMN IF NOT EXISTS stuck_runs integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stuck_warned_at timestamptz;

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
-- 2. The one cancellation-credit formula (owner rule, E3–E6).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancellation_credit_split(
  p_currency public.account_currency, p_order_date date, p_money numeric, p_at timestamptz)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $fn$
  -- Cancelled on (or before) the order's date → 100 % credit. Later → 30 % of
  -- the money paid is kept as the cancellation charge and the rest is credit.
  -- cash_orders.order_date is written as the PHT calendar day (Asia/Manila —
  -- the Hub's canonical day boundary, CLAUDE.md TIMEZONE; website drafts,
  -- confirm and Hub creation all use it), so the cancel day is taken in the
  -- SAME zone: a different zone here would charge an order placed 00:00–01:00
  -- JST and cancelled the same morning. Yen rounds half-up to whole yen; pesos
  -- to 2 decimals. A missing order date counts as the same day (never charged
  -- by mistake).
  -- TS mirror: supabase/functions/_shared/cancellation-credit.ts (+ src/lib copy).
  WITH x AS (
    SELECT GREATEST(coalesce(p_money, 0), 0)::numeric(12,2) AS money,
           (p_at AT TIME ZONE 'Asia/Manila')::date AS cancel_day,
           (p_order_date IS NULL OR (p_at AT TIME ZONE 'Asia/Manila')::date <= p_order_date) AS same_day
  ), k AS (
    SELECT money, cancel_day, same_day,
           CASE WHEN same_day THEN 0::numeric(12,2)
                WHEN p_currency = 'PHP' THEN round(money * 0.30, 2)
                ELSE round(money * 0.30, 0) END::numeric(12,2) AS kept
      FROM x
  )
  SELECT jsonb_build_object(
           'rule', CASE WHEN same_day THEN 'same_day' ELSE 'after_order_day' END,
           'charge_pct', CASE WHEN same_day THEN 0 ELSE 30 END,
           'money', money, 'kept', kept, 'credit', money - kept,
           'order_date', p_order_date, 'cancel_date', cancel_day)
    FROM k;
$fn$;
REVOKE ALL ON FUNCTION public.cancellation_credit_split(public.account_currency, date, numeric, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancellation_credit_split(public.account_currency, date, numeric, timestamptz) TO authenticated, service_role;
COMMENT ON FUNCTION public.cancellation_credit_split(public.account_currency, date, numeric, timestamptz) IS
  'Owner rule 2026-10-06/08: a cancelled website or Hub cash order gets 100% store credit when cancelled on its order_date (compared as the PHT calendar day, the same zone order_date is written in), otherwise 30% of the money paid is kept and 70% is credit. Shopify is not covered (100%). Pure; TS mirror _shared/cancellation-credit.ts.';

-- ---------------------------------------------------------------------------
-- 3. S05 — stuck refund bells.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.ring_square_deadline_bells(timestamp with time zone)', 'f609ffe12ac97074b9527adc3071bc97', jsonb_build_array(
  jsonb_build_object('old', $o$DECLARE v_holds int := 0; v_d3 int := 0; v_d1 int := 0;$o$,
                     'new', $n$DECLARE v_holds int := 0; v_d3 int := 0; v_d1 int := 0; v_r14 int := 0; v_r7 int := 0;$n$),
  jsonb_build_object('old', $o$  RETURN jsonb_build_object('hold_warnings', v_holds, 'dispute_3d', v_d3, 'dispute_1d', v_d1);$o$,
                     'new', $n$  -- S05 (2026-10-08): a Square refund that is still not finished. Age is
  -- counted from Square's own creation time (updated_at is rewritten by every
  -- hourly read). Every day counts (owner E1). 14 days first, so a refund
  -- first seen that old rings once, with the support wording.
  WITH due AS (
    SELECT r.id, r.cash_order_id, r.square_refund_id, r.amount_jpy, r.status,
           coalesce(r.provider_created_at, r.created_at) AS started_at,
           o.customer_id, o.invoice_number, coalesce(o.web_reference, o.invoice_number, '') AS ref
      FROM public.square_refunds r JOIN public.cash_orders o ON o.id = r.cash_order_id
     WHERE r.status NOT IN ('COMPLETED','FAILED','REJECTED') AND r.warned_14d_at IS NULL
       AND coalesce(r.provider_created_at, r.created_at) <= p_now - interval '14 days'
     FOR UPDATE OF r SKIP LOCKED
  ), bell AS (
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    SELECT 'card_refund_pending', 'Card refund still not finished after 14 days — contact Square support',
           ref || ' · ¥' || to_char(round(amount_jpy), 'FM999,999,999') || ' — Square refund ' || square_refund_id
             || ' is still ' || status || ' since ' || to_char(started_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') || ' JST ('
             || floor(extract(epoch FROM p_now - started_at) / 86400)::int || ' days). Contact Square support from the Square Dashboard.',
           customer_id, invoice_number,
           jsonb_build_object('cash_order_id', cash_order_id, 'square_refund_id', square_refund_id, 'amount_jpy', amount_jpy,
                              'status', status, 'started_at', started_at, 'stage', '14d')
      FROM due RETURNING 1
  )
  UPDATE public.square_refunds r SET warned_14d_at = p_now, warned_7d_at = coalesce(r.warned_7d_at, p_now)
    FROM due WHERE r.id = due.id AND (SELECT count(*) FROM bell) >= 0;
  GET DIAGNOSTICS v_r14 = ROW_COUNT;

  WITH due AS (
    SELECT r.id, r.cash_order_id, r.square_refund_id, r.amount_jpy, r.status,
           coalesce(r.provider_created_at, r.created_at) AS started_at,
           o.customer_id, o.invoice_number, coalesce(o.web_reference, o.invoice_number, '') AS ref
      FROM public.square_refunds r JOIN public.cash_orders o ON o.id = r.cash_order_id
     WHERE r.status NOT IN ('COMPLETED','FAILED','REJECTED') AND r.warned_7d_at IS NULL
       AND coalesce(r.provider_created_at, r.created_at) <= p_now - interval '7 days'
     FOR UPDATE OF r SKIP LOCKED
  ), bell AS (
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    SELECT 'card_refund_pending', 'Card refund still not finished after 7 days',
           ref || ' · ¥' || to_char(round(amount_jpy), 'FM999,999,999') || ' — Square refund ' || square_refund_id
             || ' is still ' || status || ' since ' || to_char(started_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') || ' JST ('
             || floor(extract(epoch FROM p_now - started_at) / 86400)::int || ' days). Our policy promises 7 days — check it in the Square Dashboard.',
           customer_id, invoice_number,
           jsonb_build_object('cash_order_id', cash_order_id, 'square_refund_id', square_refund_id, 'amount_jpy', amount_jpy,
                              'status', status, 'started_at', started_at, 'stage', '7d')
      FROM due RETURNING 1
  )
  UPDATE public.square_refunds r SET warned_7d_at = p_now
    FROM due WHERE r.id = due.id AND (SELECT count(*) FROM bell) >= 0;
  GET DIAGNOSTICS v_r7 = ROW_COUNT;

  RETURN jsonb_build_object('hold_warnings', v_holds, 'dispute_3d', v_d3, 'dispute_1d', v_d1,
                            'refund_7d', v_r7, 'refund_14d', v_r14);$n$)
));
REVOKE ALL ON FUNCTION public.ring_square_deadline_bells(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ring_square_deadline_bells(timestamptz) TO service_role;

SELECT pg_temp.cj_patch('public.square_ops_health()', 'd296cf8f63dd8691cea424f9644b84a2', jsonb_build_array(
  jsonb_build_object('old', $o$    'refunds_open',        (SELECT count(*) FROM public.square_refunds WHERE status NOT IN ('COMPLETED','FAILED','REJECTED')),
$o$, 'new', $n$    'refunds_open',        (SELECT count(*) FROM public.square_refunds WHERE status NOT IN ('COMPLETED','FAILED','REJECTED')),
    'refund_oldest_pending_at', (SELECT min(coalesce(provider_created_at, created_at)) FROM public.square_refunds
                                  WHERE status NOT IN ('COMPLETED','FAILED','REJECTED')),
    'attempts_stuck',      (SELECT count(*) FROM public.square_card_attempts
                             WHERE status IN ('reserved','unknown','cancelling') AND stuck_warned_at IS NOT NULL),
$n$)));

-- ---------------------------------------------------------------------------
-- 4. S01 — a card attempt whose payment search cannot finish.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.note_square_attempt_stuck(p_attempt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v public.square_card_attempts%ROWTYPE;
  v_ref text; v_inv text; v_cust uuid;
BEGIN
  -- S01 (2026-10-08): square-reconcile calls this once per run in which the
  -- attempt is still open after its give-up time and could not be settled
  -- (Square's payment list could not be read to the end, or the payment it
  -- found is still processing). The third such run rings one bell; the
  -- attempt itself is never closed here (an incomplete search proves nothing).
  UPDATE public.square_card_attempts
     SET stuck_runs = stuck_runs + 1
   WHERE id = p_attempt_id AND status IN ('reserved','unknown','cancelling')
  RETURNING * INTO v;
  IF v.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_open');
  END IF;
  IF v.stuck_runs >= 3 AND v.stuck_warned_at IS NULL THEN
    SELECT coalesce(o.web_reference, o.invoice_number, ''), o.invoice_number, o.customer_id
      INTO v_ref, v_inv, v_cust FROM public.cash_orders o WHERE o.id = v.cash_order_id;
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    VALUES ('card_attempt_stuck', 'Card payment check could not finish',
            v_ref || ' · ¥' || to_char(v.amount_jpy, 'FM999,999,999') || ' — the hourly check could not settle card attempt '
              || v.reference || ' after ' || v.stuck_runs || ' tries (Square''s payment list could not be read to the end, or the payment is still processing). Look for this reference in the Square Dashboard (Transactions).',
            v_cust, v_inv,
            jsonb_build_object('cash_order_id', v.cash_order_id, 'attempt_id', v.id, 'reference', v.reference,
                               'environment', v.environment, 'stuck_runs', v.stuck_runs));
    UPDATE public.square_card_attempts SET stuck_warned_at = now() WHERE id = v.id;
    RETURN jsonb_build_object('ok', true, 'stuck_runs', v.stuck_runs, 'bell', true);
  END IF;
  RETURN jsonb_build_object('ok', true, 'stuck_runs', v.stuck_runs, 'bell', false);
END
$fn$;
REVOKE ALL ON FUNCTION public.note_square_attempt_stuck(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.note_square_attempt_stuck(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. S04 — Reassign Owner never moves a card order.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.reassign_order_owner_atomic(text,uuid,uuid,numeric,text,uuid,boolean,boolean)', 'bfb7f94d5e57dc56465e25a08050977f', jsonb_build_array(
  jsonb_build_object('old', $o$      'message', 'This order was paid, or started to be paid, with Paidy. A Paidy order belongs to the customer who signed in and paid, and cannot change owner.');
  END IF;
$o$, 'new', $n$      'message', 'This order was paid, or started to be paid, with Paidy. A Paidy order belongs to the customer who signed in and paid, and cannot change owner.');
  END IF;

  -- Square (S04, 2026-10-08): a card order is paid from the customer's own
  -- signed-in account, so it never changes owner. Any card history counts —
  -- an attempt (even one only reserved, not yet filed), a card payment row or
  -- a card submission. The order row is locked above, and
  -- reserve_square_attempt locks it too, so the two cannot interleave.
  IF p_kind = 'cash' AND (
       EXISTS (SELECT 1 FROM public.square_card_attempts sa WHERE sa.cash_order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM public.square_payments sp WHERE sp.cash_order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM public.payment_submissions ps
                WHERE ps.cash_order_id = p_order_id
                  AND (ps.payment_method = 'square' OR ps.square_payment_id IS NOT NULL))) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'card_order',
      'message', 'This order was paid, or started to be paid, by card. A card order belongs to the customer who signed in and paid, and cannot change owner.');
  END IF;
$n$)));
REVOKE ALL ON FUNCTION public.reassign_order_owner_atomic(text,uuid,uuid,numeric,text,uuid,boolean,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reassign_order_owner_atomic(text,uuid,uuid,numeric,text,uuid,boolean,boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. B01 — "refund issued" on a card order needs Square's completed refund.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text)', '5c5051464ec4e7c54ddceed0616bc4fe', jsonb_build_array(
  jsonb_build_object('old', $o$  v_method  text := lower(btrim(COALESCE(p_method, '')));
$o$, 'new', $n$  v_method  text := lower(btrim(COALESCE(p_method, '')));
  v_prev    jsonb;
  v_card_paid boolean;
  v_noncard numeric(12,2);
  v_card_refunded numeric(12,2);
$n$),
  jsonb_build_object('old', $o$  IF v_order.refund_status IS DISTINCT FROM 'refund_pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_refund_pending', 'refund_status', v_order.refund_status);
  END IF;
$o$, 'new', $n$  -- B01 (2026-10-08): the same request again after it succeeded (a retry
  -- after a lost answer) gets the same answer and writes nothing.
  IF v_order.refund_status = 'refund_issued' THEN
    SELECT a.new_value_json INTO v_prev FROM public.audit_logs a
     WHERE a.entity_type = 'cash_order' AND a.entity_id = p_order_id AND a.action = 'refund_marked_issued'
     ORDER BY a.created_at DESC LIMIT 1;
    IF v_prev IS NOT NULL AND v_prev ->> 'method' = v_method THEN
      RETURN jsonb_build_object('ok', true, 'already_recorded', true,
                                'amount', (v_prev ->> 'amount')::numeric, 'currency', v_prev ->> 'currency',
                                'method', v_method, 'refunded_on', v_prev ->> 'refunded_on',
                                'reference', COALESCE(v_order.web_reference, v_order.invoice_number));
    END IF;
  END IF;
  IF v_order.refund_status IS DISTINCT FROM 'refund_pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_refund_pending', 'refund_status', v_order.refund_status);
  END IF;
$n$),
  jsonb_build_object('old', $o$  SELECT COALESCE(SUM(amount_paid), 0) INTO v_amount
    FROM public.cash_payments
   WHERE cash_order_id = p_order_id AND voided_at IS NULL
     AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';
$o$, 'new', $n$  SELECT COALESCE(SUM(amount_paid), 0) INTO v_amount
    FROM public.cash_payments
   WHERE cash_order_id = p_order_id AND voided_at IS NULL
     AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';

  -- B01 (2026-10-08): card money goes back only through Square. A card-paid
  -- order is marked with method 'card', only once Square shows a COMPLETED
  -- refund, and the amount recorded is what Square completed (owner E7) —
  -- never the gross received. Other methods only for money that did not come
  -- by card.
  v_card_paid := EXISTS (SELECT 1 FROM public.cash_payments
                          WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'square');
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_noncard
    FROM public.cash_payments
   WHERE cash_order_id = p_order_id AND voided_at IS NULL
     AND COALESCE(payment_method, '') <> 'square'
     AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';
  IF v_method = 'card' AND NOT v_card_paid THEN
    RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'not_paid_by_card');
  END IF;
  IF v_method <> 'card' AND v_card_paid AND v_noncard <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'paid_by_card');
  END IF;
  -- Mixed payment (card + something else): a non-card method records only the
  -- non-card money; the card part comes back through Square and is recorded by
  -- Square's own refund email / the card row. Never the gross.
  IF v_method <> 'card' AND v_card_paid THEN
    v_amount := v_noncard;
  END IF;
  IF v_method = 'card' THEN
    SELECT COALESCE(SUM(amount_jpy), 0) INTO v_card_refunded
      FROM public.square_refunds WHERE cash_order_id = p_order_id AND status = 'COMPLETED';
    IF v_card_refunded <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_completed_card_refund');
    END IF;
    v_amount := LEAST(v_amount, v_card_refunded);
  END IF;
$n$)));
REVOKE ALL ON FUNCTION public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. Web cancel: the credit rule, and no "refund issued" on a card order.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)', '8df3c2f2ab0557dfc8ed5c5d8d34eb7b', jsonb_build_array(
  jsonb_build_object('old', $o$  v_member_id uuid; v_credit jsonb := NULL; v_revoked_tx uuid := NULL;
$o$, 'new', $n$  v_member_id uuid; v_credit jsonb := NULL; v_revoked_tx uuid := NULL;
  v_order_date date; v_split jsonb := NULL; v_card_paid boolean := false;
$n$),
  jsonb_build_object('old', $o$  SELECT status::text, currency, customer_id, invoice_number, web_reference, total_paid
    INTO v_status, v_currency, v_customer_id, v_invoice, v_web_ref, v_total_paid
$o$, 'new', $n$  SELECT status::text, currency, customer_id, invoice_number, web_reference, total_paid, order_date
    INTO v_status, v_currency, v_customer_id, v_invoice, v_web_ref, v_total_paid, v_order_date
$n$),
  jsonb_build_object('old', $o$      RAISE EXCEPTION 'refund_decision_required' USING ERRCODE='P0001';
    END IF;
$o$, 'new', $n$      RAISE EXCEPTION 'refund_decision_required' USING ERRCODE='P0001';
    END IF;
    -- B01 (2026-10-08): card money goes back only through Square, so a card
    -- order cannot be closed as "refund issued" here: choose "refund pending",
    -- refund in Square, then "Mark refund issued" once Square shows it.
    v_card_paid := EXISTS (SELECT 1 FROM public.cash_payments
                            WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'square');
    IF NOT p_preview AND v_money_received > 0 AND p_refund_status = 'refund_issued' AND v_card_paid THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'card_refund_needs_square',
        'status', v_status);
    END IF;
    -- Cancellation credit rule (owner 2026-10-06/08): same day as order_date →
    -- 100 %; later → 30 % of the money paid kept, 70 % credit. No override.
    v_split := public.cancellation_credit_split(v_currency, v_order_date, v_money_received, v_now);
$n$),
  jsonb_build_object('old', $o$    IF p_refund_status = 'store_credit_issued' THEN
      v_issue_amount := GREATEST(0, v_money_received - v_partial_credit);
    END IF;
$o$, 'new', $n$    IF p_refund_status = 'store_credit_issued' THEN
      v_issue_amount := GREATEST(0, (v_split ->> 'credit')::numeric - v_partial_credit);
    END IF;
$n$),
  jsonb_build_object('old', $o$      'store_credit_to_issue', v_issue_amount,
      'refund_decision_required', (v_money_received > 0),
$o$, 'new', $n$      'store_credit_to_issue', v_issue_amount,
      'store_credit_if_chosen', GREATEST(0, COALESCE((v_split ->> 'credit')::numeric, 0) - v_partial_credit),
      'cancellation_rule', v_split ->> 'rule',
      'cancellation_charge', COALESCE((v_split ->> 'kept')::numeric, 0),
      'cancellation_split', v_split,
      'paid_by_card', v_card_paid,
      'refund_decision_required', (v_money_received > 0),
$n$),
  jsonb_build_object('old', $o$         WHEN v_issue_amount > 0 THEN ' — store credit issued: ' || (CASE WHEN v_currency='PHP' THEN '₱' ELSE '¥' END) || v_issue_amount
$o$, 'new', $n$         WHEN v_issue_amount > 0 THEN ' — store credit issued: ' || (CASE WHEN v_currency='PHP' THEN '₱' ELSE '¥' END) || v_issue_amount
           || CASE WHEN COALESCE((v_split ->> 'kept')::numeric, 0) > 0
                   THEN ' (30% cancellation charge kept: ' || (CASE WHEN v_currency='PHP' THEN '₱' ELSE '¥' END) || (v_split ->> 'kept') || ')'
                   ELSE '' END
$n$),
  jsonb_build_object('old', $o$      'store_credit_issued', v_credit, 'earned_points_revoked_tx', v_revoked_tx,
$o$, 'new', $n$      'store_credit_issued', v_credit, 'cancellation_split', v_split, 'earned_points_revoked_tx', v_revoked_tx,
$n$),
  jsonb_build_object('old', $o$    'store_credit', v_credit, 'earned_points_revoked_tx', v_revoked_tx,
$o$, 'new', $n$    'store_credit', v_credit, 'cancellation_split', v_split, 'earned_points_revoked_tx', v_revoked_tx,
$n$)));
REVOKE ALL ON FUNCTION public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- 8. Hub cash-order cancel: the credit rule (Shopify unchanged).
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text)', '1d3a1f5004e7b12127f5c6f0604bea55', jsonb_build_array(
  jsonb_build_object('old', $o$  v_reason text; v_is_system boolean;
$o$, 'new', $n$  v_reason text; v_is_system boolean;
  v_order_date date; v_shopify_id text; v_split jsonb;
$n$),
  jsonb_build_object('old', $o$  SELECT status::text, currency, customer_id, invoice_number
    INTO v_status, v_currency, v_customer_id, v_invoice
  FROM public.cash_orders WHERE id = p_cash_order_id FOR UPDATE;
$o$, 'new', $n$  SELECT status::text, currency, customer_id, invoice_number, order_date, shopify_order_id
    INTO v_status, v_currency, v_customer_id, v_invoice, v_order_date, v_shopify_id
  FROM public.cash_orders WHERE id = p_cash_order_id FOR UPDATE;
$n$),
  jsonb_build_object('old', $o$  v_issue_amount := GREATEST(0, v_money_received - v_partial_credit);
$o$, 'new', $n$  -- Cancellation credit rule (owner 2026-10-06/08): a Hub cash order
  -- cancelled on its order_date → 100 % credit; later → 30 % of the
  -- money paid is kept, 70 % credit. Shopify orders keep 100 % (owner E3).
  IF v_is_system OR v_shopify_id IS NOT NULL THEN
    v_split := jsonb_build_object('rule', 'shopify_full', 'charge_pct', 0, 'money', v_money_received,
                                  'kept', 0, 'credit', v_money_received, 'order_date', v_order_date);
  ELSE
    v_split := public.cancellation_credit_split(v_currency, v_order_date, v_money_received, now());
  END IF;
  v_issue_amount := GREATEST(0, (v_split ->> 'credit')::numeric - v_partial_credit);
$n$),
  jsonb_build_object('old', $o$      'store_credit_to_issue', v_issue_amount,
      'earned_points_will_be_revoked', true);
$o$, 'new', $n$      'store_credit_to_issue', v_issue_amount,
      'cancellation_rule', v_split ->> 'rule',
      'cancellation_charge', COALESCE((v_split ->> 'kept')::numeric, 0),
      'cancellation_split', v_split,
      'earned_points_will_be_revoked', true);
$n$),
  jsonb_build_object('old', $o$      WHEN v_issue_amount > 0 THEN ' — store credit issued: ' || (CASE WHEN v_currency='PHP' THEN '₱' ELSE '¥' END) || v_issue_amount
$o$, 'new', $n$      WHEN v_issue_amount > 0 THEN ' — store credit issued: ' || (CASE WHEN v_currency='PHP' THEN '₱' ELSE '¥' END) || v_issue_amount
        || CASE WHEN COALESCE((v_split ->> 'kept')::numeric, 0) > 0
                THEN ' (30% cancellation charge kept: ' || (CASE WHEN v_currency='PHP' THEN '₱' ELSE '¥' END) || (v_split ->> 'kept') || ')'
                ELSE '' END
$n$),
  jsonb_build_object('old', $o$    'store_credit_issued', v_credit, 'earned_points_revoked_tx', v_revoked_tx,
    'source', p_source,
$o$, 'new', $n$    'store_credit_issued', v_credit, 'cancellation_split', v_split, 'earned_points_revoked_tx', v_revoked_tx,
    'source', p_source,
$n$),
  jsonb_build_object('old', $o$    'store_credit', v_credit, 'earned_points_revoked_tx', v_revoked_tx, 'source', p_source);
$o$, 'new', $n$    'store_credit', v_credit, 'cancellation_split', v_split, 'earned_points_revoked_tx', v_revoked_tx, 'source', p_source);
$n$)));
REVOKE ALL ON FUNCTION public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text) TO service_role;

-- ---------------------------------------------------------------------------
-- 9. Self-checks: everything above is in place, or the migration rolls back.
-- ---------------------------------------------------------------------------
DO $check$
DECLARE v text;
BEGIN
  v := pg_get_functiondef('public.ring_square_deadline_bells(timestamp with time zone)'::regprocedure);
  IF position('card_refund_pending' IN v) = 0 THEN RAISE EXCEPTION 'STOP — S05 bell missing'; END IF;
  v := pg_get_functiondef('public.square_ops_health()'::regprocedure);
  IF position('refund_oldest_pending_at' IN v) = 0 THEN RAISE EXCEPTION 'STOP — S05 health field missing'; END IF;
  v := pg_get_functiondef('public.reassign_order_owner_atomic(text,uuid,uuid,numeric,text,uuid,boolean,boolean)'::regprocedure);
  IF position('''card_order''' IN v) = 0 THEN RAISE EXCEPTION 'STOP — S04 refusal missing'; END IF;
  v := pg_get_functiondef('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text)'::regprocedure);
  IF position('no_completed_card_refund' IN v) = 0 OR position('already_recorded' IN v) = 0 THEN RAISE EXCEPTION 'STOP — B01 missing'; END IF;
  v := pg_get_functiondef('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)'::regprocedure);
  IF position('cancellation_credit_split' IN v) = 0 OR position('card_refund_needs_square' IN v) = 0 THEN RAISE EXCEPTION 'STOP — web cancel rule missing'; END IF;
  v := pg_get_functiondef('public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text)'::regprocedure);
  IF position('cancellation_credit_split' IN v) = 0 THEN RAISE EXCEPTION 'STOP — Hub cancel rule missing'; END IF;
  IF to_regprocedure('public.note_square_attempt_stuck(uuid)') IS NULL THEN RAISE EXCEPTION 'STOP — S01 function missing'; END IF;
  -- The formula itself, on fixed instants (PHT = UTC+8).
  IF (public.cancellation_credit_split('JPY', DATE '2026-10-08', 100000, TIMESTAMPTZ '2026-10-08 15:59:59+00') ->> 'credit')::numeric <> 100000
  OR (public.cancellation_credit_split('JPY', DATE '2026-10-08', 100000, TIMESTAMPTZ '2026-10-08 16:00:00+00') ->> 'credit')::numeric <> 70000
  OR (public.cancellation_credit_split('JPY', DATE '2026-10-08', 40001, TIMESTAMPTZ '2026-10-10 00:00:00+00') ->> 'kept')::numeric <> 12000 THEN
    RAISE EXCEPTION 'STOP — cancellation_credit_split gives wrong figures';
  END IF;
END
$check$;