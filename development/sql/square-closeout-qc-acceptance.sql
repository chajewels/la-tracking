-- Square close-out QC acceptance tests (2026-10-05). NOT a migration — never applied to live.
-- Runs on a local Postgres copy of the live schema with migration 20261108100000 applied, after
-- stubbing auth.uid() (current_setting('test.uid')), has_role / is_staff (user_roles lookup).
-- Everything runs in one transaction and is rolled back. Expected: 74 passed, 0 failed.
-- Also: development/sql/square-closeout-qc-race.sh (QC10, must end COMPLETED) and
-- development/sql/square-closeout-qc-deadlock.sh (decide vs Finish recording, must print no deadlock).

-- Acceptance tests for the Square close-out QC fixes (QC01–QC04, QC10, QC12).
-- Run on the qc copy: psql -v ON_ERROR_STOP=1 -f 10_tests.sql
-- Everything runs in one transaction and is rolled back.
\set QUIET on
BEGIN;
CREATE TEMP TABLE t_results (n serial, name text, pass boolean, detail text);

INSERT INTO public.user_roles (user_id, role) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'admin'),
  ('f0000000-0000-0000-0000-000000000002', 'finance'),
  ('50000000-0000-0000-0000-000000000003', 'staff');

CREATE FUNCTION pg_temp.ok(p_cond boolean, p_name text, p_detail text DEFAULT NULL) RETURNS void LANGUAGE sql AS
$$ INSERT INTO t_results (name, pass, detail) VALUES (p_name, coalesce(p_cond, false), p_detail) $$;

-- Runs p_sql; true when it raises an error whose message matches p_pattern.
CREATE FUNCTION pg_temp.raises(p_sql text, p_pattern text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM ~* p_pattern;
END $$;

CREATE FUNCTION pg_temp.as_user(p_uid text) RETURNS void LANGUAGE sql AS
$$ SELECT set_config('test.uid', p_uid, true) $$;

CREATE FUNCTION pg_temp.mk_order(p_total numeric DEFAULT 10000) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_c uuid := gen_random_uuid(); v_o uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.customers (id) VALUES (v_c);
  INSERT INTO public.cash_orders (id, invoice_number, customer_id, currency, total_amount, total_paid, remaining_balance, status, source_channel)
  VALUES (v_o, 'T' || substr(v_o::text, 1, 8), v_c, 'JPY', p_total, 0, p_total, 'pending', 'web');
  RETURN v_o;
END $$;

-- A square_payments row on the order. p_status authorized | captured.
CREATE FUNCTION pg_temp.mk_sq(p_order uuid, p_status text, p_amount bigint DEFAULT 10000) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid(); v_c uuid;
BEGIN
  SELECT customer_id INTO v_c FROM public.cash_orders WHERE id = p_order;
  INSERT INTO public.square_payments (id, cash_order_id, customer_id, square_payment_id, status, test, amount_jpy, currency,
         captured_amount_jpy, captured_at, environment)
  VALUES (v_id, p_order, v_c, 'sq_' || replace(v_id::text, '-', ''), p_status, true, p_amount, 'JPY',
          CASE WHEN p_status = 'captured' THEN p_amount END, CASE WHEN p_status = 'captured' THEN now() END, 'sandbox');
  RETURN v_id;
END $$;

-- A reviewer's claimed card Confirm (status confirmed, not recorded).
CREATE FUNCTION pg_temp.mk_claim(p_order uuid, p_sq uuid, p_amount numeric DEFAULT 10000, p_type text DEFAULT 'cash_payment') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid(); v_c uuid;
BEGIN
  SELECT customer_id INTO v_c FROM public.cash_orders WHERE id = p_order;
  INSERT INTO public.payment_submissions (id, customer_id, cash_order_id, submitted_amount, payment_date, payment_method,
         status, square_payment_id, submission_type)
  VALUES (v_id, v_c, p_order, p_amount, current_date, 'square', 'confirmed', p_sq, p_type);
  RETURN v_id;
END $$;

CREATE FUNCTION pg_temp.fin(p_sub uuid) RETURNS jsonb LANGUAGE sql AS
$$ SELECT public.finalize_cash_submission_atomic(p_sub, 'a0000000-0000-0000-0000-000000000001', NULL, current_date, 'staff') $$;

CREATE FUNCTION pg_temp.sqid(p_sq uuid) RETURNS text LANGUAGE sql AS
$$ SELECT square_payment_id FROM public.square_payments WHERE id = p_sq $$;

-- ===========================================================================
-- QC01 — refunds before allocation
-- ===========================================================================
DO $$
DECLARE o uuid; s uuid; sub uuid; r jsonb;
BEGIN
  -- full refund reported on the payment (refunded_money)
  o := pg_temp.mk_order(); s := pg_temp.mk_sq(o, 'captured'); sub := pg_temp.mk_claim(o, s);
  UPDATE public.square_payments SET refund_jpy = 10000 WHERE id = s;
  r := pg_temp.fin(sub);
  PERFORM pg_temp.ok(r->>'error' = 'square_refunded', 'QC01 full refund (refund_jpy) refuses recording', r::text);
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.cash_payments WHERE cash_order_id = o), 'QC01 full refund writes no ledger row');
  PERFORM pg_temp.ok((SELECT exception FROM public.square_payments WHERE id = s) = 'refunded_before_record', 'QC01 full refund flags refunded_before_record');
  PERFORM pg_temp.ok(public.square_order_unresolved(o), 'QC01 refunded capture keeps the order gate closed');

  -- pending refund only in square_refunds (refunded_money still 0)
  o := pg_temp.mk_order(); s := pg_temp.mk_sq(o, 'captured'); sub := pg_temp.mk_claim(o, s);
  INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, status)
  VALUES ('rf_' || s, s, pg_temp.sqid(s), o, 2000, 'PENDING');
  r := pg_temp.fin(sub);
  PERFORM pg_temp.ok(r->>'error' = 'square_refunded', 'QC01 pending partial refund refuses recording', r::text);

  -- completed partial refund
  o := pg_temp.mk_order(); s := pg_temp.mk_sq(o, 'captured'); sub := pg_temp.mk_claim(o, s);
  INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, status)
  VALUES ('rf_' || s, s, pg_temp.sqid(s), o, 2000, 'COMPLETED');
  r := pg_temp.fin(sub);
  PERFORM pg_temp.ok(r->>'error' = 'square_refunded', 'QC01 completed partial refund refuses full credit', r::text);

  -- a FAILED refund does not remove credit
  o := pg_temp.mk_order(); s := pg_temp.mk_sq(o, 'captured'); sub := pg_temp.mk_claim(o, s);
  INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, status)
  VALUES ('rf_' || s, s, pg_temp.sqid(s), o, 2000, 'FAILED');
  r := pg_temp.fin(sub);
  PERFORM pg_temp.ok((r->>'ok')::boolean AND r->>'outcome' = 'recorded', 'QC01 failed refund still records the capture', r::text);
  PERFORM pg_temp.ok((SELECT provider_capture_id FROM public.cash_payments WHERE cash_order_id = o) = pg_temp.sqid(s),
                     'QC03 recorded card row carries provider_capture_id = Square payment id');
  PERFORM pg_temp.ok(NOT public.square_order_unresolved(o), 'QC01 recorded capture opens the gate');
  r := pg_temp.fin(sub);
  PERFORM pg_temp.ok(r->>'outcome' = 'already_recorded', 'finalize stays idempotent', r::text);
END $$;

-- ===========================================================================
-- QC03 / QC04 / QC12 — the ledger guard
-- ===========================================================================
DO $$
DECLARE o uuid; o2 uuid; s uuid; sub uuid; r jsonb; pid uuid; v_cp uuid;
BEGIN
  -- captured, unallocated card money on the order
  o := pg_temp.mk_order(); s := pg_temp.mk_sq(o, 'captured');
  PERFORM pg_temp.ok(pg_temp.raises(format(
    $q$INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, date_paid, payment_method) VALUES (%L, 10000, 'JPY', current_date, 'square')$q$, o),
    'provider'), 'QC03 direct square INSERT without evidence refused');
  PERFORM pg_temp.ok(pg_temp.raises(format(
    $q$INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, date_paid, payment_method, provider_capture_id) VALUES (%L, 10000, 'JPY', current_date, 'square', 'sq_made_up')$q$, o),
    'provider'), 'QC03 direct square INSERT with a made-up capture id refused');
  PERFORM pg_temp.ok(pg_temp.raises(format(
    $q$INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, date_paid, payment_method) VALUES (%L, 5000, 'JPY', current_date, 'paidy')$q$, o),
    'provider|card_payment_unresolved'), 'QC03 direct paidy INSERT during a card lock refused');
  PERFORM pg_temp.ok(pg_temp.raises(format(
    $q$INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, date_paid, payment_method, provider_capture_id) VALUES (%L, 9000, 'JPY', current_date, 'square', %L)$q$, o, pg_temp.sqid(s)),
    'provider'), 'QC03 square INSERT with the real id but a wrong amount refused');
  PERFORM pg_temp.ok(pg_temp.raises(format(
    $q$INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, date_paid, payment_method) VALUES (%L, 1000, 'JPY', current_date, 'store_credit')$q$, o),
    'card_payment_unresolved'), 'store credit refused while card money is unrecorded');

  -- no lock: a plain manual payment is fine, then amount edits are fine
  o2 := pg_temp.mk_order();
  INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, date_paid, payment_method) VALUES (o2, 1000, 'JPY', current_date, 'bank_transfer')
  RETURNING id INTO pid;
  UPDATE public.cash_payments SET amount_paid = 1200 WHERE id = pid;
  PERFORM pg_temp.ok((SELECT amount_paid FROM public.cash_payments WHERE id = pid) = 1200, 'no lock: manual payment edit allowed');
  PERFORM pg_temp.ok(pg_temp.raises(format($q$UPDATE public.cash_payments SET payment_method = 'square' WHERE id = %L$q$, pid), 'provider'),
                     'QC03 relabelling a manual row as square refused');

  -- QC12: a live hold freezes amount edits on other rows and the order total
  s := pg_temp.mk_sq(o2, 'authorized', 9000);
  PERFORM pg_temp.ok(pg_temp.raises(format($q$UPDATE public.cash_payments SET amount_paid = 1500 WHERE id = %L$q$, pid), 'card_payment_unresolved'),
                     'QC12 amount edit of a live row refused during a card hold');
  PERFORM pg_temp.ok(pg_temp.raises(format($q$UPDATE public.cash_orders SET total_amount = 20000 WHERE id = %L$q$, o2), 'card_payment_unresolved'),
                     'QC12 order total edit refused during a card hold');
  PERFORM pg_temp.ok(pg_temp.raises(format($q$UPDATE public.cash_orders SET shipping_fee = 800 WHERE id = %L$q$, o2), 'card_payment_unresolved'),
                     'QC12 shipping fee edit refused during a card hold');
  -- a non-balance edit of the order is still fine during a hold
  UPDATE public.cash_orders SET refund_note = 'touch' WHERE id = o2;
  PERFORM pg_temp.ok((SELECT refund_note FROM public.cash_orders WHERE id = o2) = 'touch', 'QC12 non-balance order edit allowed during a hold');
END $$;

DO $$
DECLARE o uuid; s uuid; sub uuid; r jsonb; pid uuid;
BEGIN
  -- a recorded card receipt is immutable
  o := pg_temp.mk_order(); s := pg_temp.mk_sq(o, 'captured'); sub := pg_temp.mk_claim(o, s);
  r := pg_temp.fin(sub);
  pid := (r->'cash_payment'->>'id')::uuid;
  PERFORM pg_temp.ok(pid IS NOT NULL, 'card capture recorded for the immutability tests', r::text);
  PERFORM pg_temp.ok(pg_temp.raises(format($q$UPDATE public.cash_payments SET voided_at = now(), void_reason = 'x' WHERE id = %L$q$, pid), 'provider_payment_immutable'),
                     'QC04 local void of a card receipt refused');
  PERFORM pg_temp.ok(pg_temp.raises(format($q$UPDATE public.cash_payments SET amount_paid = 1 WHERE id = %L$q$, pid), 'provider_payment_immutable'),
                     'QC04 amount change of a card receipt refused');
  PERFORM pg_temp.ok(pg_temp.raises(format($q$DELETE FROM public.cash_payments WHERE id = %L$q$, pid), 'provider_payment_immutable'),
                     'QC04 delete of a card receipt refused');
  PERFORM pg_temp.ok(pg_temp.raises(format($q$UPDATE public.cash_payments SET payment_method = 'bank_transfer' WHERE id = %L$q$, pid), 'provider_payment_immutable'),
                     'QC04 relabel of a card receipt refused');
  UPDATE public.cash_payments SET remarks = 'note' WHERE id = pid;
  PERFORM pg_temp.ok((SELECT remarks FROM public.cash_payments WHERE id = pid) = 'note', 'a remark on a card receipt is still allowed');
  -- the same capture can never be recorded twice
  PERFORM pg_temp.ok(pg_temp.raises(format(
    $q$INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, date_paid, payment_method, provider_capture_id) VALUES (%L, 10000, 'JPY', current_date, 'square', %L)$q$, o, pg_temp.sqid(s)),
    'provider|duplicate'), 'QC03 second ledger row for the same capture refused');
END $$;

-- Paidy's own recording still works (evidence-bound).
DO $$
DECLARE o uuid; c uuid; pp uuid := gen_random_uuid(); sub uuid := gen_random_uuid(); r jsonb;
BEGIN
  o := pg_temp.mk_order(8000);
  SELECT customer_id INTO c FROM public.cash_orders WHERE id = o;
  INSERT INTO public.paidy_payments (id, status, cash_order_id, customer_id, amount_jpy, capture_id, refund_jpy, last_payload, test)
  VALUES (pp, 'captured', o, c, 8000, 'cap_' || pp, 0, jsonb_build_object('captures', jsonb_build_array(jsonb_build_object('amount', 8000))), true);
  INSERT INTO public.payment_submissions (id, customer_id, cash_order_id, submitted_amount, payment_date, payment_method, status, paidy_payment_id)
  VALUES (sub, c, o, 8000, current_date, 'paidy', 'confirmed', pp);
  r := pg_temp.fin(sub);
  PERFORM pg_temp.ok(r->>'outcome' = 'recorded', 'Paidy recording still passes the ledger guard', r::text);
  PERFORM pg_temp.ok(pg_temp.raises(format($q$UPDATE public.cash_payments SET voided_at = now() WHERE cash_order_id = %L$q$, o), 'provider_payment_immutable'),
                     'QC04 local void of a Paidy receipt refused');
END $$;

-- ===========================================================================
-- QC02 — decisions vs verified resolution
-- ===========================================================================
DO $$
DECLARE o uuid; s uuid; sub uuid; r jsonb; n int;
BEGIN
  PERFORM pg_temp.as_user('f0000000-0000-0000-0000-000000000002'); -- finance
  o := pg_temp.mk_order(); s := pg_temp.mk_sq(o, 'captured'); sub := pg_temp.mk_claim(o, s);
  UPDATE public.square_payments SET exception = 'captured_unallocated', exception_at = now() WHERE id = s;

  r := public.decide_square_case('exception', s, 'other', 'customer called');
  PERFORM pg_temp.ok((r->>'ok')::boolean AND coalesce((r->>'resolved')::boolean, false) = false, 'QC02 "other" is recorded but resolves nothing', r::text);
  PERFORM pg_temp.ok(public.square_order_unresolved(o), 'QC02 "other" keeps the gate closed');
  PERFORM pg_temp.ok((SELECT status::text FROM public.payment_submissions WHERE id = sub) = 'confirmed', 'QC02 "other" leaves the claimed Confirm alone');
  PERFORM pg_temp.ok((SELECT to_jsonb(sp)->>'exception_decision' FROM public.square_payments sp WHERE sp.id = s) = 'other', 'QC02 decision is stored separately');

  r := public.decide_square_case('exception', s, 'refunded_in_square', 'refunded');
  PERFORM pg_temp.ok(r->>'error' = 'refund_not_verified', 'QC02 refunded_in_square without a completed refund refused', r::text);
  PERFORM pg_temp.ok(public.square_order_unresolved(o), 'QC02 unverified refund keeps the gate closed');

  r := public.decide_square_case('exception', s, 'voided_in_square', 'voided');
  PERFORM pg_temp.ok(r->>'error' = 'void_not_verified', 'QC02 voided_in_square on captured money refused', r::text);

  INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, status)
  VALUES ('rf_' || s, s, pg_temp.sqid(s), o, 10000, 'PENDING');
  r := public.decide_square_case('exception', s, 'refunded_in_square', 'refunded');
  PERFORM pg_temp.ok(r->>'error' = 'refund_not_verified', 'QC02 a PENDING refund does not resolve', r::text);

  UPDATE public.square_refunds SET status = 'COMPLETED' WHERE square_payment_row = s;
  r := public.decide_square_case('exception', s, 'refunded_in_square', 'refunded in full');
  PERFORM pg_temp.ok((r->>'ok')::boolean AND (r->>'resolved')::boolean, 'QC02 completed full refund resolves', r::text);
  PERFORM pg_temp.ok(NOT public.square_order_unresolved(o), 'QC02 verified refund opens the gate');
  PERFORM pg_temp.ok((SELECT status::text FROM public.payment_submissions WHERE id = sub) = 'rejected', 'QC02 verified refund closes the claimed Confirm');

  -- staff (not admin/finance) cannot decide exceptions
  PERFORM pg_temp.as_user('50000000-0000-0000-0000-000000000003');
  o := pg_temp.mk_order(); s := pg_temp.mk_sq(o, 'captured');
  UPDATE public.square_payments SET exception = 'captured_unallocated', exception_at = now() WHERE id = s;
  r := public.decide_square_case('exception', s, 'other', 'x');
  PERFORM pg_temp.ok(r->>'error' = 'not_permitted', 'QC02 staff cannot decide a card exception', r::text);
END $$;

-- record_on_order: hands the capture to the normal Confirm path (finalizer checks).
DO $$
DECLARE o uuid; s uuid; r jsonb; sub uuid;
BEGIN
  PERFORM pg_temp.as_user('a0000000-0000-0000-0000-000000000001');
  o := pg_temp.mk_order(); s := pg_temp.mk_sq(o, 'captured');
  UPDATE public.square_payments SET exception = 'captured_after_close', exception_at = now() WHERE id = s;
  r := public.decide_square_case('exception', s, 'record_on_order', 'customer confirmed, record it');
  sub := (r->>'submission_id')::uuid;
  PERFORM pg_temp.ok((r->>'ok')::boolean AND sub IS NOT NULL AND r->>'next' = 'confirm_submission', 'QC02 record_on_order creates a claimed card Confirm', r::text);
  PERFORM pg_temp.ok(public.square_order_unresolved(o), 'QC02 record_on_order alone does not open the gate');
  r := pg_temp.fin(sub);
  PERFORM pg_temp.ok(r->>'outcome' = 'recorded', 'QC02 the claimed Confirm records through the finalizer', r::text);
  PERFORM pg_temp.ok(NOT public.square_order_unresolved(o), 'QC02 gate opens once the ledger row exists');
  PERFORM pg_temp.ok((SELECT exception_resolved_at IS NOT NULL FROM public.square_payments WHERE id = s), 'QC02 binding the capture closes its exception');
  r := public.decide_square_case('exception', s, 'record_on_order', 'again');
  PERFORM pg_temp.ok(r->>'error' IN ('already_recorded', 'not_found'), 'QC02 record_on_order twice refused', r::text);

  -- refunded capture cannot be recorded in full through record_on_order
  o := pg_temp.mk_order(); s := pg_temp.mk_sq(o, 'captured');
  UPDATE public.square_payments SET exception = 'captured_unallocated', exception_at = now() WHERE id = s;
  INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, status)
  VALUES ('rf_' || s, s, pg_temp.sqid(s), o, 2000, 'COMPLETED');
  r := public.decide_square_case('exception', s, 'record_on_order', 'x');
  PERFORM pg_temp.ok(r->>'error' = 'square_refunded', 'QC01/02 record_on_order refuses a refunded capture', r::text);

  -- net after a completed partial refund: explicit decision, exact net
  r := public.decide_square_case('exception', s, 'record_net_after_refund', 'order reduced by 2,000, refunded the difference');
  sub := (r->>'submission_id')::uuid;
  PERFORM pg_temp.ok((r->>'ok')::boolean AND (SELECT submitted_amount FROM public.payment_submissions WHERE id = sub) = 8000,
                     'QC01 net-after-refund creates a claimed Confirm for captured − completed refunds', r::text);
  r := pg_temp.fin(sub);
  PERFORM pg_temp.ok(r->>'outcome' = 'recorded' AND (r->'cash_payment'->>'amount_paid')::numeric = 8000, 'QC01 net-after-refund records exactly the net', r::text);

  -- net path refused while a refund is still pending
  o := pg_temp.mk_order(); s := pg_temp.mk_sq(o, 'captured');
  UPDATE public.square_payments SET exception = 'captured_unallocated', exception_at = now() WHERE id = s;
  INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, status)
  VALUES ('rf_' || s, s, pg_temp.sqid(s), o, 2000, 'PENDING');
  r := public.decide_square_case('exception', s, 'record_net_after_refund', 'x');
  PERFORM pg_temp.ok(r->>'error' = 'refund_pending', 'QC01 net-after-refund waits for pending refunds', r::text);

  -- a plain submission claiming the net amount without the decision marker is refused
  o := pg_temp.mk_order(); s := pg_temp.mk_sq(o, 'captured'); sub := pg_temp.mk_claim(o, s, 8000);
  INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, status)
  VALUES ('rf_' || s, s, pg_temp.sqid(s), o, 2000, 'COMPLETED');
  r := pg_temp.fin(sub);
  PERFORM pg_temp.ok(r->>'error' IN ('square_refunded', 'square_amount_mismatch'), 'QC01 net amount without the staff decision refused', r::text);
END $$;

-- Refund / dispute decisions must match the provider state.
DO $$
DECLARE o uuid; s uuid; rid uuid; did uuid; r jsonb;
BEGIN
  PERFORM pg_temp.as_user('50000000-0000-0000-0000-000000000003');
  o := pg_temp.mk_order(); s := pg_temp.mk_sq(o, 'captured');
  INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, status)
  VALUES ('rf_' || s, s, pg_temp.sqid(s), o, 10000, 'PENDING') RETURNING id INTO rid;
  r := public.decide_square_case('refund', rid, 'order_cancelled_refunded', 'x');
  PERFORM pg_temp.ok(r->>'error' = 'state_mismatch', 'QC02 refund decision "refunded" refused while PENDING', r::text);
  r := public.decide_square_case('refund', rid, 'other', 'waiting');
  PERFORM pg_temp.ok((r->>'ok')::boolean, 'QC02 refund note allowed while PENDING', r::text);
  INSERT INTO public.square_disputes (square_dispute_id, square_payment_row, square_payment_id, cash_order_id, state)
  VALUES ('dp_' || s, s, pg_temp.sqid(s), o, 'EVIDENCE_REQUIRED') RETURNING id INTO did;
  r := public.decide_square_case('dispute', did, 'won', 'x');
  PERFORM pg_temp.ok(r->>'error' = 'state_mismatch', 'QC02 dispute "won" refused unless Square says WON', r::text);
  UPDATE public.square_disputes SET state = 'WON' WHERE id = did;
  r := public.decide_square_case('dispute', did, 'won', 'won');
  PERFORM pg_temp.ok((r->>'ok')::boolean, 'QC02 dispute "won" accepted once WON', r::text);
END $$;

-- ===========================================================================
-- QC10 — ordering of refund / dispute observations (sequential part)
-- ===========================================================================
DO $$
DECLARE o uuid; s uuid; r jsonb;
BEGIN
  o := pg_temp.mk_order(); s := pg_temp.mk_sq(o, 'captured');
  r := public.record_square_refund('rf_order_' || s, pg_temp.sqid(s), 'COMPLETED', 10000, NULL, now() - interval '1 hour', now(), '{"amount_money":{"amount":10000,"currency":"JPY"}}'::jsonb);
  r := public.record_square_refund('rf_order_' || s, pg_temp.sqid(s), 'PENDING', 10000, NULL, now() - interval '1 hour', now() - interval '10 minutes', '{"amount_money":{"amount":10000,"currency":"JPY"}}'::jsonb);
  PERFORM pg_temp.ok((SELECT status FROM public.square_refunds WHERE square_refund_id = 'rf_order_' || s) = 'COMPLETED', 'QC10 older PENDING never replaces COMPLETED', r::text);
  r := public.record_square_refund('rf_order_' || s, pg_temp.sqid(s), 'PENDING', 10000, NULL, now() - interval '1 hour', NULL, '{"amount_money":{"amount":10000,"currency":"JPY"}}'::jsonb);
  PERFORM pg_temp.ok((SELECT status FROM public.square_refunds WHERE square_refund_id = 'rf_order_' || s) = 'COMPLETED', 'QC10 terminal refund never reverts (no timestamp)', r::text);
  -- refund on captured-unrecorded money flags the payment
  PERFORM pg_temp.ok((SELECT exception FROM public.square_payments WHERE id = s) = 'refunded_before_record', 'QC01 refund on unrecorded capture flags refunded_before_record');

  r := public.record_square_dispute('dp_order_' || s, pg_temp.sqid(s), 'WON', NULL, 10000, NULL, now() - interval '2 hours', now(), '{}'::jsonb);
  r := public.record_square_dispute('dp_order_' || s, pg_temp.sqid(s), 'EVIDENCE_REQUIRED', NULL, 10000, NULL, now() - interval '2 hours', now() - interval '1 hour', '{}'::jsonb);
  PERFORM pg_temp.ok((SELECT state FROM public.square_disputes WHERE square_dispute_id = 'dp_order_' || s) = 'WON', 'QC10 older dispute state never replaces WON', r::text);
END $$;

-- ===========================================================================
-- Independent-review follow-ups (#2, #4, #6, #7)
-- ===========================================================================
DO $$
DECLARE o uuid; s uuid; sub uuid; r jsonb; n int;
BEGIN
  -- #6: real evidence, exact amount, but outside the Hub's recording → refused
  o := pg_temp.mk_order(); s := pg_temp.mk_sq(o, 'captured');
  PERFORM pg_temp.ok(pg_temp.raises(format(
    $q$INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, date_paid, payment_method, provider_capture_id) VALUES (%L, 10000, 'JPY', current_date, 'square', %L)$q$, o, pg_temp.sqid(s)),
    'provider_evidence_required'), 'review#6 direct INSERT with real evidence outside finalize refused');
  -- and finalize's own marker does not leak to a later statement
  sub := pg_temp.mk_claim(o, s); r := pg_temp.fin(sub);
  PERFORM pg_temp.ok(r->>'outcome' = 'recorded', 'review#6 finalize still records', r::text);
  PERFORM pg_temp.ok(coalesce(current_setting('app.provider_recording', true), '') = '', 'review#6 recording marker cleared after the insert');

  -- #4: a refund arriving after the capture was recorded does not flag it
  r := public.record_square_refund('rf_after_' || s, pg_temp.sqid(s), 'PENDING', 1000, NULL, now(), now(), '{"amount_money":{"amount":1000,"currency":"JPY"}}'::jsonb);
  PERFORM pg_temp.ok((SELECT exception FROM public.square_payments WHERE id = s) IS NULL, 'review#4 refund on a recorded capture never flags refunded_before_record');

  -- #7: a claim for another amount is replaced, not reused
  PERFORM pg_temp.as_user('a0000000-0000-0000-0000-000000000001');
  o := pg_temp.mk_order(); s := pg_temp.mk_sq(o, 'captured'); sub := pg_temp.mk_claim(o, s, 9000);
  UPDATE public.square_payments SET exception = 'amount_mismatch', exception_at = now() WHERE id = s;
  r := public.decide_square_case('exception', s, 'record_on_order', 'record the real capture');
  PERFORM pg_temp.ok((r->>'submission_id')::uuid IS DISTINCT FROM sub, 'review#7 mismatched claim is not reused', r::text);
  PERFORM pg_temp.ok((SELECT status::text FROM public.payment_submissions WHERE id = sub) = 'rejected', 'review#7 mismatched claim is closed');
  r := pg_temp.fin((r->>'submission_id')::uuid);
  PERFORM pg_temp.ok(r->>'outcome' = 'recorded', 'review#7 the new claim records the capture', r::text);

  -- #2: square_ops_health is staff only
  PERFORM pg_temp.as_user('c0000000-0000-0000-0000-00000000000c'); -- no role
  PERFORM pg_temp.ok(pg_temp.raises('SELECT public.square_ops_health()', 'not_staff'), 'review#2 health refused for a non-staff user');
  PERFORM pg_temp.as_user('50000000-0000-0000-0000-000000000003');
  PERFORM pg_temp.ok((public.square_ops_health() ? 'events_backlog'), 'review#2 health readable by staff');
END $$;

-- ===========================================================================
-- Report
-- ===========================================================================
\set QUIET off
SELECT n, CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result, name, left(coalesce(detail, ''), 160) AS detail FROM t_results ORDER BY n;
-- Review B: a Confirm inside its 5-minute lease is never replaced or rejected by a decision.
DO $$
DECLARE o uuid; s uuid; r jsonb; c uuid;
BEGIN
  PERFORM pg_temp.as_user('a0000000-0000-0000-0000-000000000001');
  o := pg_temp.mk_order(); s := pg_temp.mk_sq(o, 'captured');
  UPDATE public.square_payments SET exception = 'captured_unallocated', exception_at = now() WHERE id = s;
  c := pg_temp.mk_claim(o, s, 9000);  -- not the capture amount: would normally be replaced
  UPDATE public.payment_submissions SET processing_started_at = now() - interval '1 minute' WHERE id = c;
  r := public.decide_square_case('exception', s, 'record_on_order', 'record it');
  PERFORM pg_temp.ok(r->>'error' = 'confirm_in_progress' AND (r->>'decision_recorded')::boolean,
                     'Review B record_on_order waits for a running Confirm', r::text);
  PERFORM pg_temp.ok((SELECT status::text FROM public.payment_submissions WHERE id = c) = 'confirmed',
                     'Review B the running Confirm is left alone');
  -- lease expired: the stale claim is replaced as before
  UPDATE public.payment_submissions SET processing_started_at = now() - interval '6 minutes' WHERE id = c;
  r := public.decide_square_case('exception', s, 'record_on_order', 'record it');
  PERFORM pg_temp.ok((r->>'ok')::boolean AND (SELECT status::text FROM public.payment_submissions WHERE id = c) = 'rejected',
                     'Review B an expired lease is replaced by a recording for the capture', r::text);
END $$;

-- Review A: apply_square_payment_state takes the submission lock before the card row.
DO $$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public.apply_square_payment_state'::regproc);
  PERFORM pg_temp.ok(strpos(d, 'PERFORM 1 FROM public.payment_submissions') > 0
                     AND strpos(d, 'PERFORM 1 FROM public.payment_submissions') < strpos(d, 'FROM public.square_payments WHERE square_payment_id = p_square_payment_id FOR UPDATE'),
                     'Review A apply_square_payment_state locks submission before the card row');
END $$;

SELECT count(*) FILTER (WHERE pass) AS passed, count(*) FILTER (WHERE NOT pass) AS failed FROM t_results;
ROLLBACK;
