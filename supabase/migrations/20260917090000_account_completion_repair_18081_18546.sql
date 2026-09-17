-- Record-only data repair (2026-09-17). Applied live via the Supabase SQL Editor
-- on 2026-09-17; this file records it so a rebuild reproduces the same state.
-- Replaying it against live is a no-op — every block is guarded and idempotent.
--
-- See docs/FIXED-BUGS.md #282.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PART 1 — TWO FULLY-PAID ACCOUNTS NEVER LEFT 'active'
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ROOT CAUSE: floating-point residue, not a missing code path.
--
-- Before commit 136118dc ("refactor(payments): delegate allocation to
-- allocate_payment_atomic RPC", 2026-07-05 06:37 UTC), review-payment-submission
-- summed the account's payments in JavaScript and tested
--
--     verifiedRemaining <= 0
--
-- with NO rounding. For these two accounts the JS sums came out as
--
--     18081 : 32332.999999999996   (total_amount 32333.00)
--     18546 : 13124.999999999998   (total_amount 13125.00)
--
-- leaving a remaining of roughly 1e-12 — positive, so the completion branch was
-- skipped and the accounts stayed 'active' with remaining_balance 0.00.
--
-- ALREADY FIXED IN CODE. The live allocate_payment_atomic computes
--     v_new_remaining := greatest(0, round(total + penalties - paid, 2))
-- and compares THAT, so the residue cannot survive the rounding and the
-- comparison is exact. Every account confirmed from 2026-07-05 onward takes the
-- rounded path. This migration repairs the two rows stranded on the old one; it
-- does not change any function. (Do not "fix" the allocator here — it is
-- already correct, and per CLAUDE.md "FUNCTION CHANGES START FROM LIVE" no
-- function body is touched by this file.)
--
-- AFFECTED: invoices 18081 and 18546 only. A fleet sweep over every account in a
-- live status with all schedule rows paid and remaining_balance <= 0.01 returned
-- exactly these two. No customer impact — both orders had already shipped, both
-- customers had paid in full, and remaining_balance already read 0.00 on both, so
-- nothing was over-collected and no receivable was overstated. The defect was
-- confined to the status label and to completed_at being NULL.
--
-- completed_at is set to each account's LAST NON-VOIDED PAYMENT created_at, not
-- to now(). The accounts completed on 2026-07-04; stamping them today would put
-- two July completions into September's reporting. This needs two statements
-- because trigger_set_completed_at is a BEFORE trigger that forces
-- completed_at = now() on the transition into 'completed' — so the status flip
-- happens first and the true timestamp is written back after, while the status
-- is already 'completed' and the trigger's branches no longer fire.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PART 2 — ₱0.74 OF DOUBLE-COUNTED ALLOCATION ON 18081 INSTALLMENT 3
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Separate defect, same invoice, recorded here because it has no migration of
-- its own (a repo-wide search across every branch for the action name and both
-- allocation ids returned nothing — the block was pasted into the SQL Editor and
-- never committed, which is the gap this file closes).
--
-- The March 2026 bulk import allocated the CENTAVO TAILS of installments 1 and 2
-- a second time onto installment 3:
--
--     0.14  from the payment "Installment 1 (bulk import)" (amount 3732.14)
--     0.60  from the payment "Installment 2 (bulk import)" (amount 4060.60)
--
-- so month 3 carried 3792.38 of allocation against a ceiling of 3791.64 — over
-- by exactly 0.74, and each of those two payments was allocated 0.14 / 0.60 more
-- than it was worth. No money was wrong: total_paid comes from the payments table
-- (INVARIANT 1) and read 32333.00 throughout, remaining_balance was 0.00, and the
-- schedule's paid_amount was correctly capped at 3791.64. The error lived only in
-- the allocation ledger, where it was the sole finding of System Health's
-- Allocation Ceiling check on a live account.
--
-- Applied live 2026-09-17 06:57:51 UTC (audit_logs action
-- 'allocation_overage_repair'; performed_by_user_id NULL because auth.uid() is
-- NULL in the SQL Editor).

DO $mig$
DECLARE
  -- Part 2 constants
  c_alloc_1  CONSTANT uuid := 'b6f02f17-8b91-4d4d-9431-5c5c686e0179';  -- PHP 0.14
  c_alloc_2  CONSTANT uuid := '146f9eb4-1b24-40fb-96b6-5f6c3d81b135';  -- PHP 0.60
  c_schedule CONSTANT uuid := 'a9bafe74-ab2f-4028-9ecc-827999ca707f';  -- 18081, installment 3

  v_alloc_present int;
  v_alloc_total   numeric;
  v_account       uuid;

  -- Part 1 locals
  r               record;
  v_completed     int;
  v_pay_sum       numeric;
  v_last_paid_at  timestamptz;
  v_open_rows     int;
  v_penalties     int;
  v_services      int;
BEGIN
  -- ══ PART 2 — the 0.74 ══════════════════════════════════════════════════════
  SELECT count(*) INTO v_alloc_present
    FROM public.payment_allocations WHERE id IN (c_alloc_1, c_alloc_2);

  IF v_alloc_present = 0 THEN
    RAISE NOTICE 'Part 2 skipped: the two stray allocations are already gone.';
  ELSIF v_alloc_present <> 2 THEN
    RAISE NOTICE 'Part 2 SKIPPED: expected 2 stray allocations, found %. Left alone deliberately.', v_alloc_present;
  ELSE
    SELECT COALESCE(SUM(allocated_amount), 0) INTO v_alloc_total
      FROM public.payment_allocations WHERE schedule_id = c_schedule;

    IF round(v_alloc_total, 2) <> 3792.38 THEN
      RAISE NOTICE 'Part 2 SKIPPED: installment 3 allocation total is % , expected 3792.38. Left alone deliberately.', round(v_alloc_total, 2);
    ELSE
      SELECT s.account_id INTO v_account
        FROM public.layaway_schedule s WHERE s.id = c_schedule;

      DELETE FROM public.payment_allocations WHERE id IN (c_alloc_1, c_alloc_2);

      INSERT INTO public.audit_logs
        (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
      VALUES
        ('layaway_account', v_account, 'allocation_overage_repair',
         jsonb_build_object('invoice','18081','installment',3,'allocated',3792.38,'ceiling',3791.64,'over_by',0.74),
         jsonb_build_object('allocated', 3791.64,
                            'deleted_allocation_ids', jsonb_build_array(c_alloc_1, c_alloc_2),
                            'reason','March 2026 bulk import allocated the centavo tails of installments 1 and 2 onto month 3',
                            'source','migration 20260917090000 (replay)'),
         NULL);

      RAISE NOTICE 'Part 2 applied: 18081 installment 3 allocation 3792.38 -> 3791.64.';
    END IF;
  END IF;

  -- ══ PART 1 — the two stranded completions ══════════════════════════════════
  SELECT count(*) INTO v_completed
    FROM public.layaway_accounts
   WHERE invoice_number IN ('18081','18546') AND status = 'completed';

  IF v_completed = 2 THEN
    RAISE NOTICE 'Part 1 skipped: 18081 and 18546 are already completed.';
  ELSE
    FOR r IN
      SELECT a.id, a.invoice_number, a.status::text AS status,
             a.total_amount, a.total_paid, a.remaining_balance
        FROM public.layaway_accounts a
       WHERE a.invoice_number IN ('18081','18546')
         AND a.status::text = 'active'
       ORDER BY a.invoice_number
    LOOP
      SELECT COALESCE(SUM(p.amount_paid), 0), MAX(p.created_at)
        INTO v_pay_sum, v_last_paid_at
        FROM public.payments p
       WHERE p.account_id = r.id AND p.voided_at IS NULL;

      SELECT count(*) INTO v_open_rows
        FROM public.layaway_schedule s
       WHERE s.account_id = r.id AND s.status NOT IN ('paid','cancelled');

      SELECT count(*) INTO v_penalties
        FROM public.penalty_fees pf
       WHERE pf.account_id = r.id AND pf.status <> 'waived';

      SELECT count(*) INTO v_services
        FROM public.account_services sv WHERE sv.account_id = r.id;

      -- Every guard must hold. Any failure skips THIS account and leaves it alone.
      IF r.remaining_balance > 0.01
         OR round(r.total_paid, 2)   <> round(r.total_amount, 2)
         OR round(v_pay_sum, 2)      <> round(r.total_amount, 2)
         OR v_open_rows  <> 0
         OR v_penalties  <> 0
         OR v_services   <> 0
         OR v_last_paid_at IS NULL
      THEN
        RAISE NOTICE 'Part 1 SKIPPED % : guards not met (remaining % , total_paid % , total_amount % , payment_sum % , open_rows % , penalties % , services %).',
          r.invoice_number, r.remaining_balance, r.total_paid, r.total_amount, v_pay_sum, v_open_rows, v_penalties, v_services;
        CONTINUE;
      END IF;

      -- Statement 1: the transition. trigger_set_completed_at forces completed_at = now() here.
      UPDATE public.layaway_accounts SET status = 'completed' WHERE id = r.id;

      -- Statement 2: put the true completion timestamp back. Status is already
      -- 'completed', so neither branch of the trigger fires and this value stands.
      UPDATE public.layaway_accounts SET completed_at = v_last_paid_at WHERE id = r.id;

      INSERT INTO public.audit_logs
        (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
      VALUES
        ('layaway_account', r.id, 'account_completion_repair',
         jsonb_build_object('status', r.status, 'completed_at', NULL,
                            'remaining_balance', r.remaining_balance),
         jsonb_build_object('status','completed', 'completed_at', v_last_paid_at,
                            'reason','Final payment confirmed by the pre-136118dc TS allocator; unrounded float remaining (~1e-12) skipped completion',
                            'source','migration 20260917090000 (replay)'),
         NULL);

      RAISE NOTICE 'Part 1 applied % : status -> completed, completed_at -> %.', r.invoice_number, v_last_paid_at;
    END LOOP;
  END IF;
END
$mig$;
