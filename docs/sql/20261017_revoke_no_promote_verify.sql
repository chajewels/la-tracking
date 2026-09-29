-- ============================================================================
-- revoke never promotes (20261017100000_revoke_never_promotes.sql) — checks.
-- Nothing here writes: (P) and the numbered checks are SELECTs; (T) runs the
-- new body against three scenarios on the TEST account inside a transaction
-- that ALWAYS ends in an exception, so every change is rolled back.
-- ============================================================================

-- (P.1) Live body is the one this file replaces. Want 8a54322def541531b1698b4dd18fccb9.
SELECT 'P.1' AS chk, md5(prosrc) FROM pg_proc
 WHERE oid = to_regprocedure('public.revoke_loyalty_points(uuid,text,numeric,uuid,uuid,uuid,text,text,uuid,text)');

-- (P.2) Members stepped down today (the exposure). Real members stay exactly as they are.
SELECT 'P.2' AS chk, c.customer_code, c.is_test, t.name AS tier, m.cumulative_spend_jpy,
       (SELECT t2.name FROM public.loyalty_tiers t2 WHERE t2.min_spend_jpy <= m.cumulative_spend_jpy
         ORDER BY t2.min_spend_jpy DESC LIMIT 1) AS spend_tier, m.downgrade_spend_baseline
  FROM public.loyalty_members m JOIN public.customers c ON c.id = m.customer_id
  LEFT JOIN public.loyalty_tiers t ON t.id = m.current_tier_id
 WHERE m.is_downgraded;

-- (T) Behaviour, on the Test Customer (CJ-2026-05088) only. Paste the migration's
-- CREATE OR REPLACE (without its BEGIN/COMMIT) BEFORE this block in the same
-- run, then this block. It ends with RAISE EXCEPTION 'RESULT …' — the result is
-- in the error text and NOTHING is kept.
--   A stepped down (Glimmer, spend tier Elite)      → stays Glimmer, still stepped down, no tier row
--   B normal Elite, spend falls below Elite          → Radiant, one "Tier downgraded" row
--   C normal Radiant, spend tier Elite (lagging)     → stays Radiant (a revoke never promotes)
DO $t$
DECLARE
  v_m uuid;
  v_glim uuid; v_rad uuid; v_eli uuid;
  v_out jsonb := '{}'::jsonb;
  s text;
BEGIN
  SELECT m.id INTO v_m FROM public.loyalty_members m JOIN public.customers c ON c.id = m.customer_id
   WHERE c.customer_code = 'CJ-2026-05088' AND c.is_test;
  IF v_m IS NULL THEN RAISE EXCEPTION 'test member not found'; END IF;
  SELECT id INTO v_glim FROM public.loyalty_tiers WHERE name = 'Glimmer';
  SELECT id INTO v_rad  FROM public.loyalty_tiers WHERE name = 'Radiant';
  SELECT id INTO v_eli  FROM public.loyalty_tiers WHERE name = 'Elite';

  FOREACH s IN ARRAY ARRAY['A','B','C'] LOOP
    UPDATE public.loyalty_members SET
      current_tier_id = CASE s WHEN 'A' THEN v_glim WHEN 'B' THEN v_eli ELSE v_rad END,
      is_downgraded = (s = 'A'),
      downgrade_spend_baseline = CASE WHEN s = 'A' THEN 4430940 END,
      cumulative_spend_jpy = CASE s WHEN 'B' THEN 4050000 ELSE 4530940 END
     WHERE id = v_m;
    INSERT INTO public.loyalty_transactions (member_id, transaction_type, points_amount, spend_amount_jpy, invoice_number, notes)
    VALUES (v_m, 'earned', 1000, 100000, 'TEST-REVOKE-PREVIEW-' || s, 'rollback-only preview');
    INSERT INTO public.loyalty_point_lots (member_id, source_type, source_reference, original_amount, remaining_amount, earned_at, expires_at)
    VALUES (v_m, 'order_earn', 'TEST-REVOKE-PREVIEW-' || s, 1000, 1000, now(), now() + interval '180 days');

    PERFORM public.revoke_loyalty_points(v_m, 'TEST-REVOKE-PREVIEW-' || s, 0, NULL, NULL, NULL,
                                         'TEST-REVOKE-PREVIEW-' || s, 'rollback-only preview', NULL, 'preview');

    v_out := v_out || jsonb_build_object(s, (
      SELECT jsonb_build_object('tier', t.name, 'is_downgraded', m.is_downgraded,
               'baseline', m.downgrade_spend_baseline, 'spend', m.cumulative_spend_jpy,
               'tier_rows', (SELECT count(*) FROM public.loyalty_transactions x
                              WHERE x.member_id = v_m AND x.transaction_type = 'tier_changed'
                                AND x.invoice_number = 'TEST-REVOKE-PREVIEW-' || s),
               'revoked_rows', (SELECT count(*) FROM public.loyalty_transactions x
                              WHERE x.member_id = v_m AND x.transaction_type = 'revoked'
                                AND x.invoice_number = 'TEST-REVOKE-PREVIEW-' || s))
        FROM public.loyalty_members m LEFT JOIN public.loyalty_tiers t ON t.id = m.current_tier_id
       WHERE m.id = v_m));
  END LOOP;

  RAISE EXCEPTION 'RESULT %', v_out;
END
$t$;

-- AFTER the migration.
-- (1) Body is this file's. Want 0433a3f792ddfda6105f59ed97ef621d, exactly one function.
SELECT '1' AS chk, md5(prosrc), (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                   WHERE n.nspname = 'public' AND p.proname = 'revoke_loyalty_points') AS n
  FROM pg_proc WHERE oid = to_regprocedure('public.revoke_loyalty_points(uuid,text,numeric,uuid,uuid,uuid,text,text,uuid,text)');
-- (2) Grants unchanged. Want f | f | t.
SELECT '2' AS chk,
       has_function_privilege('anon', 'public.revoke_loyalty_points(uuid,text,numeric,uuid,uuid,uuid,text,text,uuid,text)', 'EXECUTE'),
       has_function_privilege('authenticated', 'public.revoke_loyalty_points(uuid,text,numeric,uuid,uuid,uuid,text,text,uuid,text)', 'EXECUTE'),
       has_function_privilege('service_role', 'public.revoke_loyalty_points(uuid,text,numeric,uuid,uuid,uuid,text,text,uuid,text)', 'EXECUTE');
-- (3) The stepped-down members are unchanged (same rows as P.2).
-- (4) loyalty_integrity_report(): still exactly ONE row (the Test Customer baseline).
SELECT '4' AS chk, count(*) FROM public.loyalty_integrity_report();
