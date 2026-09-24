-- The four Finance daily-sales reads check view_finance themselves.
--
-- Follow-up to 20260924140100 (2026-09-24). That migration took anon off
-- get_daily_cash_orders, get_daily_cash_orders_last_month,
-- get_daily_new_layaway_sales and get_daily_new_layaway_sales_last_month. They
-- keep the authenticated grant because the Finance page calls them from the
-- browser (src/hooks/financeQueryOptions.ts, prefetched by
-- usePrefetchHeavyPages). But they are SECURITY DEFINER with no caller check,
-- and portal customers hold authenticated sessions too. So any signed-in
-- customer could read the business's daily sales count and value. The route
-- itself is gated on view_finance (PermissionsContext '/finance'), and the
-- functions now require the same key. Live on 2026-09-24: admin and finance
-- roles hold it, staff and csr do not, plus 2 per-user grants.
--
-- The gate is IF auth.uid() IS NOT NULL AND NOT has_permission(...): a
-- service-role or SQL Editor caller (uid NULL) is unaffected, which is the
-- same shape email_delivery_report uses. has_permission applies the Hub's
-- resolution order (admin → override → role).
--
-- FUNCTION RULES (CLAUDE.md): md5-guarded IN-PLACE patch of the LIVE bodies
-- (read with pg_get_functiondef 2026-09-24). Each body gets exactly one
-- insertion, after BEGIN, and nothing else changes. If live has moved, the
-- migration stops and writes nothing. Replaying is a no-op. CREATE OR REPLACE
-- keeps each function's ACL.

DO $patch$
DECLARE
  v_spec CONSTANT text[][] := ARRAY[
    -- signature, live md5 before, md5 after
    ARRAY['public.get_daily_cash_orders()',                         '257022526e1ab659943f82439c2ebd2f', 'ad0edf26d81f2f4d385e6709af182300'],
    ARRAY['public.get_daily_cash_orders_last_month()',              '9c069077054876b2f446108362ec35be', '2d5f97baf90d9d1379761b496bb5dc06'],
    ARRAY['public.get_daily_new_layaway_sales(text)',               '3065dbe5ff8b4ed4ff31a04c54ada4fb', 'ca91cee3b5470e1107465d43b9411f47'],
    ARRAY['public.get_daily_new_layaway_sales_last_month(text)',    '2bda4bd0a74ff7ba2c80f4482ce3caa2', 'c1ac755eca7c1a9e428adfe951159c4e']];
  v_anchor CONSTANT text := E'AS $function$\nBEGIN\n  RETURN (';
  v_gate   CONSTANT text := E'AS $function$\nBEGIN\n'
    || E'  -- Finance only (2026-09-24): the /finance route''s own key. Customers hold\n'
    || E'  -- authenticated sessions too. Service-role / SQL Editor (uid NULL) pass.\n'
    || E'  IF auth.uid() IS NOT NULL AND NOT public.has_permission(auth.uid(), ''view_finance'') THEN\n'
    || E'    RAISE EXCEPTION ''view_finance permission required'' USING ERRCODE = ''42501'';\n'
    || E'  END IF;\n'
    || E'  RETURN (';
  v_fn  regprocedure;
  v_def text;
  v_md5 text;
  v_new text;
  i     int;
BEGIN
  -- Check all four first; change nothing unless every one is as expected.
  FOR i IN 1 .. array_length(v_spec, 1) LOOP
    v_fn := to_regprocedure(v_spec[i][1]);
    IF v_fn IS NULL THEN
      RAISE EXCEPTION 'STOP — % is not on live; nothing changed', v_spec[i][1];
    END IF;
    v_md5 := md5(pg_get_functiondef(v_fn));
    IF v_md5 NOT IN (v_spec[i][2], v_spec[i][3]) THEN
      RAISE EXCEPTION 'STOP — % has moved on live (md5 %); re-read it before patching. Nothing changed.', v_spec[i][1], v_md5;
    END IF;
  END LOOP;

  FOR i IN 1 .. array_length(v_spec, 1) LOOP
    v_fn  := to_regprocedure(v_spec[i][1]);
    v_def := pg_get_functiondef(v_fn);
    CONTINUE WHEN md5(v_def) = v_spec[i][3];          -- already patched
    IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
      RAISE EXCEPTION 'STOP — % does not contain the patch anchor exactly once', v_spec[i][1];
    END IF;
    v_new := replace(v_def, v_anchor, v_gate);
    EXECUTE v_new;
    IF md5(pg_get_functiondef(v_fn)) <> v_spec[i][3] THEN
      RAISE EXCEPTION 'STOP — % patched to md5 %, expected %; rolled back',
        v_spec[i][1], md5(pg_get_functiondef(v_fn)), v_spec[i][3];
    END IF;
  END LOOP;
END
$patch$;
