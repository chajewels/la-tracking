-- Each test raises on failure; the run prints PASS lines.
\set QUIET on
\pset tuples_only on
CREATE TEMP TABLE results (name text, ok boolean);
CREATE FUNCTION pg_temp.t(p_name text, p_ok boolean) RETURNS void LANGUAGE sql AS
$$ INSERT INTO results VALUES (p_name, coalesce(p_ok, false)) $$;
CREATE FUNCTION pg_temp.raises(p_sql text, p_like text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN false;
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM LIKE p_like; END $$;

-- The 3 Oct incident: staff hand-typed TEST-900059 (test) and 900057 (real) earlier.
INSERT INTO public.cash_orders (invoice_number) VALUES ('900056'), ('TEST-900057');
SELECT pg_temp.t('S1 helper skips a bare registry number and a TEST- one',
  (SELECT array_agg(public.next_web_invoice_seq()) FROM generate_series(1,2)) = ARRAY[900055::bigint, 900058]);
-- 900055 free -> taken; 900056 bare taken; 900057 TEST- taken; 900058 free.

INSERT INTO public.web_order_drafts (invoice_seq, web_reference) VALUES (900059, 'CJ-W-900059');
INSERT INTO public.checkout_quotes (mode, reserved_invoice_seq) VALUES ('full', 900060);
SELECT pg_temp.t('S2 helper skips numbers on a draft or a quote (e.g. after a setval)',
  public.next_web_invoice_seq() = 900061);

-- The layaway quote trigger draws through the helper.
INSERT INTO public.cash_orders (invoice_number) VALUES ('TEST-900062');
INSERT INTO public.checkout_quotes (mode) VALUES ('layaway');
SELECT pg_temp.t('S3 layaway quote reservation skips a registry number',
  (SELECT reserved_invoice_seq FROM public.checkout_quotes WHERE mode='layaway' ORDER BY reserved_invoice_seq DESC LIMIT 1) = 900063);
INSERT INTO public.checkout_quotes (mode) VALUES ('full');
SELECT pg_temp.t('S4 a full quote still reserves nothing',
  (SELECT count(*) FROM public.checkout_quotes WHERE mode='full' AND reserved_invoice_seq IS NULL) = 1);
INSERT INTO public.checkout_quotes (mode, reserved_invoice_seq) VALUES ('layaway', 900200);
SELECT pg_temp.t('S5 a quote with a number already set keeps it',
  EXISTS (SELECT 1 FROM public.checkout_quotes WHERE reserved_invoice_seq = 900200)
  AND (SELECT count(*) FROM public.checkout_quotes WHERE mode = 'layaway') = 2);

-- Registry: staff typing a number a website order holds.
SELECT pg_temp.t('R1 staff cannot type a number held by a draft awaiting Confirm (bare)',
  pg_temp.raises($$INSERT INTO public.cash_orders (invoice_number) VALUES ('900059')$$, '%900059 is held by a website order%'));
SELECT pg_temp.t('R2 ...nor its TEST- form, on a layaway either',
  pg_temp.raises($$INSERT INTO public.layaway_accounts (invoice_number) VALUES ('TEST-900059')$$, '%held by a website order%'));
DO $x$ BEGIN
  INSERT INTO public.cash_orders (invoice_number) VALUES ('900059');
  PERFORM pg_temp.t('R3 the refusal is a unique_violation (23505)', false);
EXCEPTION WHEN unique_violation THEN
  PERFORM pg_temp.t('R3 the refusal is a unique_violation (23505)', true);
END $x$;
SELECT pg_temp.t('R4 Confirm (same web_reference) gets the draft''s own number',
  NOT pg_temp.raises($$INSERT INTO public.cash_orders (invoice_number, web_reference) VALUES ('TEST-900059', 'CJ-W-900059')$$, '%'));
SELECT pg_temp.t('R5 ...and it is registered',
  EXISTS (SELECT 1 FROM public.invoice_numbers WHERE invoice_number = 'TEST-900059'));
-- A confirmed draft no longer blocks; registry already holds it.
UPDATE public.web_order_drafts SET status = 'confirmed' WHERE invoice_seq = 900059;
SELECT pg_temp.t('R6 after Confirm the ordinary registry refusal applies',
  pg_temp.raises($$INSERT INTO public.cash_orders (invoice_number) VALUES ('TEST-900059')$$, '%already exists on cash_order%'));

-- A declined / expired draft frees its number for staff.
INSERT INTO public.web_order_drafts (invoice_seq, web_reference, status) VALUES (900300, 'CJ-W-900300', 'declined'),
  (900301, 'CJ-W-900301', 'expired');
SELECT pg_temp.t('R7 a declined or expired draft does not block staff',
  NOT pg_temp.raises($$INSERT INTO public.cash_orders (invoice_number) VALUES ('900300'), ('TEST-900301')$$, '%'));

-- Layaway quote reservations.
SELECT pg_temp.t('R8 staff cannot type a live layaway quote''s reserved number',
  pg_temp.raises($$INSERT INTO public.cash_orders (invoice_number) VALUES ('900063')$$, '%held by a website order%'));
SELECT pg_temp.t('R9 the quote''s own account (same quote_id) passes',
  NOT pg_temp.raises(format($$INSERT INTO public.layaway_accounts (invoice_number, quote_id) VALUES ('900063', %L)$$,
     (SELECT id FROM public.checkout_quotes WHERE reserved_invoice_seq = 900063)), '%'));
INSERT INTO public.checkout_quotes (mode, reserved_invoice_seq, consumed_at) VALUES ('layaway', 900400, now());
INSERT INTO public.checkout_quotes (mode, reserved_invoice_seq, expires_at) VALUES ('layaway', 900401, now() - interval '1 minute');
SELECT pg_temp.t('R10 a consumed or expired quote does not block staff',
  NOT pg_temp.raises($$INSERT INTO public.cash_orders (invoice_number) VALUES ('900400'), ('900401')$$, '%'));

-- Ordinary invoice numbers are untouched.
SELECT pg_temp.t('R11 a normal hand-typed number still registers',
  NOT pg_temp.raises($$INSERT INTO public.layaway_accounts (invoice_number) VALUES ('19500')$$, '%'));
SELECT pg_temp.t('R12 a non-numeric number is not misread',
  NOT pg_temp.raises($$INSERT INTO public.cash_orders (invoice_number) VALUES ('TEST-ABC'), ('99999999999999999999')$$, '%'));
SELECT pg_temp.t('R13 a duplicate still names its holder',
  pg_temp.raises($$INSERT INTO public.cash_orders (invoice_number) VALUES ('19500')$$, '%19500 already exists on layaway_account%'));
SELECT pg_temp.t('R14 rename onto a held number is refused; rename elsewhere works',
  pg_temp.raises($$UPDATE public.cash_orders SET invoice_number = '900063' WHERE invoice_number = '900400'$$, '%900063 is held by a website order%')
  AND NOT pg_temp.raises($$UPDATE public.cash_orders SET invoice_number = '19501' WHERE invoice_number = '900400'$$, '%'));
INSERT INTO public.web_order_drafts (invoice_seq, web_reference) VALUES (900500, 'CJ-W-900500');
SELECT pg_temp.t('R15 rename onto a draft-held number is refused',
  pg_temp.raises($$UPDATE public.cash_orders SET invoice_number = '900500' WHERE invoice_number = '19501'$$, '%held by a website order%'));
DELETE FROM public.cash_orders WHERE invoice_number = '19501';
SELECT pg_temp.t('R16 delete still releases the number',
  NOT EXISTS (SELECT 1 FROM public.invoice_numbers WHERE invoice_number = '19501'));

-- Grants.
SELECT pg_temp.t('G1 helper not executable by anon/authenticated',
  NOT has_function_privilege('anon', 'public.next_web_invoice_seq()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.next_web_invoice_seq()', 'EXECUTE'));
SELECT pg_temp.t('G2 no nextval left outside the helper',
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname <> 'next_web_invoice_seq'
                 AND position('nextval(''public.web_order_number_seq'')' IN pg_get_functiondef(p.oid)) > 0));

DO $$ DECLARE r record; f int := 0; BEGIN
  FOR r IN SELECT * FROM results LOOP
    RAISE NOTICE '% %', CASE WHEN r.ok THEN 'PASS' ELSE 'FAIL' END, r.name;
    IF NOT r.ok THEN f := f + 1; END IF;
  END LOOP;
  RAISE NOTICE '% passed, % failed', (SELECT count(*) FROM results WHERE ok), f;
  IF f > 0 THEN RAISE EXCEPTION '% test(s) failed', f; END IF;
END $$;
