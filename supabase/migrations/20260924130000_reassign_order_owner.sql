-- =============================================================================
-- REASSIGN OWNER for layaway AND cash orders, with loyalty catch-up
-- (owner-approved 2026-09-24; rules R1–R10 in CLAUDE.md "REASSIGN OWNER").
--
-- NOT APPLIED BY ANY TOOLING. The owner runs this file in the SQL Editor, then
-- the reassign-order-owner (new) and award-loyalty-points (changed) edge
-- functions are deployed. Deploying the functions before this file is applied
-- makes every reassign fail with "function does not exist" — nothing is
-- written, but nothing works either.
--
-- Three objects:
--   a. guard_order_customer_id_change() + trg_guard_order_customer_id on
--      layaway_accounts and cash_orders. RETIRES THE BROWSER WRITE: until now
--      ReassignOwnerDialog did a plain PostgREST .update({customer_id}) from
--      the browser, which moved the order and left every child row, the
--      loyalty history and the audit trail behind. A signed-in user can no
--      longer change an order's customer_id at all; only a service-role caller
--      (reassign_order_owner_atomic via its edge function) or the SQL Editor
--      can, because auth.uid() is NULL there.
--   b. insert_lot_catch_up(): the catch-up twin of insert_lot_and_extend.
--   c. reassign_order_owner_atomic(): the one writer. Preview (p_apply=false)
--      writes nothing.
--
-- role_permissions is NOT touched: the reassign_owner rows already exist live
-- (admin, staff = true; finance, csr = false; 4 user overrides = false) and
-- the function obeys whatever Settings holds.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- a. Guard: only service role / SQL Editor may change an order's owner.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_order_customer_id_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id AND auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'An order''s owner can only be changed with Reassign Owner, which moves its payment submissions, requests and loyalty history with it.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_order_customer_id_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_order_customer_id ON public.layaway_accounts;
CREATE TRIGGER trg_guard_order_customer_id
  BEFORE UPDATE OF customer_id ON public.layaway_accounts
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_customer_id_change();

DROP TRIGGER IF EXISTS trg_guard_order_customer_id ON public.cash_orders;
CREATE TRIGGER trg_guard_order_customer_id
  BEFORE UPDATE OF customer_id ON public.cash_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_customer_id_change();


-- -----------------------------------------------------------------------------
-- b. insert_lot_catch_up — NEW NAME, not an overload of insert_lot_and_extend.
--
-- Based on the LIVE insert_lot_and_extend (md5 68dd571baaec085daf1c8312877b1948,
-- length 1627, captured 2026-09-24 06:44:04 UTC; the recorded body in
-- 20260917070050_record_live_loyalty_fixes.sql reproduces that md5 exactly).
-- Differences, all from R7:
--   * The lot expires order_date + 180 days, not earned_at + 180 days: the
--     purchase happened on order_date, the points just arrived late.
--   * The member's other lots are only ever EXTENDED —
--     GREATEST(expires_at, order_date + 180 days). The live function sets them
--     to earned_at + 180 days outright; a catch-up for an old order must never
--     pull a newer lot's expiry backwards. A lot with no expiry (NULL) is left
--     alone: GREATEST ignores NULLs, so without the IS NOT NULL test a lot that
--     never expires would be given a date.
--   * BORN EXPIRED. When order_date + 180 days is already past (PHT day
--     boundary), the lot is written already expired: remaining_amount 0,
--     expired_at now(). Nothing in the Hub expires lots by date (expiry is the
--     member-level inactivity sweep), so a live lot with a past expires_at
--     would stay spendable — and FIFO by soonest expiry would spend it FIRST.
--     award-loyalty-points writes the matching 'expired' ledger row and leaves
--     remaining_points unchanged, so counter = live lots = ledger net holds
--     (loyalty_integrity_report predicates 1 and 2).
--   * earned_at is now(): when the points actually landed.
-- The eligibility set of lots it extends is the live function's, unchanged.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.insert_lot_catch_up(
  p_member_id uuid,
  p_invoice text,
  p_amount integer,
  p_order_date date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lot_id uuid;
  v_expires_at timestamptz;
  v_born_expired boolean;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'lot amount must be positive: %', p_amount;
  END IF;
  IF p_order_date IS NULL THEN
    RAISE EXCEPTION 'catch-up lot needs the order date';
  END IF;

  -- PHT midnight at the start of order_date + 180 days.
  v_expires_at   := ((p_order_date + 180)::timestamp AT TIME ZONE 'Asia/Manila');
  v_born_expired := (p_order_date + 180) <= (now() AT TIME ZONE 'Asia/Manila')::date;

  INSERT INTO public.loyalty_point_lots (
    member_id, source_type, source_reference,
    original_amount, remaining_amount,
    earned_at, expires_at, expired_at, notes
  ) VALUES (
    p_member_id, 'order_earn', p_invoice,
    p_amount, CASE WHEN v_born_expired THEN 0 ELSE p_amount END,
    now(), v_expires_at, CASE WHEN v_born_expired THEN now() END,
    CASE WHEN v_born_expired
         THEN 'catch-up after reassign (born expired: order date + 180 days already past)'
         ELSE 'catch-up after reassign' END
  )
  RETURNING id INTO v_lot_id;

  -- Extend only, never shorten.
  UPDATE public.loyalty_point_lots AS lots
     SET expires_at = GREATEST(lots.expires_at, v_expires_at),
         updated_at = now()
   WHERE lots.member_id   = p_member_id
     AND lots.source_type IN ('order_earn', 'admin_adjust', 'birthday_bonus')
     AND lots.remaining_amount > 0
     AND lots.expired_at IS NULL
     AND lots.id <> v_lot_id
     AND lots.expires_at IS NOT NULL
     AND lots.expires_at < v_expires_at;

  RETURN v_lot_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.insert_lot_catch_up(uuid, text, integer, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_lot_catch_up(uuid, text, integer, date) TO service_role;


-- -----------------------------------------------------------------------------
-- c. reassign_order_owner_atomic
--
-- Returns jsonb. Two kinds of outcome:
--   { ok:false, error:<code>, message } — not_found, same_owner, invalid_*,
--     reason_required, forbidden; or, with p_apply = true, the first refusal.
--   { ok:true, applied:false|true, refusals:[…], … } — a preview (every
--     refusal listed, in check order, so the dialog can show them all) or a
--     completed move.
-- Check order: not_found → same_owner → status_closed → test_boundary →
--   R1 priority → R5 remaining refusals → loyalty_amount_required.
-- The catch-up award itself is NOT made here: the edge function calls
-- award-loyalty-points after this transaction commits (R9 — the move stands
-- even if the award fails).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reassign_order_owner_atomic(
  p_kind text,
  p_order_id uuid,
  p_new_customer_id uuid,
  p_loyalty_jpy_amount numeric,
  p_reason text,
  p_user_id uuid,
  p_apply boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- order
  v_invoice        text;
  v_old_cust       uuid;
  v_status         text;
  v_order_date     date;
  v_loyalty_stored numeric;
  v_quote_id       uuid;
  v_completed_at   timestamptz;
  v_total          numeric;
  v_source_channel text;
  v_shopify_id     text;
  v_ship_addr      uuid;
  v_ship_snap      jsonb;
  -- customers / members
  v_old            public.customers%ROWTYPE;
  v_new            public.customers%ROWTYPE;
  v_old_m          public.loyalty_members%ROWTYPE;
  v_new_m          public.loyalty_members%ROWTYPE;
  v_old_has        boolean := false;
  v_new_has        boolean := false;
  v_old_tier       text;
  v_new_tier       text;
  -- decisions
  v_refusals       jsonb := '[]'::jsonb;
  v_markers        text[] := ARRAY[]::text[];
  v_split          text;
  v_split_n        integer := 0;
  v_loyalty_eff    numeric;
  v_loyalty_change boolean := false;
  v_award_at       timestamptz;
  v_award_source   text;
  v_grace_days     integer := 3;
  v_catch_up       boolean := false;
  v_catch_reason   text;
  v_expired        boolean := false;
  v_lot_expires_on date;
  v_expected_pts   integer := 0;
  v_mult           numeric;
  v_cur_min        numeric;
  v_new_cum        numeric;
  v_new_tier_min   numeric;
  v_new_tier_mult  numeric;
  v_requalified    boolean := true;
  v_requalify_tgt  numeric;
  v_upgraded       boolean := false;
  v_loyalty_on     boolean := false;
  v_flag           text;
  -- counts
  n_submissions    integer := 0;
  n_extensions     integer := 0;
  n_service_jobs   integer := 0;
  n_service_reqs   integer := 0;
  n_quotes         integer := 0;
  n_csr            integer := 0;
  n_address        integer := 0;
  v_counts         jsonb;
  v_result         jsonb;
  v_account_type   text;
BEGIN
  -- ---- input ---------------------------------------------------------------
  IF p_kind IS NULL OR p_kind NOT IN ('layaway', 'cash') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_kind',
      'message', 'kind must be layaway or cash.');
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reason_required',
      'message', 'A written reason is required to reassign an order.');
  END IF;
  -- Service-role-only function, so the edge function's permission gate is the
  -- real one; this repeats it so a direct caller cannot skip it.
  IF p_user_id IS NULL OR NOT public.has_permission(p_user_id, 'reassign_owner') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden',
      'message', 'You do not have the Reassign Owner permission.');
  END IF;

  -- ---- the order, locked ---------------------------------------------------
  IF p_kind = 'layaway' THEN
    SELECT la.invoice_number, la.customer_id, la.status::text, la.order_date,
           la.loyalty_jpy_amount, la.quote_id, la.completed_at, la.total_amount,
           la.source_channel, NULL::text, NULL::uuid, NULL::jsonb
      INTO v_invoice, v_old_cust, v_status, v_order_date,
           v_loyalty_stored, v_quote_id, v_completed_at, v_total,
           v_source_channel, v_shopify_id, v_ship_addr, v_ship_snap
      FROM public.layaway_accounts la
     WHERE la.id = p_order_id
     FOR UPDATE;
  ELSE
    SELECT co.invoice_number, co.customer_id, co.status::text, co.order_date,
           co.loyalty_jpy_amount, co.quote_id, co.completed_at, co.total_amount,
           co.source_channel, co.shopify_order_id::text, co.ship_to_address_id, co.ship_to_snapshot
      INTO v_invoice, v_old_cust, v_status, v_order_date,
           v_loyalty_stored, v_quote_id, v_completed_at, v_total,
           v_source_channel, v_shopify_id, v_ship_addr, v_ship_snap
      FROM public.cash_orders co
     WHERE co.id = p_order_id
     FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'Order not found.');
  END IF;

  SELECT * INTO v_new FROM public.customers WHERE id = p_new_customer_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'The customer to move this order to was not found.');
  END IF;
  SELECT * INTO v_old FROM public.customers WHERE id = v_old_cust;

  IF v_old_cust = p_new_customer_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'same_owner',
      'message', 'This order already belongs to ' || v_new.full_name || '.');
  END IF;

  -- ---- loyalty accounts of both sides (R1) ---------------------------------
  SELECT * INTO v_old_m FROM public.loyalty_members WHERE customer_id = v_old_cust;
  IF FOUND THEN
    v_old_has := COALESCE(v_old_m.total_points_earned, 0) > 0
              OR COALESCE(v_old_m.cumulative_spend_jpy, 0) > 0
              OR COALESCE(v_old_m.spend_baseline_jpy, 0) > 0;
    SELECT name INTO v_old_tier FROM public.loyalty_tiers WHERE id = v_old_m.current_tier_id;
  END IF;
  SELECT * INTO v_new_m FROM public.loyalty_members WHERE customer_id = p_new_customer_id;
  IF FOUND THEN
    v_new_has := COALESCE(v_new_m.total_points_earned, 0) > 0
              OR COALESCE(v_new_m.cumulative_spend_jpy, 0) > 0
              OR COALESCE(v_new_m.spend_baseline_jpy, 0) > 0;
    SELECT name, min_spend_jpy, points_multiplier
      INTO v_new_tier, v_cur_min, v_mult
      FROM public.loyalty_tiers WHERE id = v_new_m.current_tier_id;
  END IF;

  -- ---- refusals, in check order --------------------------------------------
  IF (p_kind = 'layaway' AND v_status IN ('cancelled', 'forfeited', 'final_forfeited'))
     OR (p_kind = 'cash' AND v_status IN ('cancelled', 'expired')) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'status_closed',
      'message', 'This order is ' || replace(v_status, '_', ' ') || '. A closed order cannot change owner.');
  END IF;

  IF COALESCE(v_old.is_test, false) <> COALESCE(v_new.is_test, false) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'test_boundary',
      'message', 'One of these customers is a test customer and the other is not. An order cannot move between test and real customers.');
  END IF;

  -- R1 — FIRST loyalty check. The order never leaves a points account.
  IF v_old_has AND v_new_has THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'both_have_points',
      'message', 'Both accounts have loyalty history — contact the owner.');
  ELSIF v_old_has THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'points_account_is_current_owner',
      'message', 'This order stays with ' || v_old.full_name || ': ' || v_old.full_name || '''s account has loyalty history.');
  END IF;

  -- R5 — already earned by ANY member. Every marker counts, including an
  -- in-flight award (a claim whose transaction_id is still NULL).
  IF EXISTS (SELECT 1 FROM public.loyalty_award_claims c
              WHERE c.source_kind = p_kind AND c.source_id = p_order_id AND c.transaction_id IS NULL) THEN
    v_markers := array_append(v_markers, 'an award in progress');
  END IF;
  IF EXISTS (SELECT 1 FROM public.loyalty_award_claims c
              WHERE c.source_kind = p_kind AND c.source_id = p_order_id AND c.transaction_id IS NOT NULL) THEN
    v_markers := array_append(v_markers, 'an award claim');
  END IF;
  IF EXISTS (SELECT 1 FROM public.loyalty_transactions t
              WHERE t.transaction_type = 'earned'
                AND ((p_kind = 'layaway' AND t.account_id = p_order_id)
                  OR (p_kind = 'cash' AND t.cash_order_id = p_order_id)
                  OR t.invoice_number = v_invoice)) THEN
    v_markers := array_append(v_markers, 'an earned ledger row');
  END IF;
  IF EXISTS (SELECT 1 FROM public.loyalty_transactions t
              WHERE t.transaction_type = 'bonus' AND t.invoice_number = v_invoice) THEN
    v_markers := array_append(v_markers, 'a bonus ledger row');
  END IF;
  IF EXISTS (SELECT 1 FROM public.loyalty_point_lots l
              WHERE l.source_type IN ('order_earn', 'promo_bonus')
                AND l.source_reference = v_invoice) THEN
    v_markers := array_append(v_markers, 'a points lot');
  END IF;
  IF array_length(v_markers, 1) > 0 THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'already_earned',
      'message', 'This order has already earned loyalty points (' || array_to_string(v_markers, ', ') || '). Points cannot follow the order to another customer.');
  END IF;

  IF v_invoice ILIKE 'SH-%' OR COALESCE(v_source_channel, '') ILIKE 'shopify%' OR v_shopify_id IS NOT NULL THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'shopify_order',
      'message', 'This is a Shopify order. Its owner comes from Shopify and cannot be changed here.');
  END IF;

  -- A split payment submission covering more than one order cannot be moved:
  -- one half would follow the order and the other would stay behind.
  WITH subs AS (
    SELECT ps.id, ps.account_id, ps.cash_order_id
      FROM public.payment_submissions ps
     WHERE (p_kind = 'layaway' AND (ps.account_id = p_order_id
              OR ps.id IN (SELECT a.submission_id FROM public.payment_submission_allocations a WHERE a.account_id = p_order_id)))
        OR (p_kind = 'cash' AND ps.cash_order_id = p_order_id)
  ), orders AS (
    -- UNION (not UNION ALL) — one row per (submission, order) pair.
    SELECT s.id AS sid, s.account_id AS la_id, NULL::uuid AS co_id FROM subs s WHERE s.account_id IS NOT NULL
    UNION SELECT s.id, NULL::uuid, s.cash_order_id FROM subs s WHERE s.cash_order_id IS NOT NULL
    UNION SELECT a.submission_id, a.account_id, NULL::uuid
            FROM public.payment_submission_allocations a JOIN subs s ON s.id = a.submission_id
  ), wide AS (
    SELECT sid FROM orders GROUP BY sid HAVING count(*) > 1
  )
  SELECT count(*), string_agg(DISTINCT COALESCE(la.invoice_number, co.invoice_number), ', ')
    INTO v_split_n, v_split
    FROM orders o
    JOIN wide w ON w.sid = o.sid
    LEFT JOIN public.layaway_accounts la ON la.id = o.la_id
    LEFT JOIN public.cash_orders co ON co.id = o.co_id
   WHERE NOT ((p_kind = 'layaway' AND o.la_id IS NOT DISTINCT FROM p_order_id)
           OR (p_kind = 'cash' AND o.co_id IS NOT DISTINCT FROM p_order_id));
  IF v_split_n > 0 THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'split_submission',
      'message', 'A payment submission for this order also pays ' || COALESCE('invoice ' || v_split, 'another order')
        || '. A split payment cannot be divided between two customers.');
  END IF;

  IF EXISTS (SELECT 1 FROM public.loyalty_redemptions r
              WHERE r.status <> 'cancelled'
                AND ((p_kind = 'layaway' AND r.account_id = p_order_id)
                  OR (p_kind = 'cash' AND r.cash_order_id = p_order_id)
                  OR r.invoice_number = v_invoice)) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'loyalty_redemption',
      'message', 'A loyalty redemption is attached to this order. It belongs to the account that redeemed the points.');
  END IF;

  IF EXISTS (SELECT 1 FROM public.store_credit_transactions x
              WHERE (p_kind = 'layaway' AND x.account_id = p_order_id)
                 OR (p_kind = 'cash' AND x.cash_order_id = p_order_id))
     OR EXISTS (SELECT 1 FROM public.store_credit_lots l
              WHERE (p_kind = 'layaway' AND l.source_account_id = p_order_id)
                 OR (p_kind = 'cash' AND l.source_cash_order_id = p_order_id)) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'store_credit',
      'message', 'Store credit was applied to or issued from this order. Store credit belongs to one customer and cannot move with the order.');
  END IF;

  -- R4 — the loyalty amount must be set (> 0) for every reassign.
  v_loyalty_eff := COALESCE(p_loyalty_jpy_amount, v_loyalty_stored);
  v_loyalty_change := p_loyalty_jpy_amount IS NOT NULL
                  AND p_loyalty_jpy_amount IS DISTINCT FROM v_loyalty_stored;
  IF v_loyalty_eff IS NULL OR v_loyalty_eff <= 0 THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'loyalty_amount_required',
      'message', 'Set the loyalty product amount (product only — no shipping or service fees) before reassigning.');
  ELSIF v_loyalty_change AND NOT public.has_permission(p_user_id, 'edit_loyalty_amount') THEN
    -- R3. trg_guard_loyalty_jpy_amount does not fire for a service-role
    -- caller, so the permission is checked here.
    v_refusals := v_refusals || jsonb_build_object('code', 'loyalty_permission_required',
      'message', 'Changing the loyalty amount needs the Edit Loyalty Amount permission.');
  END IF;

  -- ---- award point (R6) ----------------------------------------------------
  IF p_kind = 'layaway' THEN
    SELECT min(p.created_at) INTO v_award_at
      FROM public.payments p
     WHERE p.account_id = p_order_id
       AND p.voided_at IS NULL
       AND (p.reference_number LIKE 'DP-%' OR p.remarks ILIKE '%down%')
       AND COALESCE(p.reference_number, '') NOT LIKE 'LOYALTY-%';
    IF v_award_at IS NOT NULL THEN
      v_award_source := 'downpayment_payment';
    ELSE
      SELECT min(ps.updated_at) INTO v_award_at
        FROM public.payment_submissions ps
       WHERE ps.account_id = p_order_id
         AND ps.status = 'confirmed'
         AND ps.submission_type = 'downpayment';
      IF v_award_at IS NOT NULL THEN v_award_source := 'downpayment_submission'; END IF;
    END IF;
  ELSIF v_status = 'completed' THEN
    v_award_at := v_completed_at;
    IF v_award_at IS NOT NULL THEN
      v_award_source := 'completed_at';
    ELSE
      SELECT x.created_at INTO v_award_at FROM (
        SELECT cp.created_at,
               sum(cp.amount_paid) OVER (ORDER BY cp.created_at, cp.id) AS running
          FROM public.cash_payments cp
         WHERE cp.cash_order_id = p_order_id AND cp.voided_at IS NULL
      ) x WHERE x.running >= v_total ORDER BY x.created_at LIMIT 1;
      IF v_award_at IS NOT NULL THEN v_award_source := 'fully_paid_payment'; END IF;
    END IF;
  END IF;

  SELECT (value #>> '{}') INTO v_flag FROM public.system_settings WHERE key = 'loyalty_enrollment_grace_days';
  IF v_flag ~ '^[0-9]+$' THEN v_grace_days := v_flag::integer; END IF;
  SELECT (value #>> '{}') INTO v_flag FROM public.system_settings WHERE key = 'loyalty_enabled';
  v_loyalty_on := lower(COALESCE(v_flag, '')) = 'true';

  -- ---- catch-up decision (R6/R7) -------------------------------------------
  v_lot_expires_on := v_order_date + 180;
  IF v_new_m.id IS NULL THEN
    v_catch_reason := 'not_enrolled';
  ELSIF v_award_at IS NULL THEN
    v_catch_reason := 'not_at_award_point';
  ELSIF v_award_at < v_new_m.enrolled_at - make_interval(days => v_grace_days) THEN
    v_catch_reason := 'paid_before_enrollment';
  ELSE
    v_catch_up := true;
    v_catch_reason := 'eligible';
    v_expired := v_lot_expires_on <= (now() AT TIME ZONE 'Asia/Manila')::date;
  END IF;

  -- Expected points — the award function's own arithmetic: current tier, with
  -- the ratchet to the post-purchase tier (and the requalify gate), no promo.
  IF v_catch_up AND COALESCE(v_loyalty_eff, 0) >= 10000 THEN
    v_new_cum := COALESCE(v_new_m.cumulative_spend_jpy, 0) + v_loyalty_eff;
    SELECT min_spend_jpy, points_multiplier INTO v_new_tier_min, v_new_tier_mult
      FROM public.loyalty_tiers WHERE min_spend_jpy <= v_new_cum
     ORDER BY min_spend_jpy DESC LIMIT 1;
    IF v_new_m.is_downgraded AND v_new_m.downgrade_spend_baseline IS NOT NULL AND v_new_m.earned_tier_id IS NOT NULL THEN
      SELECT requalify_spend_jpy INTO v_requalify_tgt FROM public.loyalty_tiers WHERE id = v_new_m.earned_tier_id;
      IF v_requalify_tgt IS NOT NULL THEN
        v_requalified := (v_new_cum - v_new_m.downgrade_spend_baseline) >= v_requalify_tgt;
      END IF;
    END IF;
    v_upgraded := v_requalified AND v_new_tier_min IS NOT NULL AND v_new_tier_min > COALESCE(v_cur_min, 0);
    v_expected_pts := (floor(v_loyalty_eff / 10000) * 100
                       * CASE WHEN v_upgraded THEN COALESCE(v_new_tier_mult, 1) ELSE COALESCE(v_mult, 1) END)::integer;
  END IF;

  -- ---- child rows that move with the order ---------------------------------
  v_account_type := CASE WHEN p_kind = 'layaway' THEN 'layaway' ELSE 'cash_order' END;
  SELECT count(*) INTO n_submissions FROM public.payment_submissions ps
   WHERE (p_kind = 'layaway' AND (ps.account_id = p_order_id
            OR ps.id IN (SELECT a.submission_id FROM public.payment_submission_allocations a WHERE a.account_id = p_order_id)))
      OR (p_kind = 'cash' AND ps.cash_order_id = p_order_id);
  IF p_kind = 'layaway' THEN
    SELECT count(*) INTO n_extensions FROM public.extension_requests WHERE account_id = p_order_id;
    SELECT count(*) INTO n_csr FROM public.csr_notifications WHERE account_id = p_order_id;
  END IF;
  SELECT count(*) INTO n_service_jobs FROM public.service_jobs
   WHERE invoice_number = v_invoice AND account_type = v_account_type;
  SELECT count(*) INTO n_service_reqs FROM public.service_requests
   WHERE (p_kind = 'layaway' AND layaway_account_id = p_order_id)
      OR (p_kind = 'cash' AND cash_order_id = p_order_id);
  IF v_quote_id IS NOT NULL THEN
    SELECT count(*) INTO n_quotes FROM public.checkout_quotes WHERE id = v_quote_id;
  END IF;
  IF v_ship_addr IS NOT NULL THEN n_address := 1; END IF;

  v_counts := jsonb_build_object(
    'payment_submissions', n_submissions, 'extension_requests', n_extensions,
    'service_jobs', n_service_jobs, 'service_requests', n_service_reqs,
    'checkout_quotes', n_quotes, 'csr_notifications', n_csr,
    'ship_to_address_detached', n_address);

  v_result := jsonb_build_object(
    'ok', true,
    'applied', false,
    'kind', p_kind,
    'order_id', p_order_id,
    'invoice_number', v_invoice,
    'status', v_status,
    'order_date', v_order_date,
    'current', jsonb_build_object(
      'customer_id', v_old_cust, 'full_name', v_old.full_name, 'is_test', COALESCE(v_old.is_test, false),
      'enrolled', v_old_m.id IS NOT NULL, 'tier', v_old_tier,
      'points', COALESCE(v_old_m.remaining_points, 0), 'points_earned', COALESCE(v_old_m.total_points_earned, 0),
      'spend_jpy', COALESCE(v_old_m.cumulative_spend_jpy, 0), 'has_points', v_old_has),
    'target', jsonb_build_object(
      'customer_id', p_new_customer_id, 'full_name', v_new.full_name, 'is_test', COALESCE(v_new.is_test, false),
      'enrolled', v_new_m.id IS NOT NULL, 'enrolled_at', v_new_m.enrolled_at, 'tier', v_new_tier,
      'points', COALESCE(v_new_m.remaining_points, 0), 'points_earned', COALESCE(v_new_m.total_points_earned, 0),
      'spend_jpy', COALESCE(v_new_m.cumulative_spend_jpy, 0), 'has_points', v_new_has),
    'refusals', v_refusals,
    'can_apply', jsonb_array_length(v_refusals) = 0,
    'loyalty_jpy_amount', jsonb_build_object(
      'stored', v_loyalty_stored, 'proposed', p_loyalty_jpy_amount, 'effective', v_loyalty_eff,
      'changes', v_loyalty_change),
    'award_point', jsonb_build_object('at', v_award_at, 'source', v_award_source),
    'catch_up', jsonb_build_object(
      'eligible', v_catch_up, 'reason', v_catch_reason, 'grace_days', v_grace_days,
      'expected_points', v_expected_pts, 'below_minimum', v_catch_up AND COALESCE(v_loyalty_eff, 0) < 10000,
      'expired_on_award', v_expired, 'lot_expires_on', v_lot_expires_on,
      'loyalty_enabled', v_loyalty_on),
    'child_rows', v_counts);

  IF NOT COALESCE(p_apply, false) THEN
    RETURN v_result;
  END IF;

  IF jsonb_array_length(v_refusals) > 0 THEN
    RETURN v_result || jsonb_build_object('ok', false,
      'error', v_refusals -> 0 ->> 'code', 'message', v_refusals -> 0 ->> 'message');
  END IF;

  -- ---- apply ---------------------------------------------------------------
  IF v_loyalty_change THEN
    IF p_kind = 'layaway' THEN
      UPDATE public.layaway_accounts SET loyalty_jpy_amount = p_loyalty_jpy_amount WHERE id = p_order_id;
    ELSE
      UPDATE public.cash_orders SET loyalty_jpy_amount = p_loyalty_jpy_amount WHERE id = p_order_id;
    END IF;
  END IF;

  IF p_kind = 'layaway' THEN
    UPDATE public.layaway_accounts SET customer_id = p_new_customer_id WHERE id = p_order_id;
  ELSE
    -- The saved address belongs to the old owner's address book. Keep what
    -- the order shipped to as its snapshot, then drop the link.
    UPDATE public.cash_orders
       SET customer_id = p_new_customer_id,
           ship_to_snapshot = CASE WHEN ship_to_address_id IS NOT NULL AND ship_to_snapshot IS NULL
                                   THEN public.address_snapshot(ship_to_address_id)
                                   ELSE ship_to_snapshot END,
           ship_to_address_id = NULL
     WHERE id = p_order_id;
  END IF;

  UPDATE public.payment_submissions ps
     SET customer_id = p_new_customer_id, portal_token = NULL
   WHERE (p_kind = 'layaway' AND (ps.account_id = p_order_id
            OR ps.id IN (SELECT a.submission_id FROM public.payment_submission_allocations a WHERE a.account_id = p_order_id)))
      OR (p_kind = 'cash' AND ps.cash_order_id = p_order_id);
  GET DIAGNOSTICS n_submissions = ROW_COUNT;

  IF p_kind = 'layaway' THEN
    UPDATE public.extension_requests
       SET customer_id = p_new_customer_id, portal_token = NULL
     WHERE account_id = p_order_id;
    GET DIAGNOSTICS n_extensions = ROW_COUNT;
    UPDATE public.csr_notifications SET customer_id = p_new_customer_id WHERE account_id = p_order_id;
    GET DIAGNOSTICS n_csr = ROW_COUNT;
  END IF;

  UPDATE public.service_jobs SET customer_id = p_new_customer_id
   WHERE invoice_number = v_invoice AND account_type = v_account_type;
  GET DIAGNOSTICS n_service_jobs = ROW_COUNT;

  UPDATE public.service_requests SET customer_id = p_new_customer_id
   WHERE (p_kind = 'layaway' AND layaway_account_id = p_order_id)
      OR (p_kind = 'cash' AND cash_order_id = p_order_id);
  GET DIAGNOSTICS n_service_reqs = ROW_COUNT;

  IF v_quote_id IS NOT NULL THEN
    UPDATE public.checkout_quotes SET customer_id = p_new_customer_id WHERE id = v_quote_id;
    GET DIAGNOSTICS n_quotes = ROW_COUNT;
  END IF;

  v_counts := jsonb_build_object(
    'payment_submissions', n_submissions, 'extension_requests', n_extensions,
    'service_jobs', n_service_jobs, 'service_requests', n_service_reqs,
    'checkout_quotes', n_quotes, 'csr_notifications', n_csr,
    'ship_to_address_detached', n_address);

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES (
    CASE WHEN p_kind = 'layaway' THEN 'layaway_account' ELSE 'cash_order' END,
    p_order_id,
    'reassign_owner',
    jsonb_build_object(
      'customer_id', v_old_cust, 'customer_name', v_old.full_name,
      'loyalty_jpy_amount', v_loyalty_stored),
    jsonb_build_object(
      'customer_id', p_new_customer_id, 'customer_name', v_new.full_name,
      'loyalty_jpy_amount', v_loyalty_eff,
      'reason', btrim(p_reason),
      'invoice_number', v_invoice,
      'moved', v_counts,
      'award_point', v_award_at, 'award_point_source', v_award_source,
      'catch_up', v_catch_up, 'catch_up_reason', v_catch_reason,
      'catch_up_expected_points', v_expected_pts, 'catch_up_expired_on_award', v_expired),
    p_user_id);

  RETURN v_result || jsonb_build_object('applied', true, 'child_rows', v_counts,
    'loyalty_jpy_amount', (v_result -> 'loyalty_jpy_amount') || jsonb_build_object('stored', v_loyalty_eff));
END;
$function$;

REVOKE ALL ON FUNCTION public.reassign_order_owner_atomic(text, uuid, uuid, numeric, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reassign_order_owner_atomic(text, uuid, uuid, numeric, text, uuid, boolean) TO service_role;
