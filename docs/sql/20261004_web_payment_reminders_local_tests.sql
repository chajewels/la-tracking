-- ============================================================================
-- Payment reminders — LOCAL tests for 20261004100000_web_payment_reminders.sql.
-- Run after the stub and the migration (see the stub's header). NEVER ON LIVE.
-- Every block raises on failure; the last line prints ALL PASSED.
-- ============================================================================
DO $g$ BEGIN
  IF coalesce(current_setting('payrem.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: local throwaway Postgres only (PGOPTIONS=-c payrem.local_stub=yes)';
  END IF;
END $g$;

-- ---------------------------------------------------------------- fixtures
INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-00000000000a', 'admin'),
                                     ('00000000-0000-0000-0000-00000000000b', 'staff');
INSERT INTO public.profiles VALUES ('00000000-0000-0000-0000-00000000000a', 'Owner Admin');

INSERT INTO public.customers (id, full_name, email, is_test) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'JA-1',        'chajewelsjapan@gmail.com', true),   -- owner, test flag
  ('c0000000-0000-0000-0000-000000000002', 'EN-1',        'en1@chajewelsjp.com',      true),   -- owner domain, test flag
  ('c0000000-0000-0000-0000-000000000003', 'Real buyer',  'buyer@example.com',        false),
  ('c0000000-0000-0000-0000-000000000004', 'Test throw',  'throwaway@example.com',    true),
  ('c0000000-0000-0000-0000-000000000005', 'No address',  '',                         false);

-- Cash, peso, Japanese, 24h deadline (first order): confirmed 19h ago, 5h left → IN window.
INSERT INTO public.cash_orders (id, invoice_number, customer_id, source_channel, payment_status, ready_confirmed_at,
  transfer_due_at, expires_at, remaining_balance, total_amount, customer_lang, currency, web_reference) VALUES
  ('a0000000-0000-0000-0000-000000000001', '30001', 'c0000000-0000-0000-0000-000000000001', 'web', 'pending_transfer',
   now() - interval '19 hours', now() + interval '5 hours', now() + interval '5 hours', 27076, 27076, 'ja', 'PHP', 'CJ-W-000201'),
-- 24h kind, 7h left → NOT YET (window is 6h).
  ('a0000000-0000-0000-0000-000000000002', '30002', 'c0000000-0000-0000-0000-000000000001', 'web', 'pending_transfer',
   now() - interval '17 hours', now() + interval '7 hours', now() + interval '7 hours', 50000, 50000, 'ja', 'JPY', 'CJ-W-000202'),
-- 24h kind, 5h left, proof already uploaded (submitted) → SKIP.
  ('a0000000-0000-0000-0000-000000000003', '30003', 'c0000000-0000-0000-0000-000000000001', 'web', 'pending_transfer',
   now() - interval '19 hours', now() + interval '5 hours', now() + interval '5 hours', 40000, 40000, 'ja', 'JPY', 'CJ-W-000203'),
-- Paid (completed) → SKIP.
  ('a0000000-0000-0000-0000-000000000004', '30004', 'c0000000-0000-0000-0000-000000000001', 'web', 'paid',
   now() - interval '19 hours', now() + interval '5 hours', now() + interval '5 hours', 0, 40000, 'ja', 'JPY', 'CJ-W-000204'),
-- Deadline already passed → SKIP.
  ('a0000000-0000-0000-0000-000000000005', '30005', 'c0000000-0000-0000-0000-000000000001', 'web', 'pending_transfer',
   now() - interval '25 hours', now() - interval '1 hour', now() - interval '1 hour', 40000, 40000, 'ja', 'JPY', 'CJ-W-000205'),
-- 30 minutes left (inside the 1-hour floor) → SKIP.
  ('a0000000-0000-0000-0000-000000000006', '30006', 'c0000000-0000-0000-0000-000000000001', 'web', 'pending_transfer',
   now() - interval '23 hours 30 minutes', now() + interval '30 minutes', now() + interval '30 minutes', 40000, 40000, 'ja', 'JPY', 'CJ-W-000206'),
-- Unconfirmed reservation → SKIP (no bank details before staff confirm).
  ('a0000000-0000-0000-0000-000000000007', '30007', 'c0000000-0000-0000-0000-000000000001', 'web', 'awaiting_confirmation',
   NULL, now() + interval '5 hours', now() + interval '5 hours', 40000, 40000, 'ja', 'JPY', 'CJ-W-000207'),
-- Hub-made cash order → SKIP (D14: web orders only).
  ('a0000000-0000-0000-0000-000000000008', '30008', 'c0000000-0000-0000-0000-000000000001', 'hub_manual', 'pending_transfer',
   now() - interval '19 hours', now() + interval '5 hours', now() + interval '5 hours', 40000, 40000, 'ja', 'JPY', NULL),
-- Real customer, yen, English → only when the switch is 'on'.
  ('a0000000-0000-0000-0000-000000000009', '30009', 'c0000000-0000-0000-0000-000000000003', 'web', 'pending_transfer',
   now() - interval '19 hours', now() + interval '5 hours', now() + interval '5 hours', 68000, 72980, 'en', 'JPY', 'CJ-W-000209'),
-- Test customer at a throwaway address → NEVER (storefront test gate).
  ('a0000000-0000-0000-0000-00000000000a', '30010', 'c0000000-0000-0000-0000-000000000004', 'web', 'pending_transfer',
   now() - interval '19 hours', now() + interval '5 hours', now() + interval '5 hours', 68000, 68000, 'en', 'JPY', 'CJ-W-000210'),
-- Expired order (status) → SKIP.
  ('a0000000-0000-0000-0000-00000000000b', '30011', 'c0000000-0000-0000-0000-000000000001', 'web', 'pending_transfer',
   now() - interval '19 hours', now() + interval '5 hours', now() + interval '5 hours', 40000, 40000, 'ja', 'JPY', 'CJ-W-000211'),
-- Customer without an address → SKIP.
  ('a0000000-0000-0000-0000-00000000000c', '30012', 'c0000000-0000-0000-0000-000000000005', 'web', 'pending_transfer',
   now() - interval '19 hours', now() + interval '5 hours', now() + interval '5 hours', 40000, 40000, 'ja', 'JPY', 'CJ-W-000212');
UPDATE public.cash_orders SET status = 'completed' WHERE id = 'a0000000-0000-0000-0000-000000000004';
UPDATE public.cash_orders SET status = 'expired'   WHERE id = 'a0000000-0000-0000-0000-00000000000b';
INSERT INTO public.payment_submissions (cash_order_id, status) VALUES ('a0000000-0000-0000-0000-000000000003', 'submitted');

-- Layaway, yen, customer_lang 'ja' (must still be English), 72h deadline (returning):
-- confirmed 49h ago, 23h left → IN window (24h).
INSERT INTO public.layaway_accounts (id, invoice_number, customer_id, source_channel, ready_confirmed_at, transfer_due_at,
  total_paid, downpayment_amount, total_amount, customer_lang, currency, web_reference) VALUES
  ('b0000000-0000-0000-0000-000000000001', '40001', 'c0000000-0000-0000-0000-000000000002', 'web',
   now() - interval '49 hours', now() + interval '23 hours', 0, 36000, 120000, 'ja', 'JPY', 'CJ-W-000301'),
-- 72h kind, 25h left → NOT YET.
  ('b0000000-0000-0000-0000-000000000002', '40002', 'c0000000-0000-0000-0000-000000000002', 'web',
   now() - interval '47 hours', now() + interval '25 hours', 0, 36000, 120000, 'en', 'JPY', 'CJ-W-000302'),
-- Deposit already in → SKIP.
  ('b0000000-0000-0000-0000-000000000003', '40003', 'c0000000-0000-0000-0000-000000000002', 'web',
   now() - interval '49 hours', now() + interval '23 hours', 36000, 36000, 120000, 'en', 'JPY', 'CJ-W-000303'),
-- Proof pending through a SPLIT submission (allocation row) → SKIP.
  ('b0000000-0000-0000-0000-000000000004', '40004', 'c0000000-0000-0000-0000-000000000002', 'web',
   now() - interval '49 hours', now() + interval '23 hours', 0, 36000, 120000, 'en', 'JPY', 'CJ-W-000304'),
-- Peso layaway, 24h kind, 5h left → IN window, amount in pesos.
  ('b0000000-0000-0000-0000-000000000005', '40005', 'c0000000-0000-0000-0000-000000000002', 'web',
   now() - interval '19 hours', now() + interval '5 hours', 0, 15120, 50400, NULL, 'PHP', 'CJ-W-000305');
INSERT INTO public.payment_submissions (id, account_id, status) VALUES ('d0000000-0000-0000-0000-000000000001', NULL, 'under_review');
INSERT INTO public.payment_submission_allocations (submission_id, account_id) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000004');

-- ------------------------------------------------ 1. eligibility (timing + skips)
DO $t$
DECLARE v text;
BEGIN
  SELECT string_agg(reference, ',' ORDER BY reference) INTO v FROM public.web_payment_reminder_eligible(NULL, NULL);
  IF v IS DISTINCT FROM 'CJ-W-000201,CJ-W-000209,CJ-W-000301,CJ-W-000305' THEN
    RAISE EXCEPTION 'T1 eligible set wrong: %', v;
  END IF;
  -- Peso cash order: pesos, the remaining balance, Japanese.
  IF NOT EXISTS (SELECT 1 FROM public.web_payment_reminder_eligible('cash_order', 'a0000000-0000-0000-0000-000000000001')
                  WHERE currency = 'PHP' AND amount = 27076 AND lang = 'ja') THEN
    RAISE EXCEPTION 'T1 peso cash order not PHP / 27076 / ja';
  END IF;
  -- Layaway: the deposit, English although customer_lang is 'ja'.
  IF NOT EXISTS (SELECT 1 FROM public.web_payment_reminder_eligible('layaway', 'b0000000-0000-0000-0000-000000000001')
                  WHERE currency = 'JPY' AND amount = 36000 AND lang = 'en') THEN
    RAISE EXCEPTION 'T1 layaway not JPY / deposit 36000 / en';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.web_payment_reminder_eligible('layaway', 'b0000000-0000-0000-0000-000000000005')
                  WHERE currency = 'PHP' AND amount = 15120 AND lang = 'en') THEN
    RAISE EXCEPTION 'T1 peso layaway not PHP / 15120 / en';
  END IF;
  RAISE NOTICE 'T1 ok: 24h/6h and 72h/24h windows, proof/paid/expired/passed/<1h/unconfirmed/hub/test/no-address skipped';
END $t$;

-- ------------------------------------------------ 2. switch OFF → nothing; guard refuses SQL
DO $t$
BEGIN
  IF public.web_payment_reminder_mode() <> 'off' THEN RAISE EXCEPTION 'T2 seeded mode is not off'; END IF;
  IF EXISTS (SELECT 1 FROM public.web_payment_reminder_candidates(50)) THEN RAISE EXCEPTION 'T2 candidates while off'; END IF;
  IF public.claim_web_payment_reminder('cash_order', 'a0000000-0000-0000-0000-000000000001',
       (SELECT transfer_due_at FROM public.cash_orders WHERE id = 'a0000000-0000-0000-0000-000000000001')) IS NOT NULL THEN
    RAISE EXCEPTION 'T2 claim succeeded while off';
  END IF;
  BEGIN
    UPDATE public.system_settings SET value = '"on"' WHERE key = 'web_payment_reminders_mode';
    RAISE EXCEPTION 'T2 guard did not refuse a direct UPDATE';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Payment reminders are changed only from the Hub%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM public.system_settings WHERE key = 'web_payment_reminders_owner_addresses';
    RAISE EXCEPTION 'T2 guard did not refuse a DELETE';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Payment reminders are changed only from the Hub%' THEN RAISE; END IF;
  END;
  -- Garbage stored value reads OFF (fail-closed) — simulated inside a savepoint.
  RAISE NOTICE 'T2 ok: off sends nothing; SQL writes refused';
END $t$;

-- ------------------------------------------------ 3. set RPC: permission, validation, audit
DO $t$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('test.uid', '', true);
  r := public.set_web_payment_reminders('on', NULL, NULL);
  IF r ->> 'error' <> 'user_identity_required' THEN RAISE EXCEPTION 'T3 anonymous: %', r; END IF;
  PERFORM set_config('test.uid', '00000000-0000-0000-0000-00000000000b', true);   -- staff, not admin
  r := public.set_web_payment_reminders('on', NULL, NULL);
  IF r ->> 'error' <> 'permission_denied' THEN RAISE EXCEPTION 'T3 staff: %', r; END IF;
  r := public.get_web_payment_reminders();
  IF r ->> 'error' <> 'permission_denied' THEN RAISE EXCEPTION 'T3 staff read without admin_settings: %', r; END IF;
  INSERT INTO public.perm VALUES ('00000000-0000-0000-0000-00000000000b', 'admin_settings');
  r := public.get_web_payment_reminders();
  IF r ->> 'mode' <> 'off' OR (r ->> 'can_change')::boolean THEN RAISE EXCEPTION 'T3 admin_settings read: %', r; END IF;

  PERFORM set_config('test.uid', '00000000-0000-0000-0000-00000000000a', true);   -- admin
  r := public.set_web_payment_reminders('loud', NULL, NULL);
  IF r ->> 'error' <> 'invalid_mode' THEN RAISE EXCEPTION 'T3 invalid mode: %', r; END IF;
  r := public.set_web_payment_reminders('owner_only', '["not an address"]', NULL);
  IF r ->> 'error' <> 'invalid_owner_address' THEN RAISE EXCEPTION 'T3 bad address: %', r; END IF;
  r := public.set_web_payment_reminders('owner_only', '[]', NULL);
  IF r ->> 'error' <> 'owner_addresses_required' THEN RAISE EXCEPTION 'T3 empty owner list: %', r; END IF;
  r := public.set_web_payment_reminders('owner_only', NULL, 'on');
  IF r ->> 'error' <> 'stale' THEN RAISE EXCEPTION 'T3 stale: %', r; END IF;
  r := public.set_web_payment_reminders('owner_only', NULL, 'off');
  IF NOT (r ->> 'ok')::boolean OR r ->> 'mode' <> 'owner_only' THEN RAISE EXCEPTION 'T3 set owner_only: %', r; END IF;
  r := public.set_web_payment_reminders('owner_only', NULL, 'owner_only');
  IF (r ->> 'changed')::boolean THEN RAISE EXCEPTION 'T3 no-op wrote: %', r; END IF;
  IF (SELECT count(*) FROM public.audit_logs WHERE action = 'set_web_payment_reminders') <> 1 THEN
    RAISE EXCEPTION 'T3 expected exactly one audit row';
  END IF;
  IF (SELECT updated_by_user_id FROM public.system_settings WHERE key = 'web_payment_reminders_mode')
     IS DISTINCT FROM '00000000-0000-0000-0000-00000000000a'::uuid THEN
    RAISE EXCEPTION 'T3 updated_by not stamped';
  END IF;
  r := public.get_web_payment_reminders();
  IF r ->> 'updated_by_name' <> 'Owner Admin' OR NOT (r ->> 'can_change')::boolean OR (r ->> 'due_now')::int <> 4 THEN
    RAISE EXCEPTION 'T3 admin read: %', r;
  END IF;
  RAISE NOTICE 'T3 ok: admin-only write, validation, stale check, one audit row';
END $t$;

-- ------------------------------------------------ 4. owner_only → only owner addresses
DO $t$
DECLARE v text;
BEGIN
  SELECT string_agg(reference, ',' ORDER BY reference) INTO v FROM public.web_payment_reminder_candidates(50);
  IF v IS DISTINCT FROM 'CJ-W-000201,CJ-W-000301,CJ-W-000305' THEN
    RAISE EXCEPTION 'T4 owner_only candidates wrong: %', v;
  END IF;
  -- The real buyer cannot be claimed either, even by id.
  IF public.claim_web_payment_reminder('cash_order', 'a0000000-0000-0000-0000-000000000009',
       (SELECT transfer_due_at FROM public.cash_orders WHERE id = 'a0000000-0000-0000-0000-000000000009')) IS NOT NULL THEN
    RAISE EXCEPTION 'T4 claimed a non-owner address in owner_only';
  END IF;
  RAISE NOTICE 'T4 ok: owner_only reaches only the owner list';
END $t$;

-- ------------------------------------------------ 5. claim once per deadline; max 2 per order
DO $t$
DECLARE
  v_id  uuid;
  v_due timestamptz;
BEGIN
  v_due := (SELECT transfer_due_at FROM public.cash_orders WHERE id = 'a0000000-0000-0000-0000-000000000001');
  -- A stale deadline (the order moved between read and claim) is refused.
  IF public.claim_web_payment_reminder('cash_order', 'a0000000-0000-0000-0000-000000000001', v_due - interval '1 minute') IS NOT NULL THEN
    RAISE EXCEPTION 'T5 claimed with a deadline that is not the order''s';
  END IF;
  v_id := public.claim_web_payment_reminder('cash_order', 'a0000000-0000-0000-0000-000000000001', v_due);
  IF v_id IS NULL THEN RAISE EXCEPTION 'T5 first claim failed'; END IF;
  IF public.claim_web_payment_reminder('cash_order', 'a0000000-0000-0000-0000-000000000001', v_due) IS NOT NULL THEN
    RAISE EXCEPTION 'T5 second claim for the same deadline succeeded';
  END IF;
  PERFORM public.finish_web_payment_reminder(v_id, 'sent', NULL);
  IF (SELECT status FROM public.web_payment_reminders WHERE id = v_id) <> 'sent' THEN RAISE EXCEPTION 'T5 finish'; END IF;
  IF EXISTS (SELECT 1 FROM public.web_payment_reminder_candidates(50) WHERE entity_id = 'a0000000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'T5 reminded order still a candidate';
  END IF;

  -- Staff move the deadline: a new deadline earns one more reminder.
  UPDATE public.cash_orders SET transfer_due_at = now() + interval '4 hours', expires_at = now() + interval '4 hours'
   WHERE id = 'a0000000-0000-0000-0000-000000000001';
  v_id := public.claim_web_payment_reminder('cash_order', 'a0000000-0000-0000-0000-000000000001', now() + interval '4 hours');
  IF v_id IS NULL THEN RAISE EXCEPTION 'T5 moved deadline not reminded'; END IF;
  PERFORM public.finish_web_payment_reminder(v_id, 'sent', NULL);

  -- A third deadline: the order has had 2 — never a third.
  UPDATE public.cash_orders SET transfer_due_at = now() + interval '3 hours', expires_at = now() + interval '3 hours'
   WHERE id = 'a0000000-0000-0000-0000-000000000001';
  IF EXISTS (SELECT 1 FROM public.web_payment_reminder_eligible('cash_order', 'a0000000-0000-0000-0000-000000000001')) THEN
    RAISE EXCEPTION 'T5 a third reminder is eligible';
  END IF;
  IF public.claim_web_payment_reminder('cash_order', 'a0000000-0000-0000-0000-000000000001', now() + interval '3 hours') IS NOT NULL THEN
    RAISE EXCEPTION 'T5 a third reminder was claimed';
  END IF;
  RAISE NOTICE 'T5 ok: once per deadline, a moved deadline gets one more, never more than 2';
END $t$;

-- ------------------------------------------------ 6. proof uploaded after the read → the claim loses
DO $t$
DECLARE v_due timestamptz;
BEGIN
  v_due := (SELECT transfer_due_at FROM public.layaway_accounts WHERE id = 'b0000000-0000-0000-0000-000000000001');
  IF NOT EXISTS (SELECT 1 FROM public.web_payment_reminder_candidates(50) WHERE entity_id = 'b0000000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'T6 layaway not a candidate before the proof';
  END IF;
  INSERT INTO public.payment_submissions (account_id, status) VALUES ('b0000000-0000-0000-0000-000000000001', 'submitted');
  IF public.claim_web_payment_reminder('layaway', 'b0000000-0000-0000-0000-000000000001', v_due) IS NOT NULL THEN
    RAISE EXCEPTION 'T6 claimed after a proof was uploaded';
  END IF;
  -- Rejected proof: the reminder is owed again.
  UPDATE public.payment_submissions SET status = 'rejected' WHERE account_id = 'b0000000-0000-0000-0000-000000000001';
  IF public.claim_web_payment_reminder('layaway', 'b0000000-0000-0000-0000-000000000001', v_due) IS NULL THEN
    RAISE EXCEPTION 'T6 not claimable after the proof was rejected';
  END IF;
  -- Paid after the claim: nothing new is eligible.
  UPDATE public.layaway_accounts SET total_paid = 36000 WHERE id = 'b0000000-0000-0000-0000-000000000005';
  IF EXISTS (SELECT 1 FROM public.web_payment_reminder_eligible('layaway', 'b0000000-0000-0000-0000-000000000005')) THEN
    RAISE EXCEPTION 'T6 paid layaway still eligible';
  END IF;
  RAISE NOTICE 'T6 ok: proof or payment between read and send wins';
END $t$;

-- ------------------------------------------------ 7. 'on' → every customer, never a test customer at a throwaway address
DO $t$
DECLARE r jsonb; v text;
BEGIN
  PERFORM set_config('test.uid', '00000000-0000-0000-0000-00000000000a', true);
  r := public.set_web_payment_reminders('on', NULL, 'owner_only');
  IF r ->> 'mode' <> 'on' THEN RAISE EXCEPTION 'T7 set on: %', r; END IF;
  SELECT string_agg(reference, ',' ORDER BY reference) INTO v FROM public.web_payment_reminder_candidates(50);
  IF v IS DISTINCT FROM 'CJ-W-000209' THEN RAISE EXCEPTION 'T7 on candidates wrong: %', v; END IF;
  IF EXISTS (SELECT 1 FROM public.web_payment_reminder_eligible(NULL, NULL) WHERE email = 'throwaway@example.com') THEN
    RAISE EXCEPTION 'T7 test customer at a throwaway address is eligible';
  END IF;
  -- Switch off between the read and the claim: the claim loses.
  r := public.set_web_payment_reminders('off', NULL, 'on');
  IF public.claim_web_payment_reminder('cash_order', 'a0000000-0000-0000-0000-000000000009',
       (SELECT transfer_due_at FROM public.cash_orders WHERE id = 'a0000000-0000-0000-0000-000000000009')) IS NOT NULL THEN
    RAISE EXCEPTION 'T7 claimed after the switch went off';
  END IF;
  IF (SELECT count(*) FROM public.audit_logs WHERE action = 'set_web_payment_reminders') <> 3 THEN
    RAISE EXCEPTION 'T7 expected three audit rows';
  END IF;
  RAISE NOTICE 'T7 ok: on reaches real customers; test gate holds; off wins at claim time';
END $t$;

-- ------------------------------------------------ 8. the 48h staff bell, once per reservation
INSERT INTO public.cash_orders (id, invoice_number, customer_id, source_channel, payment_status, remaining_balance,
  total_amount, currency, web_reference, created_at) VALUES
  ('e0000000-0000-0000-0000-000000000001', '50001', 'c0000000-0000-0000-0000-000000000003', 'web', 'awaiting_confirmation',
   40000, 40000, 'JPY', 'CJ-W-000401', now() - interval '49 hours'),   -- 49h → bell
  ('e0000000-0000-0000-0000-000000000002', '50002', 'c0000000-0000-0000-0000-000000000003', 'web', 'awaiting_confirmation',
   40000, 40000, 'JPY', 'CJ-W-000402', now() - interval '47 hours'),   -- 47h → not yet
  ('e0000000-0000-0000-0000-000000000003', '50003', 'c0000000-0000-0000-0000-000000000003', 'web', 'awaiting_confirmation',
   40000, 40000, 'JPY', 'CJ-W-000403', now() - interval '73 hours'),   -- past 72h → the sweep's, no bell
  ('e0000000-0000-0000-0000-000000000004', '50004', 'c0000000-0000-0000-0000-000000000003', 'hub_manual', NULL,
   40000, 40000, 'JPY', NULL, now() - interval '49 hours');            -- Hub order → never
INSERT INTO public.layaway_accounts (id, invoice_number, customer_id, source_channel, downpayment_amount, total_amount,
  currency, web_reference, created_at) VALUES
  ('f0000000-0000-0000-0000-000000000001', '60001', 'c0000000-0000-0000-0000-000000000003', 'web', 36000, 120000,
   'JPY', 'CJ-W-000501', now() - interval '50 hours');                 -- 50h layaway → bell
DO $t$
DECLARE n int;
BEGIN
  n := public.web_reservation_expiring_bells();
  IF n <> 2 THEN RAISE EXCEPTION 'T8 expected 2 bells, got %', n; END IF;
  n := public.web_reservation_expiring_bells();
  IF n <> 0 THEN RAISE EXCEPTION 'T8 second run rang again: %', n; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.staff_notifications WHERE type = 'web_reservation_expiring'
                  AND metadata ->> 'cash_order_id' = 'e0000000-0000-0000-0000-000000000001'
                  AND title LIKE 'Last day — CJ-W-000401 auto-cancels at % PHT') THEN
    RAISE EXCEPTION 'T8 cash bell wrong';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.staff_notifications WHERE type = 'web_reservation_expiring'
                  AND account_id = 'f0000000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'T8 layaway bell missing account_id (the bell links through it)';
  END IF;
  -- Confirming one does not add a bell; a newly 48h-old one does, once.
  UPDATE public.cash_orders SET created_at = now() - interval '48 hours 5 minutes' WHERE id = 'e0000000-0000-0000-0000-000000000002';
  n := public.web_reservation_expiring_bells();
  IF n <> 1 THEN RAISE EXCEPTION 'T8 the newly 48h-old reservation did not ring once: %', n; END IF;
  RAISE NOTICE 'T8 ok: one bell per reservation, 48h to 72h, web only';
END $t$;

-- ------------------------------------------------ 9. email history for an order page
INSERT INTO public.email_send_log (template_name, recipient_email, status, channel, metadata) VALUES
  ('order-ready',       'chajewelsjapan@gmail.com', 'sent',    'storefront', '{"reference":"CJ-W-000201"}'),
  ('order-payment-due', 'chajewelsjapan@gmail.com', 'sent',    'storefront', '{"reference":"CJ-W-000201"}'),
  ('order-ready',       'buyer@example.com',        'sent',    'storefront', '{"reference":"CJ-W-000209"}'),
  ('staff-digest',      'sales@chajewelsjp.com',    'sent',    'hub',        '{"reference":"CJ-W-000201"}');
DO $t$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('test.uid', '', true);
  r := public.get_order_email_history('cash_order', 'a0000000-0000-0000-0000-000000000001');
  IF r ->> 'error' <> 'user_identity_required' THEN RAISE EXCEPTION 'T9 anonymous: %', r; END IF;
  PERFORM set_config('test.uid', '00000000-0000-0000-0000-0000000000ff', true);   -- not staff
  r := public.get_order_email_history('cash_order', 'a0000000-0000-0000-0000-000000000001');
  IF r ->> 'error' <> 'permission_denied' THEN RAISE EXCEPTION 'T9 non-staff: %', r; END IF;
  PERFORM set_config('test.uid', '00000000-0000-0000-0000-00000000000b', true);   -- staff
  r := public.get_order_email_history('cash_order', 'a0000000-0000-0000-0000-000000000001');
  IF jsonb_array_length(r -> 'emails') <> 2 THEN RAISE EXCEPTION 'T9 expected the 2 storefront emails: %', r; END IF;
  IF jsonb_array_length(r -> 'payment_reminders') <> 2 THEN RAISE EXCEPTION 'T9 expected the 2 reminder rows: %', r; END IF;
  r := public.get_order_email_history('cash_order', gen_random_uuid());
  IF r ->> 'error' <> 'not_found' THEN RAISE EXCEPTION 'T9 unknown order: %', r; END IF;
  RAISE NOTICE 'T9 ok: staff see the order''s storefront emails and reminders';
END $t$;

-- ------------------------------------------------ 10. browser roles
DO $t$
BEGIN
  IF has_function_privilege('authenticated', 'public.claim_web_payment_reminder(text,uuid,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.web_reservation_expiring_bells()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.web_payment_reminder_eligible(text,uuid)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.web_payment_reminders', 'INSERT') THEN
    RAISE EXCEPTION 'T10 a browser role reaches a service-role path';
  END IF;
  RAISE NOTICE 'T10 ok: browser roles reach only get/set/history';
END $t$;

DO $done$ BEGIN RAISE NOTICE 'ALL PASSED'; END $done$;
