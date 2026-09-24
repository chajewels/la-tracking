-- =============================================================================
-- REASSIGN OWNER — R11 IDENTITY MATCH + wrong-customer override
-- (owner-confirmed 2026-09-24; builds on 20260924130000_reassign_order_owner).
--
-- NOT APPLIED BY ANY TOOLING. The owner runs this file in the SQL Editor.
-- The currently deployed reassign-order-owner keeps working against it (it
-- makes a 7-argument NAMED call; the new last parameter defaults to false, so
-- R11 is simply enforced strictly until the new edge function is deployed).
--
-- R11: a reassign is allowed only if the target account matches the CURRENT
-- owner on at least one of full name, Facebook name, mobile or email — the
-- same normalisation as find_customer_matches. No match → refusal
-- different_customer_details. A holder of reassign_owner_unmatched may move
-- such an order by explicitly choosing the override (p_allow_unmatched); that
-- bypasses R11 ONLY and is logged (audit: unmatched, override_used).
--
-- LIVE BEFORE THIS FILE (owner capture 2026-09-24 12:27 UTC):
--   reassign_order_owner_atomic(text, uuid, uuid, numeric, text, uuid, boolean)
--     md5(pg_get_functiondef) d51393e67cc1f208457964a637bc3ca8, length 23658
--   find_customer_matches(text, text, text, text, uuid)
--     md5(pg_get_functiondef) e7f259b57c2a8d2f161c7189a19f4a3e, length 2852
--     — UNTOUCHED by this file; R11 repeats its normalisation inline.
-- The body below was produced by applying ONLY the R11 edits to the body
-- recorded in 20260924130000, which renders exactly the live md5 above on a
-- clean Postgres 17.6 (Supabase image) replay of every migration. The guard
-- below refuses to run if live has moved since.
--
-- Three parts:
--   a. role_permissions seed for reassign_owner_unmatched — admin only —
--      ON CONFLICT DO NOTHING, so a value already set in Settings is kept.
--   b. DROP the 7-argument function, CREATE the 8-argument one (drop-then-
--      create, so there is never a second overload for a named call to be
--      ambiguous between). Same SECURITY DEFINER, search_path and grants.
--   c. A post-check that the old signature is gone and the new one is there.
-- =============================================================================

DO $guard$
DECLARE
  v_md5 text;
  v_len integer;
  v_bad text := '';
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)), length(pg_get_functiondef(p.oid))
    INTO v_md5, v_len
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reassign_order_owner_atomic'
     AND pg_get_function_identity_arguments(p.oid) =
         'p_kind text, p_order_id uuid, p_new_customer_id uuid, p_loyalty_jpy_amount numeric, p_reason text, p_user_id uuid, p_apply boolean';
  IF v_md5 IS DISTINCT FROM 'd51393e67cc1f208457964a637bc3ca8' THEN
    v_bad := v_bad || format(E'\n  reassign_order_owner_atomic: live md5 %s (length %s), expected d51393e67cc1f208457964a637bc3ca8 (23658)',
                             COALESCE(v_md5, 'missing'), COALESCE(v_len::text, '-'));
  END IF;

  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'find_customer_matches';
  IF v_md5 IS DISTINCT FROM 'e7f259b57c2a8d2f161c7189a19f4a3e' THEN
    v_bad := v_bad || format(E'\n  find_customer_matches: live md5 %s, expected e7f259b57c2a8d2f161c7189a19f4a3e — R11 copies its normalisation',
                             COALESCE(v_md5, 'missing'));
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION E'STOP — live is not the state this migration was written against. Nothing was modified.%', v_bad;
  END IF;
END
$guard$;


-- -----------------------------------------------------------------------------
-- a. Permission: reassign_owner_unmatched — admin only. DO NOTHING on
--    conflict: a row the owner has already set in Settings is never
--    overwritten.
-- -----------------------------------------------------------------------------
INSERT INTO public.role_permissions (role, permission_key, is_allowed) VALUES
  ('admin'::app_role,      'reassign_owner_unmatched', true),
  ('staff'::app_role,      'reassign_owner_unmatched', false),
  ('finance'::app_role,    'reassign_owner_unmatched', false),
  ('csr'::app_role,        'reassign_owner_unmatched', false),
  ('live_agent'::app_role, 'reassign_owner_unmatched', false)
ON CONFLICT (role, permission_key) DO NOTHING;


-- -----------------------------------------------------------------------------
-- b. reassign_order_owner_atomic — R11 added. Everything else is the recorded
--    body byte-for-byte.
--
-- Returns jsonb. Two kinds of outcome:
--   { ok:false, error:<code>, message } — not_found, same_owner, invalid_*,
--     reason_required, forbidden; or, with p_apply = true, the first refusal.
--   { ok:true, applied:false|true, refusals:[…], … } — a preview (every
--     refusal listed, in check order, so the dialog can show them all) or a
--     completed move. Both now carry matched_on (text[]) and unmatched.
-- Check order: not_found → same_owner → status_closed → test_boundary →
--   R1 priority → R5 remaining refusals → R11 different_customer_details →
--   loyalty_amount_required.
-- The catch-up award itself is NOT made here: the edge function calls
-- award-loyalty-points after this transaction commits (R9 — the move stands
-- even if the award fails).
-- -----------------------------------------------------------------------------
DROP FUNCTION public.reassign_order_owner_atomic(text, uuid, uuid, numeric, text, uuid, boolean);

CREATE FUNCTION public.reassign_order_owner_atomic(
  p_kind text,
  p_order_id uuid,
  p_new_customer_id uuid,
  p_loyalty_jpy_amount numeric,
  p_reason text,
  p_user_id uuid,
  p_apply boolean,
  p_allow_unmatched boolean DEFAULT false)
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
  -- identity match (R11)
  v_matched_on     text[] := ARRAY[]::text[];
  v_unmatched      boolean := false;
  v_override_ok    boolean := false;
  v_override_used  boolean := false;
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

  -- R11 — IDENTITY MATCH. The target must be another account of the SAME
  -- customer: at least one of full name, Facebook name, mobile or email
  -- matches the CURRENT owner, normalised exactly as find_customer_matches
  -- does (names: lower-case, trim, collapse spaces; mobile: last 10 digits,
  -- only when both sides have >= 10; email: trimmed, case-insensitive). An
  -- empty field never matches — the left side is NULLed when empty.
  v_matched_on := array_remove(ARRAY[
    CASE WHEN nullif(lower(regexp_replace(btrim(coalesce(v_old.full_name, '')), '\s+', ' ', 'g')), '')
            = lower(regexp_replace(btrim(coalesce(v_new.full_name, '')), '\s+', ' ', 'g'))
         THEN 'full_name' END,
    CASE WHEN nullif(lower(regexp_replace(btrim(coalesce(v_old.facebook_name, '')), '\s+', ' ', 'g')), '')
            = lower(regexp_replace(btrim(coalesce(v_new.facebook_name, '')), '\s+', ' ', 'g'))
         THEN 'facebook_name' END,
    CASE WHEN length(regexp_replace(coalesce(v_old.mobile_number, ''), '\D', '', 'g')) >= 10
          AND length(regexp_replace(coalesce(v_new.mobile_number, ''), '\D', '', 'g')) >= 10
          AND right(regexp_replace(v_old.mobile_number, '\D', '', 'g'), 10)
            = right(regexp_replace(v_new.mobile_number, '\D', '', 'g'), 10)
         THEN 'mobile' END,
    CASE WHEN nullif(lower(btrim(coalesce(v_old.email, ''))), '')
            = lower(btrim(coalesce(v_new.email, '')))
         THEN 'email' END
  ], NULL);
  v_unmatched := cardinality(v_matched_on) = 0;
  -- The override is honoured only for a holder of reassign_owner_unmatched;
  -- the edge function checks it too, this repeats it so a direct caller
  -- cannot skip it. It bypasses R11 ONLY — every other refusal still stands.
  v_override_ok := COALESCE(p_allow_unmatched, false)
               AND public.has_permission(p_user_id, 'reassign_owner_unmatched');
  IF v_unmatched THEN
    IF v_override_ok THEN
      v_override_used := true;
    ELSE
      v_refusals := v_refusals || jsonb_build_object('code', 'different_customer_details',
        'message', 'Different customer details — this order can only move to another account of the same customer. Contact the owner.');
    END IF;
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
    'matched_on', to_jsonb(v_matched_on),
    'unmatched', v_unmatched,
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
      'catch_up_expected_points', v_expected_pts, 'catch_up_expired_on_award', v_expired,
      'matched_on', to_jsonb(v_matched_on), 'unmatched', v_unmatched,
      'override_used', v_override_used),
    p_user_id);

  RETURN v_result || jsonb_build_object('applied', true, 'child_rows', v_counts,
    'loyalty_jpy_amount', (v_result -> 'loyalty_jpy_amount') || jsonb_build_object('stored', v_loyalty_eff));
END;
$function$;


REVOKE ALL ON FUNCTION public.reassign_order_owner_atomic(text, uuid, uuid, numeric, text, uuid, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reassign_order_owner_atomic(text, uuid, uuid, numeric, text, uuid, boolean, boolean) TO service_role;


-- -----------------------------------------------------------------------------
-- c. Post-check: exactly one reassign_order_owner_atomic, the 8-argument one.
-- -----------------------------------------------------------------------------
DO $post$
DECLARE
  v_n    integer;
  v_args text;
BEGIN
  SELECT count(*), min(pg_get_function_identity_arguments(p.oid)) INTO v_n, v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reassign_order_owner_atomic';
  IF v_n <> 1 OR v_args NOT LIKE '%p_allow_unmatched boolean' THEN
    RAISE EXCEPTION 'STOP — expected one 8-argument reassign_order_owner_atomic, found % (%). Rolled back.', v_n, v_args;
  END IF;
END
$post$;
