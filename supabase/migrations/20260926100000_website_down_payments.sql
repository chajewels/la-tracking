-- ============================================================================
-- DOWN PAYMENTS FOR THE STOREFRONT CATALOG (H-DP, 2026-09-25, owner-approved
-- plan: down-payment-calculator-investigation.md, decisions D1-D4).
--
-- Owner rules: every money figure a customer sees comes from the Hub, the
-- storefront never computes or converts, and the 30% down payment rounds
-- HALF UP to a whole unit in yen and in pesos. ONE formula, identical to the
-- checkout:
--   price_php        = HU(price_jpy * rate)
--   down_payment_jpy = layaway_quote(price_jpy, term, 'JPY').deposit
--   down_payment_php = layaway_quote(price_php, term, 'PHP').deposit
--
-- This file adds ONE new, read-only function, website_down_payments. It does
-- not compute a deposit itself: it calls layaway_quote, the same function
-- create_web_layaway_atomic calls, so the "reserve with" figures cannot drift
-- from what a plan would store. For a single piece with no shipping (owner
-- decision D1: the displayed figures are for the piece alone), the peso
-- figure IS what create_web_layaway_atomic stores: it converts first,
-- round(total_jpy * fx_rate), then calls layaway_quote in PHP.
--
-- Term: the SHORTEST active term (3M, no minimum), which layaway_quote applies
-- to any price. Its dp_percentage is returned beside the figures.
--
-- NOTHING EXISTING IS ALTERED. No table, column, trigger or existing function
-- changes. layaway_quote and create_web_layaway_atomic are only read.
--
-- GUARDS (CLAUDE.md "FUNCTION CHANGES START FROM LIVE", Bug #280). The claim
-- "equal to checkout" depends on two live bodies, so section 0 refuses to run
-- unless live still carries exactly the bodies this was built and tested
-- against (md5 = scripts/function-drift-audit's comparator: md5 of prosrc,
-- whitespace collapsed and trimmed):
--   layaway_quote               85bc273c37ce6dfe47ceeeda16891947  (20260914130109)
--   create_web_layaway_atomic   44aa89cfbcbd6a155b0db63a1d879f5c  (20260923140000)
--   website_down_payments       absent, or already this file's body:
--                               4403ea1cd803fb9bb9fd3c94ee6e095f
-- Re-running this file is safe: section 0 accepts the function when it
-- already carries this body, and CREATE OR REPLACE rewrites it unchanged.
-- Section 3 refuses to COMMIT unless the new body md5-matches, EXECUTE is
-- held by service_role only, and the function agrees with direct
-- layaway_quote calls (including exact .5 edge cases).
--
-- Callers: the `website` edge function only (service role), one call per
-- catalog request. Grants: service_role only.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Live must be the state this file was written against.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  v_n   integer;
  v_md5 text;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'layaway_quote';
  IF v_n <> 1 OR to_regprocedure('public.layaway_quote(integer,integer,text,date,integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'STOP: expected exactly one public.layaway_quote(integer,integer,text,date,integer,integer), found % overload(s). Nothing was changed.', v_n;
  END IF;
  SELECT md5(btrim(regexp_replace(prosrc, '\s+', ' ', 'g'))) INTO v_md5
    FROM pg_proc WHERE oid = 'public.layaway_quote(integer,integer,text,date,integer,integer)'::regprocedure;
  IF v_md5 <> '85bc273c37ce6dfe47ceeeda16891947' THEN
    RAISE EXCEPTION 'STOP: live layaway_quote body md5 is %, expected 85bc273c37ce6dfe47ceeeda16891947 (20260914130109). Live has drifted from the repo; run scripts/function-drift-audit and report. Nothing was changed.', v_md5;
  END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_web_layaway_atomic';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'STOP: expected exactly one public.create_web_layaway_atomic, found %. Nothing was changed.', v_n;
  END IF;
  SELECT md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) INTO v_md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_web_layaway_atomic';
  IF v_md5 <> '44aa89cfbcbd6a155b0db63a1d879f5c' THEN
    RAISE EXCEPTION 'STOP: live create_web_layaway_atomic body md5 is %, expected 44aa89cfbcbd6a155b0db63a1d879f5c (20260923140000). Live has drifted from the repo; run scripts/function-drift-audit and report. Nothing was changed.', v_md5;
  END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'website_down_payments';
  IF v_n > 0 THEN
    IF v_n > 1 OR to_regprocedure('public.website_down_payments(integer[],numeric)') IS NULL THEN
      RAISE EXCEPTION 'STOP: public.website_down_payments exists with a different signature (% overload(s)). Nothing was changed.', v_n;
    END IF;
    SELECT md5(btrim(regexp_replace(prosrc, '\s+', ' ', 'g'))) INTO v_md5
      FROM pg_proc WHERE oid = 'public.website_down_payments(integer[],numeric)'::regprocedure;
    IF v_md5 <> '4403ea1cd803fb9bb9fd3c94ee6e095f' THEN
      RAISE EXCEPTION 'STOP: public.website_down_payments already exists with a different body (md5 %). Nothing was changed.', v_md5;
    END IF;
    RAISE NOTICE 'website_down_payments already carries this body - re-applying it unchanged.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM plan_configurations WHERE is_active) THEN
    RAISE EXCEPTION 'STOP: plan_configurations has no active term. Nothing was changed.';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- 1. The function.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.website_down_payments(p_prices_jpy integer[], p_rate numeric)
RETURNS TABLE (price_jpy integer, down_payment_jpy integer, down_payment_php integer, down_payment_pct numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
  -- One row per DISTINCT non-negative yen price. p_rate is fx_rates.jpy_php
  -- (PHP per 1 JPY, numeric(12,6)); round(p_rate, 6) is the identity on a
  -- real rate and absorbs any float noise from the caller, the same way the
  -- edge's jpyToPhpHalfUp reads the rate as whole millionths.
  WITH t AS (
    SELECT min(pc.plan_months) AS months FROM plan_configurations pc WHERE pc.is_active
  ), p AS (
    SELECT DISTINCT x AS jpy FROM unnest(p_prices_jpy) AS x WHERE x IS NOT NULL AND x >= 0
  ), q AS (
    SELECT p.jpy,
           public.layaway_quote(p.jpy, t.months, 'JPY') AS qj,
           CASE WHEN p_rate IS NOT NULL AND p_rate > 0
                -- Convert FIRST, half-up to a whole peso (integer * numeric is
                -- exact; round(numeric) rounds ties away from zero), exactly as
                -- create_web_layaway_atomic does; layaway_quote then applies the
                -- percentage, half-up.
                THEN public.layaway_quote(round(p.jpy * round(p_rate, 6))::integer, t.months, 'PHP') END AS qp
      FROM p CROSS JOIN t
     WHERE t.months IS NOT NULL
  )
  SELECT q.jpy,
         CASE WHEN (q.qj->>'eligible')::boolean THEN (q.qj->>'deposit')::integer END,
         CASE WHEN (q.qp->>'eligible')::boolean THEN (q.qp->>'deposit')::integer END,
         CASE WHEN (q.qj->>'eligible')::boolean THEN (
           SELECT (e->>'dp_percentage')::numeric
             FROM jsonb_array_elements(q.qj->'allowed_terms') e
            WHERE (e->>'months')::integer = (q.qj->>'term_months')::integer
         ) END
    FROM q;
$function$;

COMMENT ON FUNCTION public.website_down_payments(integer[], numeric) IS
  'Storefront catalog down payments (H-DP, 2026-09-25). Per distinct yen price: layaway_quote(price_jpy, shortest active term, JPY).deposit and layaway_quote(round(price_jpy * p_rate), same term, PHP).deposit - convert first, then dp_percentage, both half-up, exactly as create_web_layaway_atomic stores a peso plan with no shipping. p_rate is fx_rates.jpy_php (PHP per 1 JPY). A figure is NULL when it cannot be computed (no rate, or not eligible). Read-only; called by the website edge function with the service role.';

-- ---------------------------------------------------------------------------
-- 2. Grants: service_role only (re-asserted; CREATE grants PUBLIC by default).
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.website_down_payments(integer[], numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.website_down_payments(integer[], numeric) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.website_down_payments(integer[], numeric) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Refuse to COMMIT unless the result is exactly what was intended.
-- ---------------------------------------------------------------------------
DO $check$
DECLARE
  v_md5    text;
  v_months integer;
  v_dp     numeric;
  r        record;
  v_rows   integer;
BEGIN
  SELECT md5(btrim(regexp_replace(prosrc, '\s+', ' ', 'g'))) INTO v_md5
    FROM pg_proc WHERE oid = 'public.website_down_payments(integer[],numeric)'::regprocedure;
  IF v_md5 <> '4403ea1cd803fb9bb9fd3c94ee6e095f' THEN
    RAISE EXCEPTION 'ROLLBACK: website_down_payments body md5 is %, expected 4403ea1cd803fb9bb9fd3c94ee6e095f', v_md5;
  END IF;

  IF has_function_privilege('anon', 'public.website_down_payments(integer[],numeric)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.website_down_payments(integer[],numeric)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.website_down_payments(integer[],numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ROLLBACK: EXECUTE on website_down_payments must be service_role only';
  END IF;

  SELECT min(plan_months) INTO v_months FROM plan_configurations WHERE is_active;
  SELECT dp_percentage INTO v_dp FROM plan_configurations WHERE is_active AND plan_months = v_months;

  -- Wiring: every row agrees with direct layaway_quote calls. The prices
  -- include exact .5 cases on both steps: ¥12,345 (yen deposit 3,703.5);
  -- ¥100,000 at 0.308345 (₱30,834.5, then ₱9,250.5); ¥75,000 at 0.4337
  -- (₱32,527.5).
  FOR r IN
    SELECT d.*, x.rate
      FROM (VALUES (0.397296::numeric), (0.308345), (0.4337)) AS x(rate)
      CROSS JOIN LATERAL public.website_down_payments(ARRAY[12345, 100000, 75000, 72980, 679980, 0], x.rate) d
  LOOP
    IF r.down_payment_jpy IS DISTINCT FROM (public.layaway_quote(r.price_jpy, v_months, 'JPY')->>'deposit')::integer
       OR r.down_payment_php IS DISTINCT FROM (public.layaway_quote(round(r.price_jpy * r.rate)::integer, v_months, 'PHP')->>'deposit')::integer
       OR r.down_payment_pct IS DISTINCT FROM v_dp THEN
      RAISE EXCEPTION 'ROLLBACK: website_down_payments disagrees with layaway_quote at rate %: %', r.rate, row_to_json(r);
    END IF;
  END LOOP;

  -- Duplicates collapse, NULL and negative prices are dropped, no rate means
  -- no peso figure.
  SELECT count(*) INTO v_rows FROM public.website_down_payments(ARRAY[12345, 12345, NULL, -1], NULL);
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK: expected 1 row for [12345, 12345, NULL, -1], got %', v_rows;
  END IF;
  SELECT * INTO r FROM public.website_down_payments(ARRAY[12345], NULL);
  IF r.down_payment_php IS NOT NULL OR r.down_payment_jpy IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK: with no rate the peso figure must be NULL and the yen one present: %', row_to_json(r);
  END IF;

  -- The owner's figures, when the shortest term's percentage is 30%.
  IF v_dp = 0.30 THEN
    SELECT * INTO r FROM public.website_down_payments(ARRAY[12345], 0.397296);
    IF r.down_payment_jpy <> 3704 OR r.down_payment_php <> 1472 THEN
      RAISE EXCEPTION 'ROLLBACK: expected ¥3,704 / ₱1,472 for ¥12,345 at 0.397296, got %', row_to_json(r);
    END IF;
    SELECT * INTO r FROM public.website_down_payments(ARRAY[100000], 0.308345);
    IF r.down_payment_jpy <> 30000 OR r.down_payment_php <> 9251 THEN
      RAISE EXCEPTION 'ROLLBACK: expected ¥30,000 / ₱9,251 for ¥100,000 at 0.308345 (₱30,835 half-up, then ₱9,250.5 half-up), got %', row_to_json(r);
    END IF;
    SELECT * INTO r FROM public.website_down_payments(ARRAY[72980], 0.397296);
    IF r.down_payment_jpy <> 21894 OR r.down_payment_php <> 8699 THEN
      RAISE EXCEPTION 'ROLLBACK: expected ¥21,894 / ₱8,699 for ¥72,980 at 0.397296, got %', row_to_json(r);
    END IF;
  ELSE
    RAISE NOTICE 'Shortest active term dp_percentage is % (not 0.30): fixed-figure checks skipped; the wiring checks passed.', v_dp;
  END IF;

  RAISE NOTICE 'website_down_payments OK (shortest active term % months, dp_percentage %)', v_months, v_dp;
END
$check$;

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFICATION (read-only; run after COMMIT). Expected results in the PR.
-- ---------------------------------------------------------------------------
-- V1. The function exists once, with the expected body:
--   SELECT p.oid::regprocedure, md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')))
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'website_down_payments';
-- V2. EXECUTE is service_role only:
--   SELECT r AS role, has_function_privilege(r, 'public.website_down_payments(integer[],numeric)', 'EXECUTE')
--     FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r;
-- V3. The owner's figures at a fixed rate:
--   SELECT * FROM public.website_down_payments(ARRAY[72980, 679980, 12345, 100000], 0.397296) ORDER BY 1;
-- V4. Today's figures for the live catalog, at today's rate:
--   SELECT d.* FROM public.website_down_payments(
--     (SELECT array_agg(DISTINCT price_jpy) FROM website_product_variants),
--     (SELECT jpy_php FROM fx_rates ORDER BY date DESC LIMIT 1)) d ORDER BY 1;
