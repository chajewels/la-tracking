-- Bug #280 (2026-09-17): redemption stopped consuming point lots, and the
-- birthday bonus never created one. Three changes, applied together because
-- the order between them is load-bearing.
--
-- ============================================================================
-- WHY THIS IS A MIGRATION AND NOT ANOTHER SQL EDITOR SESSION
-- ============================================================================
-- The lot-wiring existed before. It was applied live in the SQL Editor on
-- 2026-07-05 (docs/SYSTEM-STATUS.md records it) and never committed. The repo
-- baseline 20260705230000, generated the SAME DAY, does not contain it.
--
-- On 2026-09-12, 20260912000000_redemption_closed_order_guard.sql rebuilt
-- approve_redemption_atomic. Its header reads:
--
--     "Body copied verbatim from the live baseline (20260705230000, lines
--      1899-2081 — no later migration redefines this function)"
--
-- That statement was TRUE and it was NOT EVIDENCE. No later *migration*
-- redefined it; a SQL Editor session had. The rebuild silently reverted live
-- to a body with no lot consumption, and consume_lots_fifo was left with ZERO
-- CALLERS. Every redemption approved after that debited the counter and left
-- the lots untouched.
--
-- The symmetry proves it. The same baseline is ALSO missing
-- restore_lots_for_redemption inside void_redemption_atomic — yet live void
-- still calls it, because no migration ever rebuilt void. The function rebuilt
-- from the bad baseline lost its wiring; its twin, left alone, kept it.
--
-- WHAT THE BASELINE WAS MISSING, precisely, so the next person knows what to
-- look for:
--     approve_redemption_atomic  — the consume_lots_fifo call        (restored below)
--     void_redemption_atomic     — the restore_lots_for_redemption call
--                                  (live has it; the baseline does not.
--                                   DO NOT "fix" void from the baseline.)
--
-- THE RULE THIS COST US (now in CLAUDE.md): a SQL Editor change that is never
-- committed as a migration is invisible to every later rebuild. Before you
-- replace a function body, diff it against LIVE — pg_get_functiondef — not
-- against the baseline. "No later migration redefines this function" says
-- nothing about what live actually runs.
--
-- ============================================================================
-- WHY ALL THREE PARTS SHIP TOGETHER
-- ============================================================================
-- consume_lots_fifo RAISES 'insufficient lot balance' rather than
-- under-consuming, and approve's own gate checks the COUNTER — which includes
-- bonus points that have no lot. Re-wiring approve (part 1) without
-- lot-wiring the birthday bonus (part 2) therefore turns a silent drift into a
-- hard failure: the next member holding a birthday bonus passes the counter
-- gate and then aborts at the lot stage. The member who triggered this bug
-- would have had her redemption refused.
--
-- Part 3 is the check that would have caught the whole thing within minutes.
--
-- This migration does NOT repair existing drift. The one affected member is
-- repaired separately and deliberately by
-- docs/sql/20260917_loyalty_lot_repair_CJ-2026-03608.sql, which is safe to run
-- before or after this.


-- ============================================================================
-- PART 1 — approve_redemption_atomic consumes the lots again
-- ============================================================================
-- Live body as of 2026-09-17 (pg_get_functiondef), with ONE insertion: step 5b.
-- The closed-order guards from 20260912000000 are retained verbatim.
--
-- Placement: immediately after the counter debit, inside the same transaction.
-- The redemption row already exists (loyalty_lot_consumption.redemption_id
-- points at it), and an insufficiency raises, which rolls back the whole
-- approve — nothing is debited, exactly as the stock-depletion guard behaves.

CREATE OR REPLACE FUNCTION public.approve_redemption_atomic(p_redemption_id uuid, p_user_id uuid, p_user_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  m record;
  v_tier_name text;
  v_tx_id uuid;
  v_payment_id uuid;
  v_pts numeric;
  v_payment_amount numeric;
  v_currency text;
  v_total_amount numeric;
  v_new_total_paid numeric;
  v_new_remaining numeric;
  v_new_status text;
  v_reduce_jpy numeric;
  v_stock int;
  v_rows int;
  v_today date := CURRENT_DATE;
  v_ref text;
  v_remarks text;
  v_note text;
  v_lots_consumed integer;
BEGIN
  -- 1. Lock redemption; must be pending (closes double-approve race)
  SELECT * INTO r FROM public.loyalty_redemptions WHERE id = p_redemption_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'redemption_not_found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'redemption_not_pending:%', r.status; END IF;
  v_pts := r.points_redeemed;

  -- 2. Lock member; validate balance
  SELECT id, customer_id, remaining_points, total_points_redeemed, current_tier_id
    INTO m FROM public.loyalty_members WHERE id = r.member_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'member_not_found'; END IF;
  IF v_pts > COALESCE(m.remaining_points, 0) THEN RAISE EXCEPTION 'insufficient_points'; END IF;
  SELECT name INTO v_tier_name FROM public.loyalty_tiers WHERE id = m.current_tier_id;

  -- 3. Redemption transaction
  INSERT INTO public.loyalty_transactions
    (member_id, transaction_type, points_amount, account_id, cash_order_id, invoice_number, tier_at_time, notes)
  VALUES
    (m.id, 'redeemed', -v_pts, r.account_id, r.cash_order_id, r.invoice_number, v_tier_name,
     'Redemption: ' || r.redemption_type)
  RETURNING id INTO v_tx_id;

  -- 4. Flip redemption
  UPDATE public.loyalty_redemptions
     SET status = 'confirmed', transaction_id = v_tx_id,
         processed_by_user_id = p_user_id, processed_at = now()
   WHERE id = r.id;

  -- 5. Debit member (relative arithmetic — closes lost-update race)
  UPDATE public.loyalty_members
     SET remaining_points = remaining_points - v_pts,
         total_points_redeemed = COALESCE(total_points_redeemed, 0) + v_pts
   WHERE id = m.id;

  -- 5b. Consume the point lots FIFO, and record which lots paid for this
  --     redemption. RESTORED 2026-09-17 (Bug #280) — this call was wired live
  --     on 2026-07-05, was absent from the baseline, and was lost when
  --     20260912000000 rebuilt this function from that baseline.
  --     Not optional and not best-effort: loyalty_lot_consumption is what
  --     void_redemption_atomic reads to give the points back, so a redemption
  --     without these rows cannot be reversed correctly. An insufficiency
  --     raises and rolls back the entire approve.
  v_lots_consumed := public.consume_lots_fifo(m.id, r.id, v_pts::integer);

  -- 6. Catalog stock — depletion aborts the entire approve
  IF r.redemption_type = 'catalog_reward' AND r.reward_id IS NOT NULL THEN
    SELECT current_stock INTO v_stock FROM public.loyalty_rewards WHERE id = r.reward_id FOR UPDATE;
    IF FOUND AND v_stock IS NOT NULL THEN
      UPDATE public.loyalty_rewards SET current_stock = current_stock - 1
       WHERE id = r.reward_id AND current_stock > 0;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 0 THEN RAISE EXCEPTION 'reward_out_of_stock'; END IF;
    END IF;
  END IF;

  -- 7. new_order_discount: net-spend reduce + synthetic payment + totals
  IF r.redemption_type = 'new_order_discount' AND (r.account_id IS NOT NULL OR r.cash_order_id IS NOT NULL) THEN
    v_ref := 'LOYALTY-' || r.id;
    v_reduce_jpy := COALESCE(r.value_applied_jpy, 0);

    IF r.account_id IS NOT NULL THEN
      IF v_reduce_jpy > 0 THEN
        UPDATE public.layaway_accounts
           SET loyalty_jpy_amount = GREATEST(0, COALESCE(loyalty_jpy_amount, 0) - v_reduce_jpy)
         WHERE id = r.account_id;
      END IF;
      SELECT currency::text INTO v_currency FROM public.layaway_accounts WHERE id = r.account_id FOR UPDATE;
      -- Closed-order guard (2026-09-12): never apply a redemption to a cancelled/forfeited/completed/settled layaway.
      PERFORM 1 FROM public.layaway_accounts
        WHERE id = r.account_id
          AND status IN ('cancelled','forfeited','completed','final_settlement');
      IF FOUND THEN RAISE EXCEPTION 'account_not_open:%', (SELECT status FROM public.layaway_accounts WHERE id = r.account_id); END IF;
      v_payment_amount := CASE WHEN v_currency = 'PHP' THEN COALESCE(r.value_applied_php, 0)
                               ELSE COALESCE(r.value_applied_jpy, 0) END;
      IF v_payment_amount > 0 AND v_currency IS NOT NULL THEN
        v_remarks := 'Loyalty redemption: ' || v_pts || ' pts (' || r.redemption_type || ') (applied to downpayment)';
        INSERT INTO public.payments
          (account_id, amount_paid, currency, date_paid, payment_method, reference_number, remarks,
           entered_by_user_id, submitted_by_type, submitted_by_name)
        VALUES
          (r.account_id, v_payment_amount, v_currency::account_currency, v_today, 'loyalty_redemption', v_ref, v_remarks,
           p_user_id, 'staff', COALESCE(p_user_email, 'Admin'))
        RETURNING id INTO v_payment_id;

        SELECT total_paid, remaining_balance, status::text
          INTO v_new_total_paid, v_new_remaining, v_new_status
          FROM public.layaway_accounts WHERE id = r.account_id;
        v_new_total_paid := COALESCE(v_new_total_paid, 0) + v_payment_amount;
        v_new_remaining := COALESCE(v_new_remaining, 0) - v_payment_amount;
        IF v_new_remaining <= 0.01 THEN
          v_new_status := 'completed';
        ELSIF v_new_status = 'overdue' AND NOT EXISTS (
          SELECT 1 FROM public.layaway_schedule
           WHERE account_id = r.account_id AND status = 'overdue'::schedule_status
        ) THEN
          v_new_status := 'active';
        END IF;
        UPDATE public.layaway_accounts
           SET total_paid = v_new_total_paid,
               remaining_balance = v_new_remaining,
               status = v_new_status::account_status
         WHERE id = r.account_id;
      END IF;

    ELSE
      IF v_reduce_jpy > 0 THEN
        UPDATE public.cash_orders
           SET loyalty_jpy_amount = GREATEST(0, COALESCE(loyalty_jpy_amount, 0) - v_reduce_jpy)
         WHERE id = r.cash_order_id;
      END IF;
      SELECT currency::text, total_amount INTO v_currency, v_total_amount
        FROM public.cash_orders WHERE id = r.cash_order_id FOR UPDATE;
      -- Closed-order guard (2026-09-12): cash order must still be pending.
      PERFORM 1 FROM public.cash_orders WHERE id = r.cash_order_id AND status <> 'pending';
      IF FOUND THEN RAISE EXCEPTION 'account_not_open:%', (SELECT status FROM public.cash_orders WHERE id = r.cash_order_id); END IF;
      v_payment_amount := CASE WHEN v_currency = 'PHP' THEN COALESCE(r.value_applied_php, 0)
                               ELSE COALESCE(r.value_applied_jpy, 0) END;
      IF v_payment_amount > 0 AND v_currency IS NOT NULL THEN
        v_remarks := 'Loyalty redemption: ' || v_pts || ' pts (' || r.redemption_type || ')';
        INSERT INTO public.cash_payments
          (cash_order_id, amount_paid, currency, date_paid, payment_method, reference_number, remarks,
           entered_by_user_id, submitted_by_type, submitted_by_name)
        VALUES
          (r.cash_order_id, v_payment_amount, v_currency::account_currency, v_today, 'loyalty_redemption', v_ref, v_remarks,
           p_user_id, 'staff', COALESCE(p_user_email, 'Admin'));

        SELECT COALESCE(SUM(amount_paid), 0) INTO v_new_total_paid
          FROM public.cash_payments
         WHERE cash_order_id = r.cash_order_id AND voided_at IS NULL;
        v_new_remaining := COALESCE(v_total_amount, 0) - v_new_total_paid;
        UPDATE public.cash_orders
           SET total_paid = v_new_total_paid,
               remaining_balance = v_new_remaining,
               updated_at = now(),
               status = CASE WHEN v_new_remaining <= 0 THEN 'completed' ELSE status END,
               completed_at = CASE WHEN v_new_remaining <= 0 THEN now() ELSE completed_at END
         WHERE id = r.cash_order_id;
      END IF;
    END IF;
  END IF;

  -- 7b. Loyalty trail — account note (only when linked to an account or cash order)
  IF r.account_id IS NOT NULL OR r.cash_order_id IS NOT NULL THEN
    v_note := 'Loyalty: ' || v_pts || ' pts redeemed (' || r.redemption_type || ')';
    IF v_payment_amount IS NOT NULL AND v_payment_amount > 0 THEN
      v_note := v_note || ' — ' || CASE WHEN v_currency = 'PHP' THEN '₱' ELSE '¥' END
                || v_payment_amount || ' applied to balance';
    END IF;
    INSERT INTO public.account_notes
      (account_id, cash_order_id, note_text, created_by_user_id, created_by_name)
    VALUES
      (r.account_id, r.cash_order_id, v_note, p_user_id, 'System (Loyalty)');
  END IF;

  -- 8. Audit log
  INSERT INTO public.audit_logs
    (entity_type, entity_id, action, performed_by_user_id, old_value_json, new_value_json)
  VALUES
    ('loyalty_redemption', r.id, 'redemption_approved', p_user_id,
     jsonb_build_object('status', 'pending'),
     jsonb_build_object('status', 'confirmed', 'transaction_id', v_tx_id,
                        'points_redeemed', v_pts, 'redemption_type', r.redemption_type,
                        'invoice_number', r.invoice_number,
                        'lots_consumed', v_lots_consumed));

  RETURN jsonb_build_object(
    'transaction_id', v_tx_id,
    'payment_id', v_payment_id,
    'new_remaining_points', COALESCE(m.remaining_points, 0) - v_pts,
    'tier_name', v_tier_name,
    'account_status', v_new_status,
    'payment_amount', v_payment_amount,
    'currency', v_currency,
    'lots_consumed', v_lots_consumed
  );
END
$function$;


-- ============================================================================
-- PART 2 — the birthday bonus creates a lot
-- ============================================================================
-- Live body as of 2026-09-17 with ONE insertion: the lot write, and the ledger
-- INSERT now returns its created_at so the lot's earned_at matches the ledger
-- row to the microsecond.
--
-- MUST ship with part 1. Without it, the first member to redeem while holding
-- a lot-less birthday bonus passes approve's counter check and then hits
-- consume_lots_fifo's 'insufficient lot balance' — a hard refusal of a
-- redemption the customer is entitled to.
--
-- source_type 'birthday_bonus': the enum carries it, it is self-describing,
-- and none of revoke_loyalty_points / revoke_loyalty_points_partial /
-- restore_loyalty_points treats it differently from promo_bonus — all three
-- act on order_earn only.
--
-- expires_at: insert_lot_and_extend computes a default for order_earn ONLY and
-- leaves every other source type to the caller, so it must be passed or the
-- lot never expires. 180 days from the award, the same clock order_earn lots
-- carry. The rolling extension inside insert_lot_and_extend fires only for
-- order_earn, so awarding a birthday bonus does not move anybody's other
-- expiry dates.

CREATE OR REPLACE FUNCTION public._award_birthday_reward(p_customer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_year      smallint := EXTRACT(YEAR  FROM (now() AT TIME ZONE 'Asia/Manila'))::smallint;
  v_month     int      := EXTRACT(MONTH FROM (now() AT TIME ZONE 'Asia/Manila'))::int;
  v_member_id uuid;
  v_tier_id   uuid;
  v_tier_name text;
  v_bonus     integer;
  v_guarded   int;
  v_awarded_at timestamptz;
  v_lot_id    uuid;
BEGIN
  -- Atomic guard: stamp the year ONLY if it's the birth month and not already claimed this year.
  UPDATE public.customers c
  SET last_birthday_award_year = v_year
  WHERE c.id = p_customer_id
    AND c.birthday IS NOT NULL
    AND EXTRACT(MONTH FROM c.birthday) = v_month
    AND c.last_birthday_award_year IS DISTINCT FROM v_year;
  GET DIAGNOSTICS v_guarded = ROW_COUNT;

  IF v_guarded = 0 THEN
    RAISE EXCEPTION 'Birthday reward not available: no birthday set, not your birthday month, or already claimed this year';
  END IF;

  SELECT lm.id, lm.current_tier_id INTO v_member_id, v_tier_id
  FROM public.loyalty_members lm WHERE lm.customer_id = p_customer_id;

  IF v_member_id IS NULL THEN
    RAISE EXCEPTION 'No loyalty member record for this customer';
  END IF;

  SELECT lt.birthday_bonus_points, lt.name INTO v_bonus, v_tier_name
  FROM public.loyalty_tiers lt WHERE lt.id = v_tier_id;

  IF v_bonus IS NULL OR v_bonus <= 0 THEN
    RAISE EXCEPTION 'No birthday bonus configured for this tier';
  END IF;

  UPDATE public.loyalty_members lm
  SET remaining_points    = lm.remaining_points    + v_bonus,
      total_points_earned = lm.total_points_earned + v_bonus
  WHERE lm.id = v_member_id;

  INSERT INTO public.loyalty_transactions
    (member_id, transaction_type, points_amount, tier_at_time, notes)
  VALUES
    (v_member_id, 'birthday_bonus'::loyalty_transaction_type, v_bonus, v_tier_name,
     'Birthday bonus ' || v_year::text)
  RETURNING created_at INTO v_awarded_at;

  -- The lot. ADDED 2026-09-17 (Bug #280): this function credited the counter
  -- and the ledger and created no lot, so the points existed for the balance
  -- and for redemption but not for FIFO consumption or expiry.
  v_lot_id := public.insert_lot_and_extend(
    p_member_id        => v_member_id,
    p_source_type      => 'birthday_bonus'::loyalty_lot_source_type,
    p_source_reference => 'BIRTHDAY-' || v_year::text,
    p_amount           => v_bonus,
    p_earned_at        => v_awarded_at,
    p_expires_at       => v_awarded_at + INTERVAL '180 days',
    p_notes            => 'Birthday bonus ' || v_year::text
  );

  RETURN jsonb_build_object('success', true, 'points_awarded', v_bonus, 'tier', v_tier_name,
                            'year', v_year, 'lot_id', v_lot_id);
END;
$function$;


-- ============================================================================
-- PART 3 — the check that would have caught this in minutes
-- ============================================================================
-- Predicate 6: for every CONFIRMED redemption, the lot consumption recorded
-- against it must equal the points redeemed.
--
-- Predicate 1 ('counter ≠ live lots') caught this member only because the two
-- faults happened not to cancel. It is a BALANCE check: it compares totals and
-- cannot see which lots paid, or whether anything was recorded at all. This one
-- is per-redemption and fires on the redemption itself.
--
-- Scope: processed_at >= 2026-07-05, the day lot-wiring first went live. The 17
-- redemptions confirmed before it legitimately have no consumption rows and are
-- not findings. Verified: the two July stragglers are both 2026-07-02, the
-- first wired redemption is 2026-07-07 10:46:46, and nothing sits between.
--
-- restored_at IS NULL excludes rows a void has already given back; a voided
-- redemption is status 'cancelled' and out of scope anyway.
--
-- No signature change — the finding is appended to `problem`, so
-- CREATE OR REPLACE is enough and no caller has to change.
--
-- Returns exactly one row today: CJ-2026-03608, invoice 19720. It returns zero
-- once docs/sql/20260917_loyalty_lot_repair_CJ-2026-03608.sql has been run.

CREATE OR REPLACE FUNCTION public.loyalty_integrity_report()
 RETURNS TABLE(member_id uuid, customer_code text, full_name text, counter_points numeric, lots_live numeric, ledger_net numeric, tier_now text, tier_from_spend text, is_downgraded boolean, spend_stored numeric, spend_expected numeric, terminal_order_spend numeric, problem text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Staff only. Customers hold authenticated sessions too, so the role check
  -- lives inside the function, not in the grant.
  IF auth.uid() IS NOT NULL AND NOT (
       public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'finance')
    OR public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'csr')) THEN
    RAISE EXCEPTION 'staff role required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH lots AS (
    SELECT l.member_id, SUM(l.remaining_amount)::numeric AS live FROM public.loyalty_point_lots l
     WHERE l.revoked_at IS NULL AND l.expired_at IS NULL AND l.consumed_at IS NULL GROUP BY l.member_id),
  led AS (SELECT t.member_id, SUM(t.points_amount)::numeric AS net FROM public.loyalty_transactions t GROUP BY t.member_id),
  -- Spend ledger. 'adjusted' rows are DEDUCTIONS recorded as a positive
  -- spend_amount_jpy (the convention CJ-2026-01504's 2026-08-26 manual
  -- corrections set, and the only way the type is used: 3 rows, all positive).
  spend_led AS (
    SELECT t.member_id,
           SUM(CASE WHEN t.transaction_type = 'earned'   THEN  COALESCE(t.spend_amount_jpy, 0)
                    WHEN t.transaction_type = 'revoked'  THEN -COALESCE(t.spend_amount_jpy, 0)
                    WHEN t.transaction_type = 'adjusted' THEN -COALESCE(t.spend_amount_jpy, 0)
                    ELSE 0 END)::numeric AS net
      FROM public.loyalty_transactions t GROUP BY t.member_id),
  spend_tier AS (
    SELECT m.id AS member_id,
           (SELECT x.name FROM public.loyalty_tiers x WHERE x.min_spend_jpy <= m.cumulative_spend_jpy ORDER BY x.min_spend_jpy DESC LIMIT 1) AS name
      FROM public.loyalty_members m),
  -- Spend still standing against orders that are over. A cancelled, expired or
  -- forfeited order must have given its spend back; if loyalty_order_spend_basis
  -- is still positive, the reversal never happened.
  terminal AS (
    SELECT m.id AS member_id,
           COALESCE(SUM(public.loyalty_order_spend_basis(m.id, o.invoice_number)), 0)::numeric AS spend
      FROM public.loyalty_members m
      JOIN LATERAL (
        SELECT la.invoice_number FROM public.layaway_accounts la
         WHERE la.customer_id = m.customer_id
           AND la.status::text IN ('cancelled', 'forfeited', 'final_forfeited')
        UNION ALL
        SELECT co.invoice_number FROM public.cash_orders co
         WHERE co.customer_id = m.customer_id
           AND co.status::text IN ('cancelled', 'expired')
      ) o ON true
     GROUP BY m.id),
  -- Predicate 6 (2026-09-17, Bug #280). Per-redemption, not per-member: the
  -- lots recorded as paying for a confirmed redemption must total the points
  -- redeemed. Predicate 1 is a balance check and cannot see a redemption that
  -- consumed nothing whenever another fault happens to offset it.
  redeem AS (
    SELECT red.member_id,
           count(*)::int AS bad,
           string_agg(COALESCE(red.invoice_number, red.id::text), ', ' ORDER BY red.processed_at) AS invoices
      FROM public.loyalty_redemptions red
     WHERE red.status = 'confirmed'
       AND red.processed_at >= timestamptz '2026-07-05'
       AND red.points_redeemed <> COALESCE((
             SELECT SUM(k.amount) FROM public.loyalty_lot_consumption k
              WHERE k.redemption_id = red.id AND k.restored_at IS NULL), 0)
     GROUP BY red.member_id)
  SELECT m.id, c.customer_code, c.full_name,
         m.remaining_points, COALESCE(l.live, 0), COALESCE(d.net, 0),
         t.name, st.name, m.is_downgraded,
         m.cumulative_spend_jpy,
         COALESCE(m.spend_baseline_jpy, 0) + COALESCE(s.net, 0),
         COALESCE(tm.spend, 0),
         concat_ws('; ',
           CASE WHEN m.remaining_points <> COALESCE(l.live, 0) THEN 'counter ≠ live lots' END,
           CASE WHEN m.remaining_points <> COALESCE(d.net, 0) THEN 'counter ≠ ledger net' END,
           CASE WHEN NOT m.is_downgraded AND t.name IS DISTINCT FROM st.name THEN 'tier ≠ tier from lifetime spend' END,
           -- Predicate 4. Catches a cancellation that did not reverse its
           -- spend, which predicate 3 cannot see because it reads the tier
           -- back out of the same number.
           CASE WHEN m.cumulative_spend_jpy <> COALESCE(m.spend_baseline_jpy, 0) + COALESCE(s.net, 0)
                THEN 'lifetime spend ≠ migration baseline + ledger spend' END,
           -- Predicate 5. The one that would have caught TEST-900008 the day it
           -- was cancelled. Independent of predicate 4: here the counter and the
           -- ledger agree, and both are wrong.
           CASE WHEN COALESCE(tm.spend, 0) > 0
                THEN 'cancelled/forfeited order still counting ' || COALESCE(tm.spend, 0)::text || ' JPY of lifetime spend' END,
           -- Predicate 6.
           CASE WHEN COALESCE(rd.bad, 0) > 0
                THEN rd.bad::text || ' confirmed redemption(s) whose lot consumption ≠ points redeemed (' || rd.invoices || ')' END)
    FROM public.loyalty_members m
    JOIN public.customers c ON c.id = m.customer_id
    LEFT JOIN public.loyalty_tiers t ON t.id = m.current_tier_id
    LEFT JOIN lots l ON l.member_id = m.id
    LEFT JOIN led d ON d.member_id = m.id
    LEFT JOIN spend_led s ON s.member_id = m.id
    LEFT JOIN spend_tier st ON st.member_id = m.id
    LEFT JOIN terminal tm ON tm.member_id = m.id
    LEFT JOIN redeem rd ON rd.member_id = m.id
   WHERE m.remaining_points <> COALESCE(l.live, 0)
      OR m.remaining_points <> COALESCE(d.net, 0)
      OR (NOT m.is_downgraded AND t.name IS DISTINCT FROM st.name)
      OR m.cumulative_spend_jpy <> COALESCE(m.spend_baseline_jpy, 0) + COALESCE(s.net, 0)
      OR COALESCE(tm.spend, 0) > 0
      OR COALESCE(rd.bad, 0) > 0
   ORDER BY c.customer_code;
END $function$;
