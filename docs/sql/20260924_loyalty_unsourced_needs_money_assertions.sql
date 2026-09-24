-- ============================================================================
-- revoke_loyalty_points: no bell when nothing was paid — SQL assertions for
-- migration 20260924140000_loyalty_unsourced_needs_money. 2026-09-24. Run in
-- the Supabase SQL Editor AFTER the migration is applied.
--
-- WHAT IT PROVES.
--   A  the live body is the one the migration shipped (md5 8f475dbf…).
--   B  a web cash order with a checkout loyalty basis and NOTHING received
--      (TEST-900048, the acceptance-run case) raises no staff bell and no
--      audit row when its loyalty is reversed.
--   C  an order with money received and no ledger row (19634, ₱13,104 paid,
--      one of the two genuine bells on live) still raises exactly one bell
--      and one audit row — the genuine case is not silenced.
--
-- WRITES NOTHING THAT SURVIVES. One transaction ending in ROLLBACK. Both calls
-- use the Test Customer's loyalty member (CJ-2026-05088); neither order has a
-- ledger row under that member, so both reach the unsourced branch, which is
-- exactly the branch under test. No lot, counter or ledger row moves.
--
-- Reading the result: NOTICE 'ALL UNSOURCED-REVERSAL ASSERTIONS PASSED'.
-- Any failure RAISEs 'ASSERTION FAILED — …' and the ROLLBACK still runs.
-- ============================================================================

BEGIN;

DO $t$
DECLARE
  v_md5     text;
  v_member  uuid;
  v_cash    uuid;
  v_plan    uuid;
  v_bell0   int;
  v_bell1   int;
  v_audit0  int;
  v_audit1  int;
BEGIN
  -- A
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'revoke_loyalty_points';
  IF v_md5 IS DISTINCT FROM '8f475dbfd8c1d74be3de475fae08e81b' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — A: live body md5 is %, expected 8f475dbfd8c1d74be3de475fae08e81b', v_md5;
  END IF;

  SELECT m.id INTO v_member FROM public.loyalty_members m
    JOIN public.customers c ON c.id = m.customer_id
   WHERE c.customer_code = 'CJ-2026-05088';
  IF v_member IS NULL THEN RAISE EXCEPTION 'ASSERTION FAILED — setup: Test Customer has no loyalty member'; END IF;

  -- B
  SELECT id INTO v_cash FROM public.cash_orders WHERE invoice_number = 'TEST-900048';
  IF v_cash IS NULL THEN RAISE EXCEPTION 'ASSERTION FAILED — setup: TEST-900048 not found'; END IF;
  IF (SELECT COALESCE(total_paid, 0) FROM public.cash_orders WHERE id = v_cash) <> 0
     OR EXISTS (SELECT 1 FROM public.cash_payments WHERE cash_order_id = v_cash AND voided_at IS NULL) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — setup: TEST-900048 has money on it; pick another unpaid web order';
  END IF;

  SELECT COUNT(*) INTO v_bell0 FROM public.staff_notifications WHERE type = 'loyalty_reversal_unsourced';
  SELECT COUNT(*) INTO v_audit0 FROM public.audit_logs WHERE action = 'loyalty_reversal_unsourced';
  PERFORM public.revoke_loyalty_points(v_member, 'TEST-900048', 0, NULL, v_cash, NULL,
                                       'TEST-900048', NULL, NULL, 'cancel');
  SELECT COUNT(*) INTO v_bell1 FROM public.staff_notifications WHERE type = 'loyalty_reversal_unsourced';
  SELECT COUNT(*) INTO v_audit1 FROM public.audit_logs WHERE action = 'loyalty_reversal_unsourced';
  IF v_bell1 <> v_bell0 OR v_audit1 <> v_audit0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B: an unpaid order raised % bell(s) and % audit row(s)',
      v_bell1 - v_bell0, v_audit1 - v_audit0;
  END IF;

  -- C
  SELECT id INTO v_plan FROM public.layaway_accounts WHERE invoice_number = '19634';
  IF v_plan IS NULL THEN RAISE EXCEPTION 'ASSERTION FAILED — setup: 19634 not found'; END IF;
  PERFORM public.revoke_loyalty_points(v_member, '19634', 0, v_plan, NULL, NULL,
                                       '19634', NULL, NULL, 'manual_forfeit');
  SELECT COUNT(*) INTO v_bell0 FROM public.staff_notifications WHERE type = 'loyalty_reversal_unsourced';
  SELECT COUNT(*) INTO v_audit0 FROM public.audit_logs WHERE action = 'loyalty_reversal_unsourced';
  IF v_bell0 <> v_bell1 + 1 OR v_audit0 <> v_audit1 + 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C: a paid order raised % bell(s) and % audit row(s), expected 1 and 1',
      v_bell0 - v_bell1, v_audit0 - v_audit1;
  END IF;

  RAISE NOTICE 'ALL UNSOURCED-REVERSAL ASSERTIONS PASSED';
END
$t$;

ROLLBACK;
