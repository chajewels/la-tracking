-- Aileen Gabiola (CJ-2026-03608) — bring the LOTS to the ledger. Bug #280.
-- Run in the Supabase SQL Editor. One transaction, guarded, idempotent by refusal.
--
-- WHAT IS WRONG
--   member  d0d2b024-70af-4357-a489-d1d968adae66
--   counter remaining_points = 0        ledger net = 0        live lots = 4,200
--
--   The counter and the immutable ledger AGREE. The lots do not. She really did
--   spend every point she had: 4,700 redeemed against invoice 19720 at
--   2026-09-17 00:07:08 UTC. Two faults left the lots behind:
--
--   (a) 2026-09-16 23:08  birthday_bonus +500 credited the counter and the
--       ledger. _award_birthday_reward never creates a lot, so no lot exists.
--   (b) 2026-09-17 00:07  the 4,700 redemption debited the counter and wrote
--       its ledger row, but consumed NO lots and wrote NO
--       loyalty_lot_consumption rows — approve_redemption_atomic lost its
--       consume_lots_fifo call to migration 20260912000000.
--
-- WHY THE LOTS MOVE AND NOT THE COUNTER
--   The ledger is authoritative (CLAUDE.md LOYALTY SYSTEM RULES 12, 13). Lots
--   and counter are both derived from it. Here the counter already matches the
--   ledger; recomputing the counter from the lots would hand her back 4,200
--   points she has already spent, and the Hub would pay twice for one
--   redemption. So the lots are corrected to the ledger.
--
-- WHY 4,700 OF CONSUMPTION AND NOT 4,200
--   restore_lots_for_redemption reads loyalty_lot_consumption. If this records
--   only the 4,200 that had lots, a later void of 19720 would credit the
--   counter 4,700 and the lots 4,200 — re-drifting by 500. The missing
--   birthday lot is created so the record totals the full 4,700.
--
-- WHAT THIS DOES NOT DO
--   No loyalty_transactions row. No loyalty_members update. That is the tell
--   that this is a DERIVED-DATA repair, and the one structural difference from
--   the #19751 correction, where the ledger itself was short.
--
-- DO NOT void redemption 19720 as a way of fixing this. void_redemption_atomic
--   still calls restore_lots_for_redemption, which restores from the
--   consumption rows — of which there are none — while crediting the counter
--   the full 4,700. A void today turns a -4,200 drift into +4,700.
--
-- THE CODE FIX IS SEPARATE (PR B, migration 20260917070000). This repair is
--   safe to run before or after it; it neither depends on nor blocks it.

--------------------------------------------------------------------------
-- BEFORE — run this first and keep the output
--------------------------------------------------------------------------

SELECT 'counter' AS what,
       m.remaining_points::text AS points, NULL::text AS detail
  FROM public.loyalty_members m
 WHERE m.id = 'd0d2b024-70af-4357-a489-d1d968adae66'
UNION ALL
SELECT 'ledger net',
       SUM(t.points_amount)::text, count(*)::text || ' rows'
  FROM public.loyalty_transactions t
 WHERE t.member_id = 'd0d2b024-70af-4357-a489-d1d968adae66'
UNION ALL
SELECT 'live lot ' || l.source_reference,
       l.remaining_amount::text,
       'expires ' || to_char(l.expires_at, 'YYYY-MM-DD')
  FROM public.loyalty_point_lots l
 WHERE l.member_id = 'd0d2b024-70af-4357-a489-d1d968adae66'
   AND l.revoked_at IS NULL AND l.expired_at IS NULL AND l.consumed_at IS NULL
UNION ALL
SELECT 'consumption rows for 19720',
       COALESCE(SUM(k.amount), 0)::text, count(*)::text || ' rows'
  FROM public.loyalty_lot_consumption k
 WHERE k.redemption_id = 'be433cb3-10da-4c32-9cbf-0061b02c2ea2'
 ORDER BY 1;

-- Expected BEFORE:
--   counter                      0
--   ledger net                   0            12 rows
--   live lot 19260               700          expires 2027-02-16
--   live lot 19342               1600         expires 2027-02-16
--   live lot 19480               1900         expires 2027-02-16
--   consumption rows for 19720   0            0 rows

--------------------------------------------------------------------------
-- THE REPAIR
--------------------------------------------------------------------------

DO $repair$
DECLARE
  c_member     CONSTANT uuid        := 'd0d2b024-70af-4357-a489-d1d968adae66';
  c_redemption CONSTANT uuid        := 'be433cb3-10da-4c32-9cbf-0061b02c2ea2';
  c_approved   CONSTANT timestamptz := '2026-09-17 00:07:08.351059+00';
  c_bday_at    CONSTANT timestamptz := '2026-09-16 23:08:27.098134+00';
  c_expires    CONSTANT timestamptz := '2027-02-16 02:12:37.241+00';

  v_counter    numeric;
  v_earned     numeric;
  v_redeemed   numeric;
  v_ledger     numeric;
  v_pts        numeric;
  v_status     text;
  v_processed  timestamptz;
  v_cons_rows  int;
  v_live_lots  int;
  v_live_sum   numeric;
  v_bday_tx    int;
  v_bday_lots  int;
  v_new_lot    uuid;
  v_lot        record;
  v_take       int;
  v_left       int := 4700;
  v_total      int := 0;
BEGIN
  ----------------------------------------------------------------
  -- GUARDS. Every one of these must describe the state this repair
  -- was written against. Any mismatch means the world moved and a
  -- human must look again — so we refuse rather than improvise.
  ----------------------------------------------------------------
  SELECT m.remaining_points, m.total_points_earned, m.total_points_redeemed
    INTO v_counter, v_earned, v_redeemed
    FROM public.loyalty_members m WHERE m.id = c_member;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refused: member % not found', c_member;
  END IF;
  IF v_counter <> 0 OR v_earned <> 7310 OR v_redeemed <> 7310 THEN
    RAISE EXCEPTION 'refused: counters moved (remaining %, earned %, redeemed % — expected 0 / 7310 / 7310)',
      v_counter, v_earned, v_redeemed;
  END IF;

  SELECT COALESCE(SUM(t.points_amount), 0) INTO v_ledger
    FROM public.loyalty_transactions t WHERE t.member_id = c_member;
  IF v_ledger <> 0 THEN
    RAISE EXCEPTION 'refused: ledger net is %, expected 0 — the ledger is authoritative and is no longer what this repair assumes', v_ledger;
  END IF;

  SELECT r.points_redeemed, r.status::text, r.processed_at
    INTO v_pts, v_status, v_processed
    FROM public.loyalty_redemptions r WHERE r.id = c_redemption;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'refused: redemption % not found', c_redemption;
  END IF;
  IF v_status <> 'confirmed' OR v_pts <> 4700 OR v_processed <> c_approved THEN
    RAISE EXCEPTION 'refused: redemption is % for % pts at % — expected confirmed / 4700 / %',
      v_status, v_pts, v_processed, c_approved;
  END IF;

  -- Second-run refusal. After a successful run there are 4 consumption rows
  -- and 0 live lots, so both of the next two guards fire.
  SELECT count(*) INTO v_cons_rows
    FROM public.loyalty_lot_consumption k WHERE k.redemption_id = c_redemption;
  IF v_cons_rows <> 0 THEN
    RAISE EXCEPTION 'refused: redemption already has % consumption row(s) — this repair has already run', v_cons_rows;
  END IF;

  SELECT count(*), COALESCE(SUM(l.remaining_amount), 0) INTO v_live_lots, v_live_sum
    FROM public.loyalty_point_lots l
   WHERE l.member_id = c_member
     AND l.revoked_at IS NULL AND l.expired_at IS NULL AND l.consumed_at IS NULL;
  IF v_live_lots <> 3 OR v_live_sum <> 4200 THEN
    RAISE EXCEPTION 'refused: % live lot(s) totalling % — expected 3 totalling 4200', v_live_lots, v_live_sum;
  END IF;

  SELECT count(*) INTO v_bday_tx
    FROM public.loyalty_transactions t
   WHERE t.member_id = c_member
     AND t.transaction_type = 'birthday_bonus'
     AND t.points_amount = 500
     AND t.created_at = c_bday_at;
  IF v_bday_tx <> 1 THEN
    RAISE EXCEPTION 'refused: expected exactly one +500 birthday_bonus ledger row at %, found %', c_bday_at, v_bday_tx;
  END IF;

  SELECT count(*) INTO v_bday_lots
    FROM public.loyalty_point_lots l
   WHERE l.member_id = c_member AND l.source_type = 'birthday_bonus';
  IF v_bday_lots <> 0 THEN
    RAISE EXCEPTION 'refused: a birthday_bonus lot already exists (% found)', v_bday_lots;
  END IF;

  ----------------------------------------------------------------
  -- 1. The lot the birthday bonus should have created.
  --    source_type 'birthday_bonus' — the enum carries it and it is
  --    self-describing. Nothing in revoke_loyalty_points,
  --    revoke_loyalty_points_partial or restore_loyalty_points treats
  --    it differently from promo_bonus: all three act on order_earn.
  --    expires_at deliberately matches her three live lots so the FIFO
  --    order below is exactly what consume_lots_fifo would have chosen.
  ----------------------------------------------------------------
  INSERT INTO public.loyalty_point_lots
    (member_id, source_type, source_reference, original_amount, remaining_amount,
     earned_at, expires_at, spend_basis_jpy, notes)
  VALUES
    (c_member, 'birthday_bonus', 'BIRTHDAY-2026', 500, 500,
     c_bday_at, c_expires, NULL,
     'Backfilled 2026-09-17 (Bug #280): _award_birthday_reward credited the counter and the ledger but created no lot.')
  RETURNING id INTO v_new_lot;

  ----------------------------------------------------------------
  -- 2. Consume 4,700 in consume_lots_fifo's own order —
  --    expires_at ASC NULLS LAST, earned_at ASC — writing the
  --    loyalty_lot_consumption rows that the approve path did not.
  --    consumed_at is stamped at the APPROVAL instant, not now():
  --    this records when the points were spent, not when we noticed.
  ----------------------------------------------------------------
  FOR v_lot IN
    SELECT l.id, l.remaining_amount, l.source_reference
      FROM public.loyalty_point_lots l
     WHERE l.member_id = c_member
       AND l.remaining_amount > 0
       AND l.revoked_at IS NULL
       AND l.expired_at IS NULL
     ORDER BY l.expires_at ASC NULLS LAST, l.earned_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_left = 0;
    v_take := LEAST(v_lot.remaining_amount, v_left);

    UPDATE public.loyalty_point_lots
       SET remaining_amount = remaining_amount - v_take,
           consumed_at = CASE WHEN remaining_amount - v_take = 0 THEN c_approved ELSE consumed_at END
     WHERE id = v_lot.id;

    INSERT INTO public.loyalty_lot_consumption (redemption_id, lot_id, amount, consumed_at)
    VALUES (c_redemption, v_lot.id, v_take, c_approved);

    v_left  := v_left  - v_take;
    v_total := v_total + v_take;
  END LOOP;

  IF v_left <> 0 THEN
    RAISE EXCEPTION 'refused: only % of 4700 could be sourced from lots — do not leave a short record, restore_lots_for_redemption would re-drift on a void', v_total;
  END IF;

  ----------------------------------------------------------------
  -- 3. Audit. No ledger row and no counter change, by design.
  ----------------------------------------------------------------
  INSERT INTO public.audit_logs
    (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES
    ('loyalty_member', c_member, 'loyalty_lot_repair',
     jsonb_build_object('counter', 0, 'ledger_net', 0, 'live_lots', 4200,
                        'consumption_rows_for_redemption', 0,
                        'birthday_bonus_lot', false),
     jsonb_build_object('counter', 0, 'ledger_net', 0, 'live_lots', 0,
                        'consumption_rows_for_redemption', 4,
                        'consumed_total', v_total,
                        'birthday_bonus_lot_id', v_new_lot,
                        'redemption_id', c_redemption,
                        'bug', 280,
                        'note', 'Lots brought to the ledger. No ledger row, no counter change.'),
     auth.uid());

  RAISE NOTICE 'Repaired: birthday lot % created, % points consumed across 4 lots for redemption %.',
    v_new_lot, v_total, c_redemption;
END
$repair$;

--------------------------------------------------------------------------
-- AFTER — run this and compare
--------------------------------------------------------------------------

SELECT 'counter' AS what, m.remaining_points::text AS points, NULL::text AS detail
  FROM public.loyalty_members m
 WHERE m.id = 'd0d2b024-70af-4357-a489-d1d968adae66'
UNION ALL
SELECT 'ledger net', SUM(t.points_amount)::text, count(*)::text || ' rows'
  FROM public.loyalty_transactions t
 WHERE t.member_id = 'd0d2b024-70af-4357-a489-d1d968adae66'
UNION ALL
SELECT 'live lots', COALESCE(SUM(l.remaining_amount), 0)::text, count(*)::text || ' rows'
  FROM public.loyalty_point_lots l
 WHERE l.member_id = 'd0d2b024-70af-4357-a489-d1d968adae66'
   AND l.revoked_at IS NULL AND l.expired_at IS NULL AND l.consumed_at IS NULL
UNION ALL
SELECT 'consumption rows for 19720', COALESCE(SUM(k.amount), 0)::text, count(*)::text || ' rows'
  FROM public.loyalty_lot_consumption k
 WHERE k.redemption_id = 'be433cb3-10da-4c32-9cbf-0061b02c2ea2'
 ORDER BY 1;

-- Expected AFTER:
--   counter                      0
--   ledger net                   0            12 rows   (unchanged — nothing was written)
--   live lots                    0            0 rows
--   consumption rows for 19720   4700         4 rows
--
--   700 (19260) + 1600 (19342) + 1900 (19480) + 500 (BIRTHDAY-2026) = 4700

-- And the member must fall out of the integrity report entirely:

SELECT * FROM public.loyalty_integrity_report()
 WHERE customer_code = 'CJ-2026-03608';
-- Expected: 0 rows.
--
-- The other two findings (CJ-2026-03608 aside) are unrelated and out of scope:
--   CJ-2026-05088 Test Customer — scaffolding
--   and any row this repair does not name is its own finding.

--------------------------------------------------------------------------
-- ROLLBACK
--------------------------------------------------------------------------
-- Only if the AFTER output is not what is printed above. Restores the exact
-- BEFORE state; the birthday lot is deleted rather than revoked because it
-- was created by this repair and never existed in production.
--
-- BEGIN;
--   DELETE FROM public.loyalty_lot_consumption
--    WHERE redemption_id = 'be433cb3-10da-4c32-9cbf-0061b02c2ea2';
--   UPDATE public.loyalty_point_lots SET remaining_amount = 700,  consumed_at = NULL
--    WHERE member_id = 'd0d2b024-70af-4357-a489-d1d968adae66' AND source_reference = '19260';
--   UPDATE public.loyalty_point_lots SET remaining_amount = 1600, consumed_at = NULL
--    WHERE member_id = 'd0d2b024-70af-4357-a489-d1d968adae66' AND source_reference = '19342';
--   UPDATE public.loyalty_point_lots SET remaining_amount = 1900, consumed_at = NULL
--    WHERE member_id = 'd0d2b024-70af-4357-a489-d1d968adae66' AND source_reference = '19480';
--   DELETE FROM public.loyalty_point_lots
--    WHERE member_id = 'd0d2b024-70af-4357-a489-d1d968adae66' AND source_type = 'birthday_bonus';
-- COMMIT;
