-- Two owner decisions of 2026-10-15 (Cynthia, plan approved 21:47 JST):
--
--   A. "certificate" is a kind a customer may pick for a service request (the Hub's
--      service_jobs already has the 'Certificate' type). service_requests_kind_check widened.
--
--   B. Paidy and cash on delivery only for a customer who LIVES in Japan. An international
--      customer shipping to a Japanese address (a gift, buying for someone else) gets neither.
--      The Japanese delivery address rule stays; this is added on top.
--      Where she lives = customers.location ('Japan' / 'Philippines' / a country name — what
--      website registration and the Hub's Edit Customer write); only when location is empty
--      does customers.country (the portal sign-up's field) decide. ONE rule:
--      public.customer_in_japan(uuid); TS twin customerInJapan() in
--      supabase/functions/_shared/checkout-choice.ts (reason "customer_not_jp").
--      Enforced at every write that can set Paidy or COD: create_web_draft_atomic,
--      change_web_payment_method_atomic (staff), switch_web_payment_method_by_customer_atomic.
--
--   Every function change is an md5-guarded IN-PLACE patch of the live body (Bug #280), read
--   2026-10-15 ~21:50 JST. No comment line inside any patch anchor or new text (Lovable's
--   runner drops such lines). A re-run is a no-op. After the apply, commit a record-only
--   migration of the patched bodies (docs/MIGRATIONS.md).

SET lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Service request kinds: + certificate.
-- ---------------------------------------------------------------------------
ALTER TABLE public.service_requests DROP CONSTRAINT IF EXISTS service_requests_kind_check;
ALTER TABLE public.service_requests ADD CONSTRAINT service_requests_kind_check
  CHECK (kind = ANY (ARRAY['resize'::text, 'cleaning'::text, 'repair'::text, 'appraisal'::text, 'certificate'::text, 'other'::text]));

-- ---------------------------------------------------------------------------
-- 2. customer_in_japan: location, else country, = 'Japan' (case and spaces ignored).
--    Unknown customer or neither field set = false (fail-closed).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_in_japan(p_customer uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce((
    SELECT lower(coalesce(nullif(btrim(c.location), ''), btrim(c.country))) = 'japan'
      FROM public.customers c
     WHERE c.id = p_customer
  ), false)
$$;
REVOKE ALL ON FUNCTION public.customer_in_japan(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_in_japan(uuid) TO service_role;
COMMENT ON FUNCTION public.customer_in_japan(uuid) IS
  'Owner 2026-10-15: Paidy and cash on delivery only for a customer who lives in Japan. customers.location (website registration / Hub), else customers.country (portal sign-up), = Japan. TS twin: customerInJapan() in _shared/checkout-choice.ts.';

-- ---------------------------------------------------------------------------
-- 3. In-place patches of the live bodies (md5-guarded). Each edit names how many times its
--    anchor must occur ("count", default 1); any other count stops the migration.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.cj_patch(p_sig text, p_before text, p_edits jsonb)
RETURNS void LANGUAGE plpgsql AS $p$
DECLARE
  v_fn   regprocedure;
  v_def  text;
  v_new  text;
  e      jsonb;
  v_n    integer;
  v_want integer;
  v_done boolean := true;
BEGIN
  v_fn := to_regprocedure(p_sig);
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — % is not on live; nothing changed', p_sig;
  END IF;
  v_def := pg_get_functiondef(v_fn);
  FOR e IN SELECT * FROM jsonb_array_elements(p_edits) LOOP
    IF position(e ->> 'new' IN v_def) = 0 THEN v_done := false; END IF;
  END LOOP;
  IF v_done THEN
    RAISE NOTICE '% already patched — no change', p_sig;
    RETURN;
  END IF;
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION 'STOP — % has moved on live (md5 %); re-read it before patching. Nothing changed.', p_sig, md5(v_def);
  END IF;
  v_new := v_def;
  FOR e IN SELECT * FROM jsonb_array_elements(p_edits) LOOP
    v_want := coalesce((e ->> 'count')::integer, 1);
    v_n := (length(v_new) - length(replace(v_new, e ->> 'old', ''))) / length(e ->> 'old');
    IF v_n <> v_want THEN
      RAISE EXCEPTION 'STOP — % anchor found % times, expected %: %', p_sig, v_n, v_want, left(e ->> 'old', 120);
    END IF;
    v_new := replace(v_new, e ->> 'old', e ->> 'new');
  END LOOP;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> md5(v_new) THEN
    RAISE EXCEPTION 'STOP — % did not store the patched body exactly; rolled back', p_sig;
  END IF;
END
$p$;

-- 3a. create_web_draft_atomic: the Paidy and COD offer checks also need customer_in_japan.
SELECT pg_temp.cj_patch('public.create_web_draft_atomic(uuid,uuid,text,text,timestamp with time zone)', '5ef4d83b83e2e5a3d14a8349e27ee798', jsonb_build_array(
  jsonb_build_object('count', 2,
                     'old', $o$coalesce(v_country, '') <> 'JP')$o$,
                     'new', $n$coalesce(v_country, '') <> 'JP' OR NOT public.customer_in_japan(p_customer_id))$n$)
));

-- 3b. change_web_payment_method_atomic (staff): the same for the order's customer.
SELECT pg_temp.cj_patch('public.change_web_payment_method_atomic(text,uuid,text,text,uuid)', '8900a8096048167550678395068e0453', jsonb_build_array(
  jsonb_build_object('count', 2,
                     'old', $o$coalesce(v_country, '') <> 'JP')$o$,
                     'new', $n$coalesce(v_country, '') <> 'JP' OR NOT public.customer_in_japan(v_cust))$n$)
));

-- 3c. switch_web_payment_method_by_customer_atomic: COD and Paidy refuse a customer outside Japan.
SELECT pg_temp.cj_patch('public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text)', '483bba9800f706fe56f841e687ad11fd', jsonb_build_array(
  jsonb_build_object('old', $o$coalesce(v_country, '') <> 'JP' THEN$o$,
                     'new', $n$coalesce(v_country, '') <> 'JP' OR NOT public.customer_in_japan(p_customer_id) THEN$n$),
  jsonb_build_object('old', $o$  IF p_method = 'cod' THEN
$o$,
                     'new', $n$  IF p_method = 'paidy' AND NOT public.customer_in_japan(p_customer_id) THEN
    RETURN jsonb_build_object('error', 'method_unavailable', 'method', p_method);
  END IF;
  IF p_method = 'cod' THEN
$n$)
));

-- 3d. Explicit ACLs for every body the patches recreate: service role only, as live.
REVOKE ALL ON FUNCTION public.create_web_draft_atomic(uuid, uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_web_draft_atomic(uuid, uuid, text, text, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.change_web_payment_method_atomic(text, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_web_payment_method_atomic(text, uuid, text, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.switch_web_payment_method_by_customer_atomic(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.switch_web_payment_method_by_customer_atomic(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Self-check. Anything unexpected rolls the whole migration back.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  v_def text;
BEGIN
  IF position($q$'certificate'$q$ IN (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'public.service_requests'::regclass AND conname = 'service_requests_kind_check')) = 0 THEN
    RAISE EXCEPTION 'STOP — service_requests_kind_check does not allow certificate';
  END IF;
  v_def := pg_get_functiondef('public.create_web_draft_atomic(uuid,uuid,text,text,timestamptz)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, 'NOT public.customer_in_japan(p_customer_id)', ''))) / length('NOT public.customer_in_japan(p_customer_id)') <> 2 THEN
    RAISE EXCEPTION 'STOP — create_web_draft_atomic not patched';
  END IF;
  v_def := pg_get_functiondef('public.change_web_payment_method_atomic(text,uuid,text,text,uuid)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, 'NOT public.customer_in_japan(v_cust)', ''))) / length('NOT public.customer_in_japan(v_cust)') <> 2 THEN
    RAISE EXCEPTION 'STOP — change_web_payment_method_atomic not patched';
  END IF;
  v_def := pg_get_functiondef('public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, 'NOT public.customer_in_japan(p_customer_id)', ''))) / length('NOT public.customer_in_japan(p_customer_id)') <> 2 THEN
    RAISE EXCEPTION 'STOP — switch_web_payment_method_by_customer_atomic not patched';
  END IF;
  IF has_function_privilege('anon', 'public.customer_in_japan(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.customer_in_japan(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.customer_in_japan(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.create_web_draft_atomic(uuid,uuid,text,text,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.change_web_payment_method_atomic(text,uuid,text,text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — grants not as expected';
  END IF;
END
$self$;
