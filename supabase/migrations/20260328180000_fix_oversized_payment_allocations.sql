-- ─────────────────────────────────────────────────────────────────────────────
-- Fix oversized payment_allocations
--
-- record-payment stored entire overflow amounts (e.g. ₱7,914) as a single
-- allocation against one schedule row whose base is only ₱3,014, leaving
-- subsequent rows with 0 allocations and incorrect statuses.
--
-- This script:
--   0. Identifies affected payment_ids via the listed allocation IDs
--   1. Deletes all installment allocations for each affected payment
--   2. Re-creates allocations using waterfall (fills each row up to base, carries remainder)
--   3. Syncs schedule rows (paid_amount, total_due_amount, status)
--   4. Syncs account totals (total_paid, remaining_balance)
--   5. Verifies no oversized allocations remain
--
-- Special cases handled:
--   INV #18593: base_installment_amount = 0 on some rows — skipped (investigate separately)
--   INV #17416: 2 duplicate IDs (9b7c4a38, fc45ef32) same payment — delete both, one split
--   INV #17666: 4 duplicate IDs same installment — delete all 4, one split
--   INV #18474: 2 duplicate IDs same payment — delete both, one split
--
-- IDs in the list that are amounts (not UUIDs) and are skipped:
--   5700.00, 2240.00, 2798.00
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 0. Collect affected payment_ids ──────────────────────────────────────────
CREATE TEMP TABLE _fix_payments AS
SELECT DISTINCT pa.payment_id,
                ls.account_id
FROM   payment_allocations pa
JOIN   layaway_schedule ls ON ls.id = pa.schedule_id
WHERE  LEFT(pa.id::text, 8) IN (
         '2ed8576b','8e4e1780','9b7c4a38','fc45ef32','9e0a4cb2',
         'eb700f04','3be99468','e9c6b316','d2dc2774','8c196fa8',
         '28b94590','cbfbc611','6f367f3b','8e488eed','3ffcdc94',
         'e7465b3e','be4963aa',
         -- '5700.00' skipped (not a UUID)
         'f042ee73','844b47cb','e28e615a','f540013f','84536470',
         '4a758359','4c9af298','8dabcc98','328aaa52','c0e6076d',
         '426b3d32','f1dd3ba4','0ec4ae27','a281d2e9','f39a38e3',
         '99b67da1','ef0b4a0a','b7d9ef5f','87b85b1f','ab13404a',
         '2286e90f','e8e31ce6','50484e68','7cfd5de2','41ae4194',
         '5809a128','9ade8601',
         -- '2240.00','2798.00' skipped (not UUIDs)
         '4fd79bcb','0fa0365c'
       )
AND    pa.allocated_amount > ls.base_installment_amount
AND    ls.base_installment_amount > 0;   -- skip INV #18593 zero-base rows

DO $$
BEGIN
  RAISE NOTICE '── Affected payments to fix: %',
    (SELECT COUNT(*) FROM _fix_payments);
END $$;

-- ── 1. Waterfall re-allocation ────────────────────────────────────────────────
DO $$
DECLARE
  r        RECORD;
  s        RECORD;
  v_remain NUMERIC;
  v_needed NUMERIC;
  v_alloc  NUMERIC;
BEGIN
  FOR r IN (
    SELECT payment_id, account_id
    FROM   _fix_payments
    ORDER  BY account_id, payment_id
  ) LOOP

    SELECT amount_paid INTO v_remain
    FROM   payments
    WHERE  id = r.payment_id;

    IF v_remain IS NULL THEN
      RAISE WARNING 'Payment % not found – skipping', r.payment_id;
      CONTINUE;
    END IF;

    RAISE NOTICE 'Payment % | account % | amount %',
      r.payment_id, r.account_id, v_remain;

    -- Delete ALL installment allocations for this payment (clean slate).
    -- Handles duplicate-ID cases (INV #17416, #17666, #18474) automatically.
    DELETE FROM payment_allocations
    WHERE  payment_id     = r.payment_id
    AND    allocation_type = 'installment';

    -- Waterfall: fill each schedule row up to its base, carry remainder forward.
    -- other_alloc = sum from ALL OTHER payments already allocated to each row.
    FOR s IN (
      SELECT ls.id                        AS schedule_id,
             ls.installment_number,
             ls.base_installment_amount,
             COALESCE(
               (SELECT SUM(pa2.allocated_amount)
                FROM   payment_allocations pa2
                WHERE  pa2.schedule_id     = ls.id
                AND    pa2.allocation_type = 'installment'),
               0
             )                            AS other_alloc
      FROM   layaway_schedule ls
      WHERE  ls.account_id              = r.account_id
      AND    ls.status                 <> 'cancelled'
      AND    ls.base_installment_amount  > 0
      ORDER  BY ls.installment_number
    ) LOOP
      EXIT WHEN v_remain <= 0.005;

      v_needed := GREATEST(0, s.base_installment_amount - s.other_alloc);

      IF v_needed > 0.005 THEN
        v_alloc  := LEAST(v_remain, v_needed);
        INSERT INTO payment_allocations
               (payment_id, schedule_id, allocated_amount, allocation_type)
        VALUES (r.payment_id, s.schedule_id, v_alloc, 'installment');
        v_remain := v_remain - v_alloc;
        RAISE NOTICE '  installment #%: +% (base %, other already %)',
          s.installment_number, v_alloc,
          s.base_installment_amount, s.other_alloc;
      END IF;
    END LOOP;

    IF v_remain > 0.005 THEN
      RAISE WARNING '  % unallocated after waterfall – payment may exceed all installments',
        v_remain;
    END IF;

  END LOOP;
END $$;

-- ── 2. Sync schedule rows for affected accounts ───────────────────────────────
UPDATE layaway_schedule ls
SET
  paid_amount      = sums.correct_paid,
  total_due_amount = sums.correct_due,
  status           = sums.correct_status,
  updated_at       = NOW()
FROM (
  SELECT
    ls2.id,
    -- alloc_sum: total allocated to this row across all payments
    COALESCE(SUM(pa.allocated_amount), 0)                          AS alloc_sum,
    -- correct_paid: capped at base (never store overflow)
    LEAST(
      COALESCE(SUM(pa.allocated_amount), 0),
      ls2.base_installment_amount
    )                                                              AS correct_paid,
    -- correct_due:
    --   paid         → base (normalised)
    --   partially_paid → base - paid (remaining)
    --   pending/overdue → base + penalty
    CASE
      WHEN COALESCE(SUM(pa.allocated_amount), 0) >= ls2.base_installment_amount - 0.005
        THEN ls2.base_installment_amount
      WHEN COALESCE(SUM(pa.allocated_amount), 0) > 0
        THEN GREATEST(0, ls2.base_installment_amount - COALESCE(SUM(pa.allocated_amount), 0))
      ELSE ls2.base_installment_amount + COALESCE(ls2.penalty_amount, 0)
    END                                                            AS correct_due,
    -- correct_status
    CASE
      WHEN COALESCE(SUM(pa.allocated_amount), 0) >= ls2.base_installment_amount - 0.005
        THEN 'paid'
      WHEN COALESCE(SUM(pa.allocated_amount), 0) > 0
        THEN 'partially_paid'
      WHEN ls2.due_date < CURRENT_DATE
        THEN 'overdue'
      ELSE 'pending'
    END                                                            AS correct_status
  FROM  layaway_schedule ls2
  LEFT  JOIN payment_allocations pa
         ON  pa.schedule_id     = ls2.id
         AND pa.allocation_type = 'installment'
  WHERE ls2.account_id IN (SELECT account_id FROM _fix_payments)
  AND   ls2.status     <> 'cancelled'
  GROUP BY ls2.id,
           ls2.base_installment_amount,
           ls2.penalty_amount,
           ls2.due_date
) sums
WHERE ls.id = sums.id
AND (
  ls.paid_amount      IS DISTINCT FROM sums.correct_paid   OR
  ls.total_due_amount IS DISTINCT FROM sums.correct_due    OR
  ls.status           IS DISTINCT FROM sums.correct_status
);

DO $$
BEGIN
  RAISE NOTICE '── Schedule rows updated: %', ROW_COUNT();
END $$;

-- ── 3. Sync account totals ────────────────────────────────────────────────────
-- total_paid        = SUM(non-voided payments)
-- remaining_balance = total_amount + activePenalties + services - total_paid
UPDATE layaway_accounts la
SET
  total_paid = (
    SELECT COALESCE(SUM(p.amount_paid), 0)
    FROM   payments p
    WHERE  p.account_id = la.id
    AND    p.voided_at IS NULL
  ),
  remaining_balance = GREATEST(0,
      la.total_amount
    + COALESCE(
        (SELECT SUM(pf.penalty_amount) FROM penalty_fees pf
         WHERE  pf.account_id = la.id AND pf.status <> 'waived'), 0)
    + COALESCE(
        (SELECT SUM(svc.amount) FROM account_services svc
         WHERE  svc.account_id = la.id), 0)
    - (SELECT COALESCE(SUM(p.amount_paid), 0) FROM payments p
       WHERE  p.account_id = la.id AND p.voided_at IS NULL)
  ),
  updated_at = NOW()
WHERE la.id IN (SELECT account_id FROM _fix_payments);

DO $$
BEGIN
  RAISE NOTICE '── Account totals synced: %', ROW_COUNT();
END $$;

-- ── 4. Verify: should be 0 ────────────────────────────────────────────────────
DO $$
DECLARE v_remaining INT;
BEGIN
  SELECT COUNT(*) INTO v_remaining
  FROM   payment_allocations pa
  JOIN   layaway_schedule    ls ON ls.id = pa.schedule_id
  WHERE  pa.allocated_amount       > ls.base_installment_amount
  AND    ls.base_installment_amount > 0;

  IF v_remaining = 0 THEN
    RAISE NOTICE '✓ Verification passed – 0 oversized allocations remain';
  ELSE
    RAISE WARNING '✗ % oversized allocation(s) still remain – investigate', v_remaining;
  END IF;
END $$;

-- ── 5. Cleanup ────────────────────────────────────────────────────────────────
DROP TABLE _fix_payments;

COMMIT;
