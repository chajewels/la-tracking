-- SQF01 (independent go-live counter-check 2026-10-08; owner decision D-SQF01 = A,
-- 2026-10-08 23:38 JST): the cancellation store-credit rule is JAPAN TIME end to end.
-- Project doc: claude/square-go-live-countercheck-response-2026-10-08.md
--
--   The customer terms (storefront returns policy §5, live 2026-10-08) promise:
--   cancel on the day of your order (Japan time) → 100 % of the money paid as
--   store credit; a later day → 30 % charge, 70 % credit. cash_orders.order_date
--   is written as the PHT calendar day (the Hub's day boundary, one hour behind
--   JST) and the old split compared the cancel day in PHT too, so an order placed
--   00:00–00:59 JST carried the PREVIOUS day and a cancel at noon the same Japan
--   day was charged 30 %. Reproduced by the reviewer with the actual helper.
--
--   Rule now: the order day is a JAPAN day — the creation instant's Japan day
--   while order_date still equals the PHT day that instant produced (nobody
--   changed it); otherwise order_date itself (an admin edit, V10c, or a typed
--   Page365 / live-selling date) read as a Japan day. The cancel day is the
--   Japan day of the cancel instant. order_date, the PHT boundary and every
--   other Hub report are untouched.
--
--   cancellation_credit_split gains p_order_at timestamptz DEFAULT NULL (the
--   4-argument signature is DROPPED — a second overload would make 4-argument
--   calls ambiguous — and the grants re-asserted). terminate_web_order_atomic
--   and cancel_cash_order_atomic are patched IN PLACE from the live text behind
--   an md5 guard (Bug #280) to pass cash_orders.created_at. TS mirrors:
--   supabase/functions/_shared/cancellation-credit.ts + src/lib copy.

-- ---------------------------------------------------------------------------
-- 1. The patch helper (session-only).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.cj_patch(p_sig text, p_before text, p_edits jsonb)
RETURNS void LANGUAGE plpgsql AS $p$
DECLARE
  v_fn   regprocedure;
  v_def  text;
  v_new  text;
  e      jsonb;
  v_n    integer;
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
    v_n := (length(v_new) - length(replace(v_new, e ->> 'old', ''))) / length(e ->> 'old');
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'STOP — % anchor found % times, expected 1: %', p_sig, v_n, left(e ->> 'old', 120);
    END IF;
    v_new := replace(v_new, e ->> 'old', e ->> 'new');
  END LOOP;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> md5(v_new) THEN
    RAISE EXCEPTION 'STOP — % did not store the patched body exactly; rolled back', p_sig;
  END IF;
END
$p$;

-- ---------------------------------------------------------------------------
-- 2. The formula, Japan time (live 4-arg md5 e5def822ebf8c0e01c642eb70155a84b).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.cancellation_credit_split(public.account_currency, date, numeric, timestamptz);

CREATE OR REPLACE FUNCTION public.cancellation_credit_split(
  p_currency public.account_currency, p_order_date date, p_money numeric, p_at timestamptz,
  p_order_at timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $fn$
  WITH d AS (
    SELECT GREATEST(coalesce(p_money, 0), 0)::numeric(12,2) AS money,
           (p_at AT TIME ZONE 'Asia/Tokyo')::date AS cancel_day,
           CASE WHEN p_order_date IS NULL THEN NULL
                WHEN p_order_at IS NOT NULL AND (p_order_at AT TIME ZONE 'Asia/Manila')::date = p_order_date
                     THEN (p_order_at AT TIME ZONE 'Asia/Tokyo')::date
                ELSE p_order_date END AS order_day
  ), x AS (
    SELECT money, cancel_day, order_day,
           (order_day IS NULL OR cancel_day <= order_day) AS same_day
      FROM d
  ), k AS (
    SELECT money, cancel_day, order_day, same_day,
           CASE WHEN same_day THEN 0::numeric(12,2)
                WHEN p_currency = 'PHP' THEN round(money * 0.30, 2)
                ELSE round(money * 0.30, 0) END::numeric(12,2) AS kept
      FROM x
  )
  SELECT jsonb_build_object(
           'rule', CASE WHEN same_day THEN 'same_day' ELSE 'after_order_day' END,
           'charge_pct', CASE WHEN same_day THEN 0 ELSE 30 END,
           'money', money, 'kept', kept, 'credit', money - kept,
           'order_date', p_order_date, 'order_day', order_day, 'cancel_date', cancel_day, 'zone', 'Asia/Tokyo')
    FROM k;
$fn$;
REVOKE ALL ON FUNCTION public.cancellation_credit_split(public.account_currency, date, numeric, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancellation_credit_split(public.account_currency, date, numeric, timestamptz, timestamptz) TO authenticated, service_role;
COMMENT ON FUNCTION public.cancellation_credit_split(public.account_currency, date, numeric, timestamptz, timestamptz) IS
  'Owner rule 2026-10-06/08 + D-SQF01 (2026-10-08, Japan time): a cancelled website or Hub cash order gets 100% store credit when cancelled on its order day in Japan time, otherwise 30% of the money paid is kept and 70% is credit. The order day is the Japan day of p_order_at while p_order_date still equals that instant''s PHT day; an edited or typed p_order_date is read as a Japan day as it stands. Shopify is not covered (100%). Pure; TS mirror _shared/cancellation-credit.ts.';

-- ---------------------------------------------------------------------------
-- 3. terminate_web_order_atomic passes created_at (live md5 72cc2e853ae301c183d57febb033b84c).
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)', '72cc2e853ae301c183d57febb033b84c', jsonb_build_array(
  jsonb_build_object('old', $o$  v_order_date date; v_split jsonb := NULL; v_card_paid boolean := false;$o$,
                     'new', $n$  v_order_date date; v_order_at timestamptz; v_split jsonb := NULL; v_card_paid boolean := false;$n$),
  jsonb_build_object('old', $o$  SELECT status::text, currency, customer_id, invoice_number, web_reference, total_paid, order_date
    INTO v_status, v_currency, v_customer_id, v_invoice, v_web_ref, v_total_paid, v_order_date
  FROM public.cash_orders
  WHERE id = p_order_id AND source_channel = 'web'$o$,
                     'new', $n$  SELECT status::text, currency, customer_id, invoice_number, web_reference, total_paid, order_date, created_at
    INTO v_status, v_currency, v_customer_id, v_invoice, v_web_ref, v_total_paid, v_order_date, v_order_at
  FROM public.cash_orders
  WHERE id = p_order_id AND source_channel = 'web'$n$),
  jsonb_build_object('old', $o$    v_split := public.cancellation_credit_split(v_currency, v_order_date, v_money_received, v_now);$o$,
                     'new', $n$    v_split := public.cancellation_credit_split(v_currency, v_order_date, v_money_received, v_now, v_order_at);$n$)
));
-- (The body's own comment above that call still reads "same day as order_date"; the
-- Japan-day rule is documented on cancellation_credit_split and in docs/SQUARE.md.
-- No `--` line may appear inside a patch anchor: Lovable's runner drops such lines,
-- docs/MIGRATIONS.md "Lovable strips in-body comments on apply".)

-- ---------------------------------------------------------------------------
-- 4. cancel_cash_order_atomic passes created_at (live md5 bf5fed7a77d303a4f41292cda86f6dc8).
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text)', 'bf5fed7a77d303a4f41292cda86f6dc8', jsonb_build_array(
  jsonb_build_object('old', $o$  v_order_date date; v_shopify_id text; v_split jsonb;$o$,
                     'new', $n$  v_order_date date; v_order_at timestamptz; v_shopify_id text; v_split jsonb;$n$),
  jsonb_build_object('old', $o$  SELECT status::text, currency, customer_id, invoice_number, order_date, shopify_order_id
    INTO v_status, v_currency, v_customer_id, v_invoice, v_order_date, v_shopify_id
  FROM public.cash_orders WHERE id = p_cash_order_id FOR UPDATE;$o$,
                     'new', $n$  SELECT status::text, currency, customer_id, invoice_number, order_date, shopify_order_id, created_at
    INTO v_status, v_currency, v_customer_id, v_invoice, v_order_date, v_shopify_id, v_order_at
  FROM public.cash_orders WHERE id = p_cash_order_id FOR UPDATE;$n$),
  jsonb_build_object('old', $o$    v_split := public.cancellation_credit_split(v_currency, v_order_date, v_money_received, now());$o$,
                     'new', $n$    v_split := public.cancellation_credit_split(v_currency, v_order_date, v_money_received, now(), v_order_at);$n$)
));

-- ---------------------------------------------------------------------------
-- 5. Self-check: the reviewer's reproduction and both midnights.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE s jsonb;
BEGIN
  -- ¥10,000 ordered 8 Oct 00:30 JST (order_date written as the PHT day, 7 Oct), cancelled 8 Oct 12:00 JST → 100 %.
  s := public.cancellation_credit_split('JPY', DATE '2026-10-07', 10000, TIMESTAMPTZ '2026-10-08 12:00:00+09', TIMESTAMPTZ '2026-10-08 00:30:00+09');
  IF (s ->> 'rule') <> 'same_day' OR (s ->> 'credit')::numeric <> 10000 THEN RAISE EXCEPTION 'STOP — SQF01 reproduction still charges: %', s; END IF;
  -- same order cancelled 9 Oct 00:00:01 JST → 30 %.
  s := public.cancellation_credit_split('JPY', DATE '2026-10-07', 10000, TIMESTAMPTZ '2026-10-09 00:00:01+09', TIMESTAMPTZ '2026-10-08 00:30:00+09');
  IF (s ->> 'rule') <> 'after_order_day' OR (s ->> 'kept')::numeric <> 3000 THEN RAISE EXCEPTION 'STOP — next Japan day not charged: %', s; END IF;
  -- the other midnight: ordered 7 Oct 23:30 JST, cancelled 8 Oct 00:30 JST → after order day.
  s := public.cancellation_credit_split('JPY', DATE '2026-10-07', 10000, TIMESTAMPTZ '2026-10-08 00:30:00+09', TIMESTAMPTZ '2026-10-07 23:30:00+09');
  IF (s ->> 'rule') <> 'after_order_day' THEN RAISE EXCEPTION 'STOP — other midnight wrong: %', s; END IF;
  -- an edited order_date (differs from the instant's PHT day) is read as a Japan day as it stands.
  s := public.cancellation_credit_split('JPY', DATE '2026-10-09', 10000, TIMESTAMPTZ '2026-10-08 11:00:00+09', TIMESTAMPTZ '2026-10-08 10:00:00+09');
  IF (s ->> 'rule') <> 'same_day' OR (s ->> 'order_day') <> '2026-10-09' THEN RAISE EXCEPTION 'STOP — edited date not honoured: %', s; END IF;
  -- no instant (legacy caller): typed date is a Japan day; 4-argument call still works.
  s := public.cancellation_credit_split('JPY', DATE '2026-10-08', 10000, TIMESTAMPTZ '2026-10-08 23:59:59+09');
  IF (s ->> 'rule') <> 'same_day' THEN RAISE EXCEPTION 'STOP — 4-arg call wrong: %', s; END IF;
  IF (public.cancellation_credit_split('JPY', DATE '2026-10-01', 40001, now()) ->> 'kept')::numeric <> 12000 THEN RAISE EXCEPTION 'STOP — rounding moved'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'cancellation_credit_split' AND pronargs = 4) THEN RAISE EXCEPTION 'STOP — the 4-argument overload still exists'; END IF;
  IF position('v_order_at' IN pg_get_functiondef('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)'::regprocedure)) = 0 THEN RAISE EXCEPTION 'STOP — terminate_web_order_atomic not patched'; END IF;
  IF position('v_order_at' IN pg_get_functiondef('public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text)'::regprocedure)) = 0 THEN RAISE EXCEPTION 'STOP — cancel_cash_order_atomic not patched'; END IF;
END $self$;