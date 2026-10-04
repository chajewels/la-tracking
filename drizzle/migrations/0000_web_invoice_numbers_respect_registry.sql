-- Website invoice numbers respect the invoice registry (2026-10-05).
--
-- THE BUG (Paidy test run 2026-10-03, docs/OPEN-BUGS.md): every website order
-- draws its number from web_order_number_seq, and nothing compared that number
-- with public.invoice_numbers. Staff had hand-typed a Hub test order as 900059
-- (stored TEST-900059) on 1 Oct; on 3 Oct the sequence reached 900059 and gave
-- it to a website draft. Staff Confirm then failed for good with "invoice_number
-- TEST-900059 already exists on cash_order": the draft had to be declined and
-- the customer had to order again. The same happens with a real customer's
-- bare number. The reverse hole exists too: staff can type a number that a
-- website draft or a signed layaway quote is already holding, and that draft's
-- Confirm then fails the same way.
--
-- THE FIX, two halves:
--   1. next_web_invoice_seq(): draws from the same sequence but skips any number
--      already in the registry (bare or TEST-), already on a draft, or already
--      reserved by a quote. Every website writer now calls it instead of
--      nextval(): checkout_quotes_reserve_invoice (layaway quote reservation),
--      create_web_draft_atomic (2 call sites), create_web_layaway_atomic and
--      create_web_order_atomic (both dormant since PR 10; patched so no path
--      is left behind). A skipped number is a gap — gaps are by design.
--   2. register_invoice_number() also refuses a number that a website draft
--      awaiting Confirm (status to_confirm) or a live, unconsumed layaway quote
--      reservation holds — unless the row being written IS that draft's order
--      (same web_reference) or that quote's account (same quote_id). So Confirm
--      always succeeds on its own number, and a hand-typed collision is
--      refused at the moment staff type it, with a message they can act on.
--
-- FUNCTION RULES (CLAUDE.md, Bug #280): every changed body is an md5-guarded
-- IN-PLACE patch of the LIVE body (pg_get_functiondef read 2026-10-05). If live
-- has moved, the migration stops and writes nothing. Replaying is a no-op.
-- CREATE OR REPLACE keeps each function's ACL. No data is changed.

-- ---------------------------------------------------------------------------
-- 1. The free-number helper.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.next_web_invoice_seq()
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_seq   bigint;
  v_tries integer := 0;
BEGIN
  LOOP
    v_seq := nextval('public.web_order_number_seq');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.invoice_numbers
                           WHERE invoice_number IN (v_seq::text, 'TEST-' || v_seq::text))
          AND NOT EXISTS (SELECT 1 FROM public.web_order_drafts WHERE invoice_seq = v_seq)
          AND NOT EXISTS (SELECT 1 FROM public.checkout_quotes WHERE reserved_invoice_seq = v_seq);
    v_tries := v_tries + 1;
    IF v_tries >= 1000 THEN
      RAISE EXCEPTION 'next_web_invoice_seq: 1000 website numbers in a row are already taken (last %)', v_seq;
    END IF;
  END LOOP;
  RETURN v_seq;
END
$fn$;
REVOKE ALL ON FUNCTION public.next_web_invoice_seq() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.next_web_invoice_seq() IS
  'The next website order number from web_order_number_seq that is not already an invoice number (bare or TEST-), a draft''s number or a quote''s reservation. Every website writer draws through this, never nextval() directly (2026-10-05).';

-- ---------------------------------------------------------------------------
-- 2. The website writers draw through the helper.
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE
  c_old CONSTANT text := 'nextval(''public.web_order_number_seq'')';
  c_new CONSTANT text := 'public.next_web_invoice_seq()';
  r     record;
  v_fn  regprocedure;
  v_def text;
  v_new text;
  v_n   integer;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.checkout_quotes_reserve_invoice()', '99144148ce2175f437bb6c095855fc62', 1),
      ('public.create_web_draft_atomic(uuid,uuid,text,text,timestamptz)', 'b9b2d136987c30f46f8012e9a0a7abab', 2),
      ('public.create_web_layaway_atomic(uuid,uuid,text,timestamptz,date,text,timestamptz,boolean)', 'd768ccc909cbea34cd16222d46b6c144', 1),
      ('public.create_web_order_atomic(uuid,uuid,text,text,boolean)', 'b2947bed1ccf1650e58651065d8a1622', 1)
    ) AS t(sig, before_md5, sites)
  LOOP
    v_fn := to_regprocedure(r.sig);
    IF v_fn IS NULL THEN
      RAISE EXCEPTION 'STOP — % is not on live; nothing changed', r.sig;
    END IF;
    v_def := pg_get_functiondef(v_fn);
    IF position(c_old IN v_def) = 0 AND position(c_new IN v_def) > 0
       AND md5(replace(v_def, c_new, c_old)) = r.before_md5 THEN
      RAISE NOTICE '% already draws through next_web_invoice_seq — no change', r.sig;
      CONTINUE;
    END IF;
    IF md5(v_def) <> r.before_md5 THEN
      RAISE EXCEPTION 'STOP — % has moved on live (md5 %); re-read it before patching. Nothing changed.', r.sig, md5(v_def);
    END IF;
    v_n := (length(v_def) - length(replace(v_def, c_old, ''))) / length(c_old);
    IF v_n <> r.sites THEN
      RAISE EXCEPTION 'STOP — % has % nextval sites, expected %; nothing changed', r.sig, v_n, r.sites;
    END IF;
    v_new := replace(v_def, c_old, c_new);
    EXECUTE v_new;
    IF md5(pg_get_functiondef(v_fn)) <> md5(v_new) THEN
      RAISE EXCEPTION 'STOP — % did not store the patched body exactly; rolled back', r.sig;
    END IF;
  END LOOP;
END
$patch$;

-- ---------------------------------------------------------------------------
-- 3. register_invoice_number — a number a website order is holding is taken.
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE
  c_sig    CONSTANT text := 'public.register_invoice_number()';
  c_before CONSTANT text := '420f6280214bd81815ba589f12bfc2cc';
  c_anchor CONSTANT text :=
       E'  -- Claim the new number. A collision names WHERE the number already lives,\n';
  c_insert CONSTANT text :=
       E'  -- A number a website order is already holding is taken too (2026-10-05):\n'
    || E'  -- a draft awaiting Confirm, or a signed layaway quote not yet used. The\n'
    || E'  -- draft''s own order (same web_reference) and the quote''s own account (same\n'
    || E'  -- quote_id) pass, so Confirm always gets its number. TEST- is ignored: a\n'
    || E'  -- test customer''s website order is stored TEST-<number>.\n'
    || E'  IF EXISTS (SELECT 1 FROM public.web_order_drafts d\n'
    || E'              WHERE d.status = ''to_confirm''\n'
    || E'                AND d.invoice_seq = CASE WHEN regexp_replace(NEW.invoice_number, ''^TEST-'', '''') ~ ''^[0-9]{1,18}$''\n'
    || E'                                         THEN regexp_replace(NEW.invoice_number, ''^TEST-'', '''')::bigint END\n'
    || E'                AND d.web_reference IS DISTINCT FROM (to_jsonb(NEW) ->> ''web_reference''))\n'
    || E'     OR EXISTS (SELECT 1 FROM public.checkout_quotes q\n'
    || E'              WHERE q.consumed_at IS NULL AND q.expires_at > now()\n'
    || E'                AND q.reserved_invoice_seq = CASE WHEN regexp_replace(NEW.invoice_number, ''^TEST-'', '''') ~ ''^[0-9]{1,18}$''\n'
    || E'                                                  THEN regexp_replace(NEW.invoice_number, ''^TEST-'', '''')::bigint END\n'
    || E'                AND q.id::text IS DISTINCT FROM (to_jsonb(NEW) ->> ''quote_id'')) THEN\n'
    || E'    RAISE EXCEPTION ''invoice_number % is held by a website order awaiting confirmation — use another number'', NEW.invoice_number\n'
    || E'      USING ERRCODE = ''unique_violation'';\n'
    || E'  END IF;\n'
    || E'\n';
  v_fn  regprocedure;
  v_def text;
  v_new text;
BEGIN
  v_fn := to_regprocedure(c_sig);
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — % is not on live; nothing changed', c_sig;
  END IF;
  v_def := pg_get_functiondef(v_fn);
  IF position(c_insert || c_anchor IN v_def) > 0
     AND md5(replace(v_def, c_insert || c_anchor, c_anchor)) = c_before THEN
    RAISE NOTICE '% already refuses website-held numbers — no change', c_sig;
  ELSE
    IF md5(v_def) <> c_before THEN
      RAISE EXCEPTION 'STOP — % has moved on live (md5 %); re-read it before patching. Nothing changed.', c_sig, md5(v_def);
    END IF;
    IF (length(v_def) - length(replace(v_def, c_anchor, ''))) / length(c_anchor) <> 1 THEN
      RAISE EXCEPTION 'STOP — % does not contain the patch anchor exactly once; nothing changed', c_sig;
    END IF;
    v_new := replace(v_def, c_anchor, c_insert || c_anchor);
    EXECUTE v_new;
    IF md5(pg_get_functiondef(v_fn)) <> md5(v_new) THEN
      RAISE EXCEPTION 'STOP — % did not store the patched body exactly; rolled back', c_sig;
    END IF;
  END IF;
END
$patch$;

-- ---------------------------------------------------------------------------
-- Self-checks: everything above is in place, or the whole migration rolls back.
-- ---------------------------------------------------------------------------
DO $check$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_left
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND p.proname <> 'next_web_invoice_seq'
     AND position('nextval(''public.web_order_number_seq'')' IN pg_get_functiondef(p.oid)) > 0;
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'STOP — still drawing website numbers with nextval(): %; rolled back', v_left;
  END IF;
  IF position('held by a website order' IN pg_get_functiondef('public.register_invoice_number()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'STOP — register_invoice_number has no website-held refusal; rolled back';
  END IF;
  IF has_function_privilege('authenticated', 'public.next_web_invoice_seq()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.next_web_invoice_seq()', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — next_web_invoice_seq is executable by anon/authenticated; rolled back';
  END IF;
END
$check$;