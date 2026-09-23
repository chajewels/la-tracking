-- ============================================================================
-- RESERVE FIRST, PAY AFTER STAFF CONFIRM — A1 (SQL only)
--
-- Owner-approved design, 2026-09-23. For WEB cash orders and WEB layaways:
--
--   * Checkout can create the order/plan as a RESERVATION: the stock is held
--     (the piece reads Sold), there is NO payment deadline, and no payment
--     details are shown (the storefront only lists transfer methods while
--     payment_status = 'pending_transfer').
--   * Staff holding confirm_web_order_ready press "Confirm — ready for
--     dispatch": the payment deadline starts THEN, by the existing
--     web_deposit_deadline_hours rule (24h first order / 72h returning), and
--     payment details become visible.
--   * "Can't supply": cash -> terminate_web_order_atomic('cancelled') (already
--     returns the stock, unchanged here); layaway ->
--     decline_web_layaway_reservation_atomic.
--   * Unconfirmed after 72 hours: cancelled, stock returned
--     (expire_unconfirmed_web_reservations_atomic; A2 schedules it and emails).
--   * A layaway's installment schedule starts from the CONFIRMATION date.
--   * Switch: system_settings.web_reservation_mode, seeded FALSE. The RPCs do
--     not read it — the A2 edge function reads it and passes p_reserve. With the
--     switch false nothing passes p_reserve and every order behaves as today.
--
-- WHAT "NOT YET CONFIRMED" MEANS. ready_confirmed_at IS NULL on a WEB row.
-- Every predicate below is scoped to source_channel = 'web'; Hub-created rows
-- keep NULL and are never read by any of this. A NON-reserved web order stamps
-- ready_confirmed_at = now() at creation, so it can never be mistaken for a
-- reservation (and swept after 72 hours). Every existing web row is
-- grandfathered with ready_confirmed_at = created_at (0 in flight on live,
-- owner query 2026-09-23 — stamped anyway so the rule holds for any that exist).
--
-- A LAYAWAY'S ORDER DATE MOVES WITH ITS SCHEDULE. The due-date rule is written
-- in four places (create-layaway-account, restructure-account,
-- generateScheduleDates, layaway_quote) as "installment n is due
-- order_date + n months". Re-anchoring the schedule to the confirmation date
-- while leaving order_date at the checkout date would make the stored plan
-- disagree with that rule. So confirmation sets order_date to the confirmation
-- date (PHT) and recomputes every open row as order_date + n months with the
-- identical expression layaway_quote uses; the checkout date is kept in the
-- audit row. end_date follows.
--
-- FUNCTION RULES (CLAUDE.md "FUNCTION CHANGES START FROM LIVE"). Four existing
-- functions change. Each new body is the body recorded in the repo plus the
-- edits marked RESERVE-FIRST (A1), produced by exact-text replacement:
--
--   function                      recorded in                                        live body md5 (whitespace-collapsed prosrc)
--   create_web_order_atomic       20260917070200_record_live_drifted_functions.sql   0d9b54812778af7f8ed0e9b36a9859fa
--   create_web_layaway_atomic     20260918120000_reserve_web_layaway_invoice_at_quote df26220e8556ff5b17dc48508a96051e
--   set_account_deadlines         20260915150000_deadline_refused_once_deposit_confirmed 343788e7b0c48b7b9209e24176392022
--   web_deposit_deadline_hours    20260916060000_deposit_deadline_follows_the_customer 79c75b7904d6e87f3ad79e9eed464b93
--
-- The md5 is the scripts/function-drift-audit comparator (md5 of prosrc with
-- whitespace collapsed), so it is independent of pg_get_functiondef's header
-- formatting. Section 0 refuses to run unless live matches all four, has
-- exactly ONE overload of each, and the payment_status CHECK is exactly the
-- definition this file replaces. Section 11 refuses to finish unless every new
-- body md5-matches the body predicted in a scratch Postgres, and every
-- replaced function carries exactly the EXECUTE grants its predecessor had.
-- Either the intended change lands on the expected state, or nothing does.
--
-- DROP-AND-REPLACE, NO SECOND OVERLOAD. create_web_order_atomic,
-- create_web_layaway_atomic and web_deposit_deadline_hours gain a trailing
-- defaulted parameter. CREATE OR REPLACE with a new argument list would leave
-- the old signature beside the new one and every call that omits the new
-- parameter would fail with "is not unique". Each is DROPPED and re-created;
-- its EXECUTE grants are captured first and re-applied exactly (section 0 /
-- pg_temp._a1_carry_acl), so nobody gains or loses the right to call it.
-- Callers are unaffected: the website edge function calls all three by name
-- with named arguments, and plpgsql callers (revive_web_cash_order_atomic)
-- resolve at run time.
--
-- ADDITIVE ONLY: two columns per table, two partial indexes, one CHECK value,
-- three new functions, one permission key, one setting. Nothing is removed
-- except the three superseded signatures.
-- ============================================================================

-- ---------------------------------------------------------------- 0. guards
DO $guard$
DECLARE
  v_expect CONSTANT text[][] := ARRAY[
    ARRAY['create_web_order_atomic',    '0d9b54812778af7f8ed0e9b36a9859fa'],
    ARRAY['create_web_layaway_atomic',  'df26220e8556ff5b17dc48508a96051e'],
    ARRAY['set_account_deadlines',      '343788e7b0c48b7b9209e24176392022'],
    ARRAY['web_deposit_deadline_hours', '79c75b7904d6e87f3ad79e9eed464b93']];
  v_check CONSTANT text :=
    'CHECK (((payment_status IS NULL) OR (payment_status = ANY (ARRAY[''pending_transfer''::text, ''paid''::text, ''failed''::text, ''refunded''::text, ''cancelled''::text]))))';
  v_n    integer;
  v_md5  text;
  v_def  text;
  v_bad  text := '';
  i      integer;
BEGIN
  FOR i IN 1 .. array_length(v_expect, 1) LOOP
    SELECT count(*), min(md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))))
      INTO v_n, v_md5
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_expect[i][1];
    IF v_n <> 1 THEN
      v_bad := v_bad || format(E'\n  %s: %s overloads live, expected exactly 1', v_expect[i][1], v_n);
    ELSIF v_md5 <> v_expect[i][2] THEN
      v_bad := v_bad || format(E'\n  %s: live body md5 %s, expected %s', v_expect[i][1], v_md5, v_expect[i][2]);
    END IF;
  END LOOP;

  SELECT pg_get_constraintdef(c.oid) INTO v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.cash_orders'::regclass
     AND c.conname = 'cash_orders_payment_status_check';
  IF v_def IS DISTINCT FROM v_check THEN
    v_bad := v_bad || format(E'\n  cash_orders_payment_status_check is %s, expected %s', coalesce(v_def, '(absent)'), v_check);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname IN ('confirm_web_order_ready_atomic',
                                  'decline_web_layaway_reservation_atomic',
                                  'expire_unconfirmed_web_reservations_atomic')) THEN
    v_bad := v_bad || E'\n  a Reserve-first A1 function already exists — this migration has run before or something else defined it';
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION E'STOP — live is not the state this migration was written against. Nothing was modified.%', v_bad;
  END IF;
END
$guard$;

-- Grants of the three functions that are dropped and re-created, captured
-- BEFORE the drop and re-applied after (sections 3-5), then proved in 11.
CREATE TEMP TABLE _a1_acl AS
SELECT p.proname::text AS proname, p.proacl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('create_web_order_atomic', 'create_web_layaway_atomic', 'web_deposit_deadline_hours');

-- Re-apply a captured ACL to a new signature: EXECUTE for exactly the grantees
-- that held it before (PUBLIC included), and for nobody else.
CREATE FUNCTION pg_temp._a1_carry_acl(p_name text, p_fn regprocedure)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_acl aclitem[];
  r     record;
BEGIN
  SELECT proacl INTO v_acl FROM _a1_acl WHERE proname = p_name;
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', p_fn);
  FOR r IN SELECT rolname FROM pg_roles
            WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', p_fn, r.rolname);
  END LOOP;
  IF v_acl IS NULL THEN
    -- NULL proacl = the default: owner plus PUBLIC.
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', p_fn);
    RETURN;
  END IF;
  FOR r IN SELECT DISTINCT a.grantee
             FROM aclexplode(v_acl) a
            WHERE a.privilege_type = 'EXECUTE' LOOP
    IF r.grantee = 0 THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', p_fn);
    ELSE
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', p_fn, pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END
$$;

-- ------------------------------------------------ 1. columns, indexes, grandfather
ALTER TABLE public.cash_orders
  ADD COLUMN IF NOT EXISTS ready_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS ready_confirmed_by uuid;
ALTER TABLE public.layaway_accounts
  ADD COLUMN IF NOT EXISTS ready_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS ready_confirmed_by uuid;

COMMENT ON COLUMN public.cash_orders.ready_confirmed_at IS
  'WEB orders only. When staff confirmed the order ready for dispatch (confirm_web_order_ready_atomic), which is when its payment deadline started. NULL on a web order = a reservation awaiting confirmation (no deadline, payment_status awaiting_confirmation). A non-reserved web order is stamped at creation; web orders before 2026-09-23 were grandfathered with created_at. Always NULL on Hub orders and never read for them.';
COMMENT ON COLUMN public.cash_orders.ready_confirmed_by IS
  'User who confirmed the web order ready for dispatch. NULL when stamped automatically (non-reserved creation, grandfathering).';
COMMENT ON COLUMN public.layaway_accounts.ready_confirmed_at IS
  'WEB plans only. When staff confirmed the plan ready for dispatch (confirm_web_order_ready_atomic): the deposit deadline started then and the schedule and order_date were re-anchored to that date. NULL on a web plan = a reservation awaiting confirmation (no deposit deadline). A non-reserved web plan is stamped at creation; web plans before 2026-09-23 were grandfathered with created_at. Always NULL on Hub plans and never read for them.';
COMMENT ON COLUMN public.layaway_accounts.ready_confirmed_by IS
  'User who confirmed the web plan ready for dispatch. NULL when stamped automatically (non-reserved creation, grandfathering).';

-- The unconfirmed queue: what staff work through, and what the 72-hour sweep reads.
CREATE INDEX IF NOT EXISTS idx_cash_orders_web_awaiting_ready
  ON public.cash_orders (created_at)
  WHERE source_channel = 'web' AND ready_confirmed_at IS NULL AND status = 'pending';
CREATE INDEX IF NOT EXISTS idx_layaway_accounts_web_awaiting_ready
  ON public.layaway_accounts (created_at)
  WHERE source_channel = 'web' AND ready_confirmed_at IS NULL AND status = 'active';

-- Grandfather: every web row that exists before this migration was created
-- under the old flow and is "ready" by definition. Side effects, both known
-- and accepted: the BEFORE UPDATE triggers bump updated_at on those rows, and
-- trg_audit_layaway_accounts writes one audit_logs 'UPDATE' row per web plan.
-- No trigger keyed on status, totals, invoice or plan fires (none of those
-- columns change).
UPDATE public.cash_orders
   SET ready_confirmed_at = created_at
 WHERE source_channel = 'web' AND ready_confirmed_at IS NULL;
UPDATE public.layaway_accounts
   SET ready_confirmed_at = created_at
 WHERE source_channel = 'web' AND ready_confirmed_at IS NULL;

-- ------------------------------------------------- 2. payment_status value
-- Section 0 proved the live definition is exactly the five values below.
ALTER TABLE public.cash_orders DROP CONSTRAINT cash_orders_payment_status_check;
ALTER TABLE public.cash_orders ADD CONSTRAINT cash_orders_payment_status_check
  CHECK (payment_status IS NULL OR payment_status = ANY (
    ARRAY['pending_transfer','paid','failed','refunded','cancelled','awaiting_confirmation']));

COMMENT ON COLUMN public.cash_orders.payment_status IS
  'Web-checkout payment state. The cash_order_status enum (pending/completed/cancelled/expired) is unchanged and still drives every existing Hub surface: a web order awaiting a bank transfer is status=''pending'' + payment_status=''pending_transfer''. A RESERVATION (reserve-first, 2026-09-23) is status=''pending'' + payment_status=''awaiting_confirmation'' + ready_confirmed_at NULL until staff confirm it ready for dispatch; payment details are shown only for pending_transfer. Confirming the transfer sets status=''completed'' + payment_status=''paid'', which is what award-loyalty-points already watches for.';

-- ------------------------------------------ 3. web_deposit_deadline_hours(customer, exclude)
-- The order being confirmed already exists and is live, so without the
-- exclusion every confirmation would count the customer's OWN order and give a
-- first-time customer 72 hours instead of 24. p_exclude_order is matched
-- against both tables (ids are uuids and never collide). Body otherwise
-- identical to 20260916060000.
DROP FUNCTION public.web_deposit_deadline_hours(uuid);

CREATE FUNCTION public.web_deposit_deadline_hours(p_customer_id uuid, p_exclude_order uuid DEFAULT NULL::uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  -- RETURNING = has transacted with us before. A cancelled or expired order is
  -- not a transaction: the one customer in live data whose only orders are
  -- cancelled (measured 2026-09-16: 198 customers are new by this test, 197 by
  -- "any order at all") is the person this distinction is FOR — they have
  -- already let a deadline lapse once.
  --
  -- Web expiry writes status 'cancelled' on both tables, so a lapsed web order
  -- correctly leaves the customer on 24 hours next time.
  --
  -- Forfeited and final_forfeited layaways COUNT as returning: money changed
  -- hands, the relationship is real, and only the plan ended badly.
  --
  -- A brand-new customer row (no id, or no orders) is new. That covers the
  -- customer the FAQ calls a guest: /checkout is behind sign-in, so by the time
  -- an order can be created the row exists — either freshly created, which is
  -- new, or matched by email to a CSR- or live-selling-created row, which
  -- correctly reads as returning.
  --
  -- RESERVE-FIRST (A1): p_exclude_order leaves the order being confirmed out
  -- of its own count, so confirming a first order still gives 24 hours.
  SELECT CASE
    WHEN p_customer_id IS NULL THEN 24
    WHEN EXISTS (
      SELECT 1 FROM public.cash_orders o
       WHERE o.customer_id = p_customer_id
         AND o.status::text NOT IN ('cancelled', 'expired')
         AND o.id IS DISTINCT FROM p_exclude_order
    ) OR EXISTS (
      SELECT 1 FROM public.layaway_accounts a
       WHERE a.customer_id = p_customer_id
         AND a.status::text <> 'cancelled'
         AND a.id IS DISTINCT FROM p_exclude_order
    ) THEN 72
    ELSE 24
  END;
$$;

COMMENT ON FUNCTION public.web_deposit_deadline_hours(uuid, uuid) IS
  'Hours a web customer has to send the deposit: 24 on a first order, 72 when they have a prior non-cancelled order of either kind. p_exclude_order leaves one order (the one being confirmed) out of the count. The single source for this rule — the creation RPCs, confirm_web_order_ready_atomic, revive_web_cash_order_atomic and the website edge function all read it.';

SELECT pg_temp._a1_carry_acl('web_deposit_deadline_hours', 'public.web_deposit_deadline_hours(uuid,uuid)'::regprocedure);

-- --------------------------------------------- 4. create_web_order_atomic(+p_reserve)
-- Recorded live body + RESERVE-FIRST (A1) edits. With p_reserve false every
-- written value is what it was, plus ready_confirmed_at = now(); the result
-- JSON gains 'reserved': true only when p_reserve is true.
DROP FUNCTION public.create_web_order_atomic(uuid, uuid, text, text);

CREATE FUNCTION public.create_web_order_atomic(p_customer_id uuid, p_quote_id uuid, p_method text, p_lang text DEFAULT NULL::text, p_reserve boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_quote        public.checkout_quotes%ROWTYPE;
  v_item         jsonb;
  v_variant      public.website_product_variants%ROWTYPE;
  v_qty          integer;
  v_updated      integer;
  v_seq          bigint;
  v_invoice      text;
  v_reference    text;
  v_order_id     uuid;
  v_currency     text := 'JPY';
  -- RESERVE-FIRST (A1): a reservation has NO payment deadline until staff
  -- confirm it ready for dispatch (confirm_web_order_ready_atomic starts it).
  v_due          timestamptz := CASE WHEN p_reserve THEN NULL
                                     ELSE now() + make_interval(hours => public.web_deposit_deadline_hours(p_customer_id)) END;
  v_title        text;
  v_lang         text := CASE WHEN p_lang IN ('ja','en') THEN p_lang ELSE NULL END;
BEGIN
  IF p_method IS DISTINCT FROM 'transfer' THEN
    RETURN jsonb_build_object('error', 'unsupported_method');
  END IF;

  -- Lock the quote so a double-submit cannot produce two orders from it.
  SELECT * INTO v_quote FROM public.checkout_quotes
    WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.customer_id <> p_customer_id THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'quote_already_used');
  END IF;
  IF v_quote.expires_at <= now() THEN
    RETURN jsonb_build_object('error', 'quote_expired');
  END IF;
  IF v_quote.mode <> 'full' THEN
    RETURN jsonb_build_object('error', 'layaway_not_yet');
  END IF;
  IF v_quote.shipping_jpy IS NULL THEN
    RETURN jsonb_build_object('error', 'shipping_quote_required');
  END IF;
  IF v_quote.total_jpy <= 0 THEN
    RETURN jsonb_build_object('error', 'empty_quote');
  END IF;

  v_seq       := nextval('public.web_order_number_seq');
  v_invoice   := v_seq::text;
  v_reference := 'CJ-W-' || lpad(v_seq::text, 6, '0');

  INSERT INTO public.cash_orders (
    invoice_number, customer_id, currency, total_amount, total_paid,
    remaining_balance, status, source_channel, order_type, payment_method,
    payment_status, ship_to_address_id, ship_to_snapshot, recipient_name, recipient_phone,
    gift_note, quote_id, web_reference, transfer_due_at, expires_at, shipping_fee,
    loyalty_jpy_amount, item_description, order_date, customer_lang,
    ready_confirmed_at
  ) VALUES (
    v_invoice, p_customer_id, v_currency::account_currency, v_quote.total_jpy, 0,
    v_quote.total_jpy, 'pending'::cash_order_status, 'web', v_quote.order_type, 'transfer',
    CASE WHEN p_reserve THEN 'awaiting_confirmation' ELSE 'pending_transfer' END, v_quote.ship_to_address_id,
    -- The address AS IT WAS, so editing the address book later cannot move
    -- where this order was sent. The FK beside it stays a convenience link.
    public.address_snapshot(v_quote.ship_to_address_id),
    v_quote.recipient_name, v_quote.recipient_phone,
    -- expires_at = transfer_due_at: the 72-hour deadline is what the expiry cron reads.
    v_quote.gift_note, v_quote.id, v_reference, v_due, v_due, COALESCE(v_quote.shipping_jpy, 0),
    -- Loyalty basis is the PRODUCT amount only: shipping never earns points.
    v_quote.subtotal_jpy, 'Website order ' || v_reference, CURRENT_DATE, v_lang,
    -- A non-reserved order is ready from the moment it exists; a reservation
    -- waits for staff (NULL = awaiting confirmation).
    CASE WHEN p_reserve THEN NULL ELSE now() END
  ) RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_quote.items) LOOP
    v_qty := GREATEST(COALESCE((v_item->>'qty')::int, 1), 1);

    SELECT * INTO v_variant FROM public.website_product_variants
      WHERE id = (v_item->>'variant_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'variant_missing:%', v_item->>'variant_id';
    END IF;

    UPDATE public.website_product_variants
       SET stock_qty = stock_qty - v_qty, updated_at = now()
     WHERE id = v_variant.id AND stock_qty >= v_qty;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RAISE EXCEPTION 'out_of_stock:%', v_variant.id;
    END IF;

    SELECT trim(both ' ' FROM
             p.name ||
             COALESCE(' / ' || NULLIF(v_variant.size, ''), '') ||
             COALESCE(' / ' || NULLIF(v_variant.stone, ''), ''))
      INTO v_title
      FROM public.website_products p WHERE p.id = v_variant.product_id;

    -- website_product_id, NOT product_id: product_id is the Shopify FK
    -- (public.products) and a website_products id violates it (Bug #266).
    INSERT INTO public.cash_order_items (
      cash_order_id, website_product_id, variant_id, title, sku, quantity,
      unit_price_jpy, line_total_jpy
    ) VALUES (
      v_order_id, v_variant.product_id, v_variant.id,
      COALESCE(v_title, 'Item'),
      (SELECT p.sku FROM public.website_products p WHERE p.id = v_variant.product_id),
      v_qty, v_variant.price_jpy, v_variant.price_jpy * v_qty
    );
  END LOOP;

  UPDATE public.checkout_quotes SET consumed_at = now() WHERE id = v_quote.id;

  RETURN jsonb_build_object(
    'ok', true,
    'order_id', v_order_id,
    'web_reference', v_reference,
    'invoice_number', v_invoice,
    'total_jpy', v_quote.total_jpy,
    'transfer_due_at', v_due
  ) || CASE WHEN p_reserve THEN jsonb_build_object('reserved', true) ELSE '{}'::jsonb END;
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM LIKE 'out_of_stock:%' THEN
      RETURN jsonb_build_object('error', 'out_of_stock', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'variant_missing:%' THEN
      RETURN jsonb_build_object('error', 'variant_missing', 'variant_id', split_part(SQLERRM, ':', 2));
    END IF;
    RAISE;
END $function$;


COMMENT ON FUNCTION public.create_web_order_atomic(uuid, uuid, text, text, boolean) IS
  'Sole writer of a web (full-payment) cash order. Consumes a checkout quote, inserts the order and its item lines and decrements stock, one transaction. p_reserve true (reserve-first) creates a RESERVATION: no deadline, payment_status awaiting_confirmation, ready_confirmed_at NULL until confirm_web_order_ready_atomic.';

SELECT pg_temp._a1_carry_acl('create_web_order_atomic', 'public.create_web_order_atomic(uuid,uuid,text,text,boolean)'::regprocedure);

-- ------------------------------------------- 5. create_web_layaway_atomic(+p_reserve)
DROP FUNCTION public.create_web_layaway_atomic(uuid, uuid, text, timestamptz, date, text, timestamptz);

CREATE FUNCTION public.create_web_layaway_atomic(
  p_customer_id uuid,
  p_quote_id uuid,
  p_lang text DEFAULT NULL::text,
  p_transfer_due_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_order_date date DEFAULT NULL::date,
  p_agreement_version text DEFAULT NULL::text,
  p_agreement_signed_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_reserve boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_quote      public.checkout_quotes%ROWTYPE;
  v_item       jsonb;
  v_variant    public.website_product_variants%ROWTYPE;
  v_qty        integer;
  v_updated    integer;
  v_seq        bigint;
  v_invoice    text;
  v_reference  text;
  v_account_id uuid;
  v_lang       text := CASE WHEN p_lang IN ('ja','en') THEN p_lang ELSE NULL END;
  v_cur        text;
  v_rate       numeric;
  v_total      integer;
  v_shipping   integer;
  v_subtotal   integer;
  v_quote_out  jsonb;
  v_term       integer;
  v_deposit    integer;
  v_due        timestamptz;
  v_end_date   date;
  v_title      text;
  v_row        jsonb;
  v_order_date date := COALESCE(p_order_date, CURRENT_DATE);
  -- Blank is the same as absent: an empty string must not become a stored
  -- version nobody can match against the agreement file.
  v_agr_ver    text := nullif(btrim(coalesce(p_agreement_version, '')), '');
BEGIN
  SELECT * INTO v_quote FROM public.checkout_quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.customer_id <> p_customer_id THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'quote_already_used');
  END IF;
  IF v_quote.expires_at <= now() THEN
    RETURN jsonb_build_object('error', 'quote_expired');
  END IF;
  IF v_quote.mode <> 'layaway' THEN
    RETURN jsonb_build_object('error', 'not_a_layaway_quote');
  END IF;
  IF v_quote.shipping_jpy IS NULL THEN
    RETURN jsonb_build_object('error', 'shipping_quote_required');
  END IF;
  IF coalesce(v_quote.total_jpy, 0) <= 0 THEN
    RETURN jsonb_build_object('error', 'empty_quote');
  END IF;

  v_cur := coalesce(v_quote.settlement_currency, 'JPY');
  IF v_cur = 'PHP' THEN
    v_rate := v_quote.fx_rate;
    IF v_rate IS NULL OR v_rate <= 0 THEN
      RETURN jsonb_build_object('error', 'fx_rate_missing');
    END IF;
    v_total    := round(v_quote.total_jpy * v_rate);
    v_shipping := round(coalesce(v_quote.shipping_jpy, 0) * v_rate);
    v_subtotal := v_total - v_shipping;
  ELSE
    v_rate     := NULL;
    v_total    := v_quote.total_jpy;
    v_shipping := coalesce(v_quote.shipping_jpy, 0);
    v_subtotal := v_total - v_shipping;
  END IF;

  v_quote_out := public.layaway_quote(
    v_subtotal, v_quote.term_months, v_cur, v_order_date, v_shipping, 0
  );
  IF NOT coalesce((v_quote_out->>'eligible')::boolean, false)
     OR coalesce((v_quote_out->>'term_downgraded')::boolean, false) THEN
    RETURN jsonb_build_object(
      'error', 'below_plan_minimum',
      'total', v_total,
      'currency', v_cur,
      'requested_term_months', v_quote.term_months,
      'max_term_months', v_quote_out->'max_term_months'
    );
  END IF;
  v_term    := (v_quote_out->>'term_months')::integer;
  v_deposit := (v_quote_out->>'deposit')::integer;

  -- RESERVE-FIRST (A1): a reservation has NO deposit deadline until staff
  -- confirm it ready for dispatch; confirm_web_order_ready_atomic starts the
  -- deadline and re-anchors this schedule to the confirmation date.
  IF p_reserve THEN
    v_due := NULL;
  ELSE
    v_due := coalesce(p_transfer_due_at, now() + make_interval(hours => public.web_deposit_deadline_hours(p_customer_id)));
  END IF;
  SELECT max((s->>'due_date')::date) INTO v_end_date
    FROM jsonb_array_elements(v_quote_out->'schedule') s;

  -- THE NUMBER WAS RESERVED WHEN THE QUOTE WAS CREATED (reserved_invoice_seq,
  -- drawn by trg_checkout_quotes_reserve_invoice) so the agreement could be
  -- signed against the final invoice number before this plan existed. The
  -- coalesce covers quotes created before migration 20260918120000, which
  -- carry NULL and draw here exactly as they always did.
  v_seq       := coalesce(v_quote.reserved_invoice_seq, nextval('public.web_order_number_seq'));
  v_invoice   := v_seq::text;
  v_reference := 'CJ-W-' || lpad(v_seq::text, 6, '0');

  INSERT INTO public.layaway_accounts (
    invoice_number, customer_id, currency, total_amount, payment_plan_months,
    order_date, end_date, status, total_paid, remaining_balance,
    downpayment_amount, loyalty_jpy_amount, shipping_fee,
    source_channel, web_reference, quote_id, transfer_due_at, ship_to_snapshot,
    customer_lang, fx_rate_used, fx_rate_date, notes,
    -- THE AGREEMENT THE CUSTOMER SIGNED. Verified by the storefront against the
    -- signing record before this call; stored as given, never invented here.
    agreement_version, agreement_acceptance_date,
    ready_confirmed_at
  ) VALUES (
    v_invoice, p_customer_id, v_cur::account_currency, v_total, v_term,
    v_order_date, v_end_date, 'active', 0, v_total,
    v_deposit,
    -- LOYALTY BASE: the PRODUCT amount, in YEN, always.
    v_quote.subtotal_jpy,
    v_shipping,
    'web', v_reference, v_quote.id, v_due,
    -- layaway_accounts has no ship_to_address_id: this snapshot, resolved
    -- through the quote, is the only delivery address the plan carries.
    public.address_snapshot(v_quote.ship_to_address_id),
    v_lang, v_rate, v_quote.fx_rate_date,
    'Website layaway ' || v_reference,
    v_agr_ver, p_agreement_signed_at,
    -- NULL = awaiting staff confirmation (reservation); otherwise ready now.
    CASE WHEN p_reserve THEN NULL ELSE now() END
  ) RETURNING id INTO v_account_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_quote_out->'schedule') LOOP
    INSERT INTO public.layaway_schedule (
      account_id, installment_number, due_date, base_installment_amount,
      penalty_amount, total_due_amount, paid_amount, currency, status
    ) VALUES (
      v_account_id,
      (v_row->>'installment_number')::integer,
      (v_row->>'due_date')::date,
      (v_row->>'amount')::numeric,
      0,
      (v_row->>'amount')::numeric,
      0,
      v_cur::account_currency,
      'pending'
    );
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_quote.items) LOOP
    v_qty := GREATEST(COALESCE((v_item->>'qty')::int, 1), 1);

    SELECT * INTO v_variant FROM public.website_product_variants
      WHERE id = (v_item->>'variant_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'variant_missing:%', v_item->>'variant_id';
    END IF;

    UPDATE public.website_product_variants
       SET stock_qty = stock_qty - v_qty, updated_at = now()
     WHERE id = v_variant.id AND stock_qty >= v_qty;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RAISE EXCEPTION 'out_of_stock:%', v_variant.id;
    END IF;

    SELECT trim(both ' ' FROM
             p.name ||
             COALESCE(' / ' || NULLIF(v_variant.size, ''), '') ||
             COALESCE(' / ' || NULLIF(v_variant.stone, ''), ''))
      INTO v_title
      FROM public.website_products p WHERE p.id = v_variant.product_id;

    INSERT INTO public.layaway_account_items (
      account_id, website_product_id, variant_id, title, sku, quantity,
      unit_price_jpy, line_total_jpy
    ) VALUES (
      v_account_id, v_variant.product_id, v_variant.id,
      COALESCE(v_title, 'Item'),
      (SELECT p.sku FROM public.website_products p WHERE p.id = v_variant.product_id),
      v_qty,
      v_variant.price_jpy, v_variant.price_jpy * v_qty
    );
  END LOOP;

  UPDATE public.checkout_quotes SET consumed_at = now() WHERE id = v_quote.id;

  RETURN jsonb_build_object(
    'ok', true,
    'account_id', v_account_id,
    'web_reference', v_reference,
    'invoice_number', v_invoice,
    'currency', v_cur,
    'total', v_total,
    'deposit', v_deposit,
    'term_months', v_term,
    'schedule', v_quote_out->'schedule',
    'transfer_due_at', v_due,
    'loyalty_jpy_amount', v_quote.subtotal_jpy,
    'fx_rate', v_rate,
    -- Echoed so the caller can see what was actually stored rather than
    -- assuming its own input survived.
    'agreement_version', v_agr_ver,
    'agreement_acceptance_date', p_agreement_signed_at
  ) || CASE WHEN p_reserve THEN jsonb_build_object('reserved', true) ELSE '{}'::jsonb END;
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM LIKE 'out_of_stock:%' THEN
      RETURN jsonb_build_object('error', 'out_of_stock', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'variant_missing:%' THEN
      RETURN jsonb_build_object('error', 'variant_missing', 'variant_id', split_part(SQLERRM, ':', 2));
    END IF;
    RAISE;
END $function$;


COMMENT ON FUNCTION public.create_web_layaway_atomic(uuid, uuid, text, timestamp with time zone, date, text, timestamp with time zone, boolean) IS
  'Sole writer of a web layaway plan. Consumes a checkout quote, recomputes the plan from layaway_quote, inserts account + schedule + item lines, decrements stock, and records the agreement version and signing timestamp the storefront verified. Uses the invoice number reserved on the quote (reserved_invoice_seq) when present. One transaction. p_reserve true (reserve-first) creates a RESERVATION: no deposit deadline, ready_confirmed_at NULL; confirm_web_order_ready_atomic starts the deadline and re-anchors the schedule to the confirmation date.';

SELECT pg_temp._a1_carry_acl('create_web_layaway_atomic', 'public.create_web_layaway_atomic(uuid,uuid,text,timestamptz,date,text,timestamptz,boolean)'::regprocedure);

-- ---------------------------------------------------- 6. set_account_deadlines
-- Same signature, so CREATE OR REPLACE keeps its grants. Recorded live body +
-- one refusal: a web reservation not yet confirmed has no deadline to move
-- ('not_ready').
CREATE OR REPLACE FUNCTION public.set_account_deadlines(
  p_entity_type     text,
  p_entity_id       uuid,
  p_transfer_due_at timestamptz,
  p_reason          text DEFAULT NULL,
  p_user_id         uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_old  jsonb;
  v_new  jsonb;
  v_status text;
  v_paid numeric;
  v_channel text;
  v_ready timestamptz;
BEGIN
  IF p_entity_type NOT IN ('layaway', 'cash_order') THEN
    RETURN jsonb_build_object('error', 'bad_entity_type');
  END IF;

  -- A deadline is moved, never removed (20260915140000).
  IF p_transfer_due_at IS NULL THEN
    RETURN jsonb_build_object('error', 'deadline_required');
  END IF;

  IF p_entity_type = 'layaway' THEN
    SELECT status::text, total_paid,
           jsonb_build_object('transfer_due_at', transfer_due_at),
           source_channel, ready_confirmed_at
      INTO v_status, v_paid, v_old, v_channel, v_ready
      FROM public.layaway_accounts WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    -- Live only. 'cancelled', 'completed', 'forfeited', 'final_forfeited' and
    -- 'final_settlement' are endings, not states a new deadline can reopen.
    IF v_status NOT IN ('active', 'overdue', 'extension_active', 'reactivated') THEN
      RETURN jsonb_build_object('error', 'not_live', 'status', v_status);
    END IF;

    -- RESERVE-FIRST (A1): a web reservation has no deadline to move until staff
    -- confirm it ready for dispatch. Confirming is what starts the deadline.
    IF v_channel = 'web' AND v_ready IS NULL THEN
      RETURN jsonb_build_object('error', 'not_ready');
    END IF;

    -- Money received ends this deadline's job, and 'active' does not say so.
    -- Both places it can show, exactly as expire_web_layaway_atomic checks them.
    IF coalesce(v_paid, 0) > 0 THEN
      RETURN jsonb_build_object('error', 'already_paid', 'total_paid', v_paid);
    END IF;
    IF EXISTS (SELECT 1 FROM public.payments
                WHERE account_id = p_entity_id AND voided_at IS NULL) THEN
      RETURN jsonb_build_object('error', 'payment_exists');
    END IF;

    UPDATE public.layaway_accounts
       SET transfer_due_at = p_transfer_due_at,
           updated_at      = now()
     WHERE id = p_entity_id;

    v_new := jsonb_build_object('transfer_due_at', p_transfer_due_at);
  ELSE
    SELECT status::text,
           jsonb_build_object('transfer_due_at', transfer_due_at, 'expires_at', expires_at),
           source_channel, ready_confirmed_at
      INTO v_status, v_old, v_channel, v_ready
      FROM public.cash_orders WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    IF v_status <> 'pending' THEN
      RETURN jsonb_build_object('error', 'not_live', 'status', v_status);
    END IF;
    -- RESERVE-FIRST (A1): same refusal as the layaway branch.
    IF v_channel = 'web' AND v_ready IS NULL THEN
      RETURN jsonb_build_object('error', 'not_ready');
    END IF;
    -- No already_paid test here. See the header: a partially-paid pending cash
    -- order still expires, so its deadline is still live and still moveable.

    -- BOTH columns, deliberately. create_web_order_atomic writes the same value
    -- to each and the expiry cron reads expires_at; moving only transfer_due_at
    -- would show the customer a new deadline while the cron still cancelled on
    -- the old one.
    UPDATE public.cash_orders
       SET transfer_due_at = p_transfer_due_at,
           expires_at      = p_transfer_due_at,
           updated_at      = now()
     WHERE id = p_entity_id;

    v_new := jsonb_build_object('transfer_due_at', p_transfer_due_at, 'expires_at', p_transfer_due_at);
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES (CASE WHEN p_entity_type = 'layaway' THEN 'layaway_account' ELSE 'cash_order' END,
          p_entity_id, 'deadlines_updated', v_old,
          v_new || jsonb_build_object('reason', p_reason),
          COALESCE(p_user_id, auth.uid()));

  RETURN jsonb_build_object(
    'ok', true, 'old', v_old, 'new', v_new,
    -- Observation A: the caller is told when it has just armed the hourly job.
    'deadline_in_past', p_transfer_due_at < now());
END $function$;


-- ------------------------------------------- 7. confirm_web_order_ready_atomic
CREATE FUNCTION public.confirm_web_order_ready_atomic(
  p_entity_type text,
  p_entity_id   uuid,
  p_user_id     uuid,
  p_note        text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now       timestamptz := now();
  v_note      text := nullif(btrim(coalesce(p_note, '')), '');
  v_status    text;
  v_channel   text;
  v_ready     timestamptz;
  v_customer  uuid;
  v_invoice   text;
  v_web_ref   text;
  v_pstatus   text;
  v_paid      numeric;
  v_hours     integer;
  v_due       timestamptz;
  v_old_order date;
  v_old_end   date;
  v_anchor    date;
  v_row       record;
  v_new_due   date;
  v_end       date;
  v_moved     integer := 0;
  v_schedule  jsonb;
BEGIN
  IF p_entity_type NOT IN ('cash_order', 'layaway') THEN
    RETURN jsonb_build_object('error', 'bad_entity_type');
  END IF;
  -- Permission is decided HERE, not only by the caller: the edge function
  -- passes the signed-in user, and a service-role call without one is refused.
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'user_identity_required');
  END IF;
  IF NOT public.has_permission(p_user_id, 'confirm_web_order_ready') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;

  IF p_entity_type = 'cash_order' THEN
    SELECT status::text, source_channel, ready_confirmed_at, customer_id,
           invoice_number, web_reference, payment_status
      INTO v_status, v_channel, v_ready, v_customer, v_invoice, v_web_ref, v_pstatus
      FROM public.cash_orders WHERE id = p_entity_id
       FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    IF v_channel IS DISTINCT FROM 'web' THEN
      RETURN jsonb_build_object('error', 'not_web_order');
    END IF;
    IF v_ready IS NOT NULL THEN
      RETURN jsonb_build_object('error', 'already_confirmed', 'ready_confirmed_at', v_ready);
    END IF;
    IF v_status <> 'pending' THEN
      RETURN jsonb_build_object('error', 'not_live', 'status', v_status);
    END IF;

    -- The deadline starts now, by the one rule, with THIS order left out of
    -- the customer's history.
    v_hours := public.web_deposit_deadline_hours(v_customer, p_entity_id);
    v_due   := v_now + make_interval(hours => v_hours);

    -- Both deadline columns, as create_web_order_atomic and
    -- set_account_deadlines write them: the hourly job reads expires_at.
    UPDATE public.cash_orders
       SET ready_confirmed_at = v_now,
           ready_confirmed_by = p_user_id,
           payment_status     = 'pending_transfer',
           transfer_due_at    = v_due,
           expires_at         = v_due,
           updated_at         = v_now
     WHERE id = p_entity_id;

    INSERT INTO public.audit_logs (entity_type, entity_id, action,
                                   old_value_json, new_value_json, performed_by_user_id)
    VALUES ('cash_order', p_entity_id, 'web_order_ready_confirmed',
            jsonb_build_object('payment_status', v_pstatus, 'ready_confirmed_at', NULL),
            jsonb_build_object('payment_status', 'pending_transfer',
                               'ready_confirmed_at', v_now,
                               'transfer_due_at', v_due, 'expires_at', v_due,
                               'deadline_hours', v_hours,
                               'invoice_number', v_invoice, 'web_reference', v_web_ref,
                               'note', v_note),
            p_user_id);

    RETURN jsonb_build_object('ok', true, 'entity_type', 'cash_order', 'id', p_entity_id,
                              'invoice_number', v_invoice, 'web_reference', v_web_ref,
                              'customer_id', v_customer,
                              'ready_confirmed_at', v_now,
                              'transfer_due_at', v_due, 'deadline_hours', v_hours);
  END IF;

  -- ------------------------------------------------------------- layaway
  SELECT status::text, source_channel, ready_confirmed_at, customer_id,
         invoice_number, web_reference, total_paid, order_date, end_date
    INTO v_status, v_channel, v_ready, v_customer, v_invoice, v_web_ref,
         v_paid, v_old_order, v_old_end
    FROM public.layaway_accounts WHERE id = p_entity_id
     FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_channel IS DISTINCT FROM 'web' THEN
    RETURN jsonb_build_object('error', 'not_web_layaway');
  END IF;
  IF v_ready IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'already_confirmed', 'ready_confirmed_at', v_ready);
  END IF;
  IF v_status <> 'active' THEN
    RETURN jsonb_build_object('error', 'not_live', 'status', v_status);
  END IF;

  -- A reservation has shown no payment details, so no money can be on it.
  -- If some is, re-dating the schedule under it would be wrong: refuse, with
  -- the same two tests (cache, then ledger) expire_web_layaway_atomic makes.
  IF coalesce(v_paid, 0) > 0 THEN
    RETURN jsonb_build_object('error', 'already_paid', 'total_paid', v_paid);
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments
              WHERE account_id = p_entity_id AND voided_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'payment_exists');
  END IF;
  -- Only an untouched schedule is re-dated.
  IF EXISTS (SELECT 1 FROM public.layaway_schedule
              WHERE account_id = p_entity_id AND status <> 'cancelled'
                AND (status <> 'pending'
                     OR coalesce(paid_amount, 0) <> 0
                     OR coalesce(penalty_amount, 0) <> 0
                     OR coalesce(carried_amount, 0) <> 0))
     OR EXISTS (SELECT 1 FROM public.penalty_fees WHERE account_id = p_entity_id) THEN
    RETURN jsonb_build_object('error', 'schedule_not_pristine');
  END IF;

  v_hours  := public.web_deposit_deadline_hours(v_customer, p_entity_id);
  v_due    := v_now + make_interval(hours => v_hours);
  v_anchor := (v_now AT TIME ZONE 'Asia/Manila')::date;   -- TIMEZONE STANDARD: PHT day

  -- Installment n is due order_date + n months — the same expression
  -- layaway_quote uses, so the four-place rule still agrees after the move.
  -- One row per statement, earliest first: trg_validate_schedule_chronology
  -- compares each row only with the installment before it, which by then has
  -- already moved, so every step is in order whichever way the dates shift.
  FOR v_row IN
    SELECT id, installment_number, due_date
      FROM public.layaway_schedule
     WHERE account_id = p_entity_id AND status <> 'cancelled'
     ORDER BY installment_number
  LOOP
    v_new_due := (v_anchor + make_interval(months => v_row.installment_number))::date;
    IF v_new_due IS DISTINCT FROM v_row.due_date THEN
      UPDATE public.layaway_schedule
         SET due_date = v_new_due, updated_at = v_now
       WHERE id = v_row.id;
      INSERT INTO public.schedule_audit_log (account_id, schedule_id, admin_user_id, action,
                                             field_changed, old_value, new_value, reason)
      VALUES (p_entity_id, v_row.id, p_user_id, 'web_ready_reanchor', 'due_date',
              v_row.due_date::text, v_new_due::text,
              coalesce(v_note, 'Web layaway confirmed ready for dispatch — schedule starts from the confirmation date'));
      v_moved := v_moved + 1;
    END IF;
  END LOOP;

  SELECT max(due_date),
         jsonb_agg(jsonb_build_object('installment_number', installment_number,
                                      'due_date', due_date,
                                      'amount', base_installment_amount)
                   ORDER BY installment_number)
    INTO v_end, v_schedule
    FROM public.layaway_schedule
   WHERE account_id = p_entity_id AND status <> 'cancelled';

  UPDATE public.layaway_accounts
     SET ready_confirmed_at = v_now,
         ready_confirmed_by = p_user_id,
         transfer_due_at    = v_due,
         order_date         = v_anchor,
         end_date           = coalesce(v_end, end_date),
         updated_at         = v_now
   WHERE id = p_entity_id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action,
                                 old_value_json, new_value_json, performed_by_user_id)
  VALUES ('layaway_account', p_entity_id, 'web_layaway_ready_confirmed',
          jsonb_build_object('ready_confirmed_at', NULL, 'transfer_due_at', NULL,
                             'order_date', v_old_order, 'end_date', v_old_end),
          jsonb_build_object('ready_confirmed_at', v_now,
                             'transfer_due_at', v_due, 'deadline_hours', v_hours,
                             'order_date', v_anchor, 'end_date', coalesce(v_end, v_old_end),
                             'schedule_rows_reanchored', v_moved,
                             'invoice_number', v_invoice, 'web_reference', v_web_ref,
                             'note', v_note),
          p_user_id);

  RETURN jsonb_build_object('ok', true, 'entity_type', 'layaway', 'id', p_entity_id,
                            'invoice_number', v_invoice, 'web_reference', v_web_ref,
                            'customer_id', v_customer,
                            'ready_confirmed_at', v_now,
                            'transfer_due_at', v_due, 'deadline_hours', v_hours,
                            'order_date', v_anchor, 'end_date', coalesce(v_end, v_old_end),
                            'schedule_rows_reanchored', v_moved,
                            'schedule', v_schedule);
END $function$;

COMMENT ON FUNCTION public.confirm_web_order_ready_atomic(text, uuid, uuid, text) IS
  'Reserve-first: staff confirm a WEB reservation ready for dispatch. Requires has_permission(p_user_id, ''confirm_web_order_ready''). Web, live and unconfirmed only. Stamps ready_confirmed_at/by and starts the payment deadline from web_deposit_deadline_hours (this order excluded). Cash: payment_status -> pending_transfer, transfer_due_at = expires_at. Layaway (no money received, untouched schedule only): order_date -> confirmation date (PHT) and every open installment re-dated to order_date + n months, each logged to schedule_audit_log. One audit_logs row. One transaction.';

-- ---------------------------------- 8. decline_web_layaway_reservation_atomic
-- "Can't supply" for a web layaway reservation, and the layaway half of the
-- 72-hour sweep (p_source 'system'). Mirrors expire_web_layaway_atomic's writes
-- — status 'cancelled', open schedule rows 'cancelled', the stock back on sale
-- once — without stamping expired_at: a declined plan did not lapse, and
-- reactivate_web_layaway_atomic (which revives only lapsed plans) must never
-- bring it back. The cash counterpart is terminate_web_order_atomic
-- ('cancelled'), unchanged.
CREATE FUNCTION public.decline_web_layaway_reservation_atomic(
  p_account_id uuid,
  p_reason     text,
  p_user_id    uuid DEFAULT NULL::uuid,
  p_source     text DEFAULT 'staff'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_reason    text := nullif(btrim(coalesce(p_reason, '')), '');
  v_is_system boolean := (p_source = 'system');
  v_status    text;
  v_channel   text;
  v_ready     timestamptz;
  v_customer  uuid;
  v_invoice   text;
  v_web_ref   text;
  v_paid      numeric;
  v_cancelled integer := 0;
  v_restored  integer := 0;
  v_now       timestamptz := now();
BEGIN
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  IF NOT v_is_system THEN
    IF p_user_id IS NULL THEN
      RETURN jsonb_build_object('error', 'user_identity_required');
    END IF;
    IF NOT public.has_permission(p_user_id, 'confirm_web_order_ready') THEN
      RETURN jsonb_build_object('error', 'permission_denied');
    END IF;
  END IF;

  SELECT status::text, source_channel, ready_confirmed_at, customer_id,
         invoice_number, web_reference, total_paid
    INTO v_status, v_channel, v_ready, v_customer, v_invoice, v_web_ref, v_paid
    FROM public.layaway_accounts WHERE id = p_account_id
     FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_channel IS DISTINCT FROM 'web' THEN
    RETURN jsonb_build_object('error', 'not_web_layaway');
  END IF;
  IF v_ready IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'already_confirmed', 'ready_confirmed_at', v_ready);
  END IF;
  IF v_status <> 'active' THEN
    RETURN jsonb_build_object('error', 'not_live', 'status', v_status);
  END IF;
  IF coalesce(v_paid, 0) > 0 THEN
    RETURN jsonb_build_object('error', 'already_paid', 'total_paid', v_paid);
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments
              WHERE account_id = p_account_id AND voided_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'payment_exists');
  END IF;
  -- INVARIANT 12: automation stands down while a submission awaits review.
  -- A staff decline is a person acting deliberately and is not blocked.
  IF v_is_system AND EXISTS (
       SELECT 1 FROM public.payment_submissions
        WHERE account_id = p_account_id
          AND status IN ('submitted', 'under_review')) THEN
    RETURN jsonb_build_object('error', 'submission_pending');
  END IF;

  UPDATE public.layaway_accounts
     SET status     = 'cancelled',
         updated_at = v_now,
         notes      = COALESCE(notes || E'\n', '')
                      || CASE WHEN v_is_system THEN 'Reservation auto-cancelled ' ELSE 'Reservation declined ' END
                      || to_char(v_now AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI')
                      || ' PHT — ' || v_reason
   WHERE id = p_account_id;

  UPDATE public.layaway_schedule
     SET status = 'cancelled', updated_at = v_now
   WHERE account_id = p_account_id AND status IN ('pending', 'overdue');
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  -- Stock back on sale, once: the status flip above is the guard.
  WITH restored AS (
    UPDATE public.website_product_variants v
       SET stock_qty = v.stock_qty + i.quantity, updated_at = v_now
      FROM public.layaway_account_items i
     WHERE i.account_id = p_account_id AND v.id = i.variant_id
     RETURNING v.id
  )
  SELECT count(*) INTO v_restored FROM restored;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('layaway_account', p_account_id,
          CASE WHEN v_is_system THEN 'web_layaway_reservation_expired' ELSE 'web_layaway_reservation_declined' END,
          jsonb_build_object('invoice_number', v_invoice, 'web_reference', v_web_ref,
                             'reason', v_reason, 'prior_status', v_status,
                             'schedule_rows_cancelled', v_cancelled,
                             'stock_lines_restored', v_restored,
                             'source', p_source),
          p_user_id);

  RETURN jsonb_build_object('ok', true, 'account_id', p_account_id,
                            'invoice_number', v_invoice, 'web_reference', v_web_ref,
                            'customer_id', v_customer,
                            'schedule_rows_cancelled', v_cancelled,
                            'stock_lines_restored', v_restored);
END $function$;

COMMENT ON FUNCTION public.decline_web_layaway_reservation_atomic(uuid, text, uuid, text) IS
  'Reserve-first: cancel a WEB layaway reservation that was never confirmed ready ("can''t supply", or p_source ''system'' from the 72-hour sweep). Reason required; staff callers need confirm_web_order_ready. Refuses once confirmed, once money is on it, and (system only) while a submission awaits review. Status cancelled, open schedule cancelled, stock returned once, audit row. expired_at is NOT stamped, so reactivate_web_layaway_atomic cannot revive it. One transaction.';

-- ------------------------------ 9. expire_unconfirmed_web_reservations_atomic
-- Cancels web reservations nobody confirmed within p_hours (default 72) of
-- creation and returns their stock. Reuses the two writers above so there is
-- one code path per table: terminate_web_order_atomic ('cancelled', source
-- 'system') for cash, decline_web_layaway_reservation_atomic (source
-- 'system') for layaways. Each order runs in its own subtransaction, so one
-- refusal or error never stops the batch; it is reported under 'skipped'.
-- Returns what it cancelled with enough to email the customer — the A2 edge
-- function sends the emails and owns the schedule. Never touches a confirmed
-- order, a Hub order, or one with money on it.
CREATE FUNCTION public.expire_unconfirmed_web_reservations_atomic(
  p_hours integer DEFAULT 72,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cutoff  timestamptz := now() - make_interval(hours => GREATEST(coalesce(p_hours, 72), 1));
  v_reason  text := format('Not confirmed ready for dispatch within %s hours (auto-cancelled)',
                           GREATEST(coalesce(p_hours, 72), 1));
  v_limit   integer := GREATEST(coalesce(p_limit, 100), 1);
  r         record;
  v_r       jsonb;
  v_cash    jsonb := '[]'::jsonb;
  v_lay     jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
BEGIN
  FOR r IN
    SELECT o.id, o.invoice_number, o.web_reference, o.customer_id, o.customer_lang,
           o.total_paid, o.created_at
      FROM public.cash_orders o
     WHERE o.source_channel = 'web' AND o.status = 'pending'
       AND o.ready_confirmed_at IS NULL AND o.created_at < v_cutoff
     ORDER BY o.created_at
     LIMIT v_limit
  LOOP
    IF coalesce(r.total_paid, 0) > 0 OR EXISTS (
         SELECT 1 FROM public.cash_payments
          WHERE cash_order_id = r.id AND voided_at IS NULL) THEN
      v_skipped := v_skipped || jsonb_build_object('entity_type', 'cash_order', 'id', r.id,
                                                   'invoice_number', r.invoice_number,
                                                   'reason', 'money_received');
      CONTINUE;
    END IF;
    BEGIN
      v_r := public.terminate_web_order_atomic(r.id, 'cancelled', v_reason,
                                               NULL, NULL, NULL, NULL, 'system', false);
      IF coalesce((v_r->>'ok')::boolean, false) THEN
        v_cash := v_cash || jsonb_build_object('id', r.id, 'invoice_number', r.invoice_number,
                                               'web_reference', r.web_reference,
                                               'customer_id', r.customer_id,
                                               'customer_lang', r.customer_lang,
                                               'created_at', r.created_at,
                                               'lines_restored', v_r->'lines_restored');
      ELSE
        v_skipped := v_skipped || jsonb_build_object('entity_type', 'cash_order', 'id', r.id,
                                                     'invoice_number', r.invoice_number,
                                                     'reason', coalesce(v_r->>'reason', v_r->>'error', 'refused'));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped || jsonb_build_object('entity_type', 'cash_order', 'id', r.id,
                                                   'invoice_number', r.invoice_number,
                                                   'reason', 'error', 'detail', SQLERRM);
    END;
  END LOOP;

  FOR r IN
    SELECT a.id, a.invoice_number, a.web_reference, a.customer_id, a.customer_lang, a.created_at
      FROM public.layaway_accounts a
     WHERE a.source_channel = 'web' AND a.status = 'active'
       AND a.ready_confirmed_at IS NULL AND a.created_at < v_cutoff
     ORDER BY a.created_at
     LIMIT v_limit
  LOOP
    BEGIN
      v_r := public.decline_web_layaway_reservation_atomic(r.id, v_reason, NULL, 'system');
      IF coalesce((v_r->>'ok')::boolean, false) THEN
        v_lay := v_lay || jsonb_build_object('id', r.id, 'invoice_number', r.invoice_number,
                                             'web_reference', r.web_reference,
                                             'customer_id', r.customer_id,
                                             'customer_lang', r.customer_lang,
                                             'created_at', r.created_at,
                                             'lines_restored', v_r->'stock_lines_restored');
      ELSE
        v_skipped := v_skipped || jsonb_build_object('entity_type', 'layaway', 'id', r.id,
                                                     'invoice_number', r.invoice_number,
                                                     'reason', coalesce(v_r->>'error', 'refused'));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped || jsonb_build_object('entity_type', 'layaway', 'id', r.id,
                                                   'invoice_number', r.invoice_number,
                                                   'reason', 'error', 'detail', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'cutoff', v_cutoff, 'hours', GREATEST(coalesce(p_hours, 72), 1),
                            'cancelled_cash_orders', v_cash,
                            'cancelled_layaways', v_lay,
                            'skipped', v_skipped);
END $function$;

COMMENT ON FUNCTION public.expire_unconfirmed_web_reservations_atomic(integer, integer) IS
  'Reserve-first sweep: cancels WEB reservations (ready_confirmed_at NULL, still live) created more than p_hours (default 72) ago, returning their stock — cash through terminate_web_order_atomic(''cancelled'', source system), layaways through decline_web_layaway_reservation_atomic(source system). Skips anything with money received; INVARIANT 12 refusals come back under skipped. Per-order subtransactions. Returns the cancelled ids with customer and language for the A2 edge function to email.';

-- Service role only: called by edge functions, never from a browser.
REVOKE ALL ON FUNCTION public.confirm_web_order_ready_atomic(text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decline_web_layaway_reservation_atomic(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_unconfirmed_web_reservations_atomic(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_web_order_ready_atomic(text, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decline_web_layaway_reservation_atomic(uuid, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_unconfirmed_web_reservations_atomic(integer, integer) TO service_role;

-- ------------------------------------------ 10. permission key + the switch
-- Explicit rows for every role, allowed for admin / staff / csr (owner,
-- 2026-09-23): an absent row reads as false but cannot be flipped from the
-- Settings matrix.
INSERT INTO public.role_permissions (role, permission_key, is_allowed)
SELECT r.role, 'confirm_web_order_ready', r.allowed
  FROM (VALUES ('admin'::app_role, true), ('staff'::app_role, true), ('csr'::app_role, true),
               ('finance'::app_role, false), ('live_agent'::app_role, false)) AS r(role, allowed)
ON CONFLICT (role, permission_key) DO NOTHING;

INSERT INTO public.system_settings (key, value, description)
VALUES ('web_reservation_mode', 'false'::jsonb,
        'Reserve-first (2026-09-23). true = web checkout creates RESERVATIONS (stock held, no payment deadline, no payment details) that staff confirm ready for dispatch before the deadline starts; false = today''s flow. Read by the website edge function, which passes p_reserve to create_web_order_atomic / create_web_layaway_atomic. The RPCs never read it.')
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------- 12. proof
DO $proof$
DECLARE
  v_expect CONSTANT text[][] := ARRAY[
    ARRAY['create_web_order_atomic',                    'bcb37311b07b0935e3c05406083d68bc'],
    ARRAY['create_web_layaway_atomic',                  '44aa89cfbcbd6a155b0db63a1d879f5c'],
    ARRAY['set_account_deadlines',                      '04351f4426fa27f147cabefe67a94501'],
    ARRAY['web_deposit_deadline_hours',                 '528042fda8cf32d9a4f885e359a8c6c3'],
    ARRAY['confirm_web_order_ready_atomic',             '3cc77796d3b7fa7894875ebef0276aa5'],
    ARRAY['decline_web_layaway_reservation_atomic',     'b42b8fb6df59e1198079aecea8944749'],
    ARRAY['expire_unconfirmed_web_reservations_atomic', '230d4353188c9555673c5cedd11d02aa']];
  v_n   integer;
  v_md5 text;
  v_bad text := '';
  r     record;
  i     integer;
BEGIN
  FOR i IN 1 .. array_length(v_expect, 1) LOOP
    SELECT count(*), min(md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))))
      INTO v_n, v_md5
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_expect[i][1];
    IF v_n <> 1 OR v_md5 IS DISTINCT FROM v_expect[i][2] THEN
      v_bad := v_bad || format(E'\n  %s: %s overload(s), md5 %s, expected 1 / %s',
                               v_expect[i][1], v_n, v_md5, v_expect[i][2]);
    END IF;
  END LOOP;

  -- Every re-created function has exactly the EXECUTE grantees its predecessor had.
  FOR r IN
    SELECT a.proname,
           (SELECT coalesce(array_agg(DISTINCT x.grantee ORDER BY x.grantee), '{}')
              FROM aclexplode(coalesce(a.proacl, acldefault('f', p.proowner))) x
             WHERE x.privilege_type = 'EXECUTE') AS before_g,
           (SELECT coalesce(array_agg(DISTINCT x.grantee ORDER BY x.grantee), '{}')
              FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
             WHERE x.privilege_type = 'EXECUTE') AS after_g
      FROM _a1_acl a
      JOIN pg_proc p ON p.proname = a.proname
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  LOOP
    IF r.before_g IS DISTINCT FROM r.after_g THEN
      v_bad := v_bad || format(E'\n  %s: EXECUTE grantees were %s, now %s', r.proname, r.before_g, r.after_g);
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'cash_orders_payment_status_check'
                    AND pg_get_constraintdef(oid) LIKE '%awaiting_confirmation%') THEN
    v_bad := v_bad || E'\n  cash_orders_payment_status_check does not admit awaiting_confirmation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_orders WHERE source_channel = 'web' AND ready_confirmed_at IS NULL)
     OR EXISTS (SELECT 1 FROM public.layaway_accounts WHERE source_channel = 'web' AND ready_confirmed_at IS NULL) THEN
    v_bad := v_bad || E'\n  a pre-existing web row was not grandfathered';
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION E'STOP — Reserve-first A1 did not land as predicted; the migration is rolled back.%', v_bad;
  END IF;
END
$proof$;

DROP TABLE _a1_acl;

-- ============================================================================
-- VERIFY (read-only), after apply. Expect 7 rows, every md5 as in section 11,
-- one overload each; then permission rows admin/staff/csr true,
-- finance/live_agent false; then web_reservation_mode = false.
--
-- SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
--        md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) AS body_md5
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('create_web_order_atomic', 'create_web_layaway_atomic',
--                      'set_account_deadlines', 'web_deposit_deadline_hours',
--                      'confirm_web_order_ready_atomic',
--                      'decline_web_layaway_reservation_atomic',
--                      'expire_unconfirmed_web_reservations_atomic')
--  ORDER BY 1;
-- SELECT role, is_allowed FROM public.role_permissions
--  WHERE permission_key = 'confirm_web_order_ready' ORDER BY role;
-- SELECT value FROM public.system_settings WHERE key = 'web_reservation_mode';
-- ============================================================================
