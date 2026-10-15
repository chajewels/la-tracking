-- Website coupon codes at checkout (owner decisions 2026-10-15).
--
--   * Kinds: 'percent' (1-100 % off the pieces) or 'amount' (whole yen off the pieces).
--     ONE coupon per order.
--   * Per coupon: code (stored upper-case, unique case-insensitively, [A-Z0-9-]{3,20}),
--     kind, value, optional min pieces subtotal (yen), optional starts_at / ends_at,
--     optional max_uses, per_customer_limit (default 1), full_price_only (default false:
--     the coupon applies on the price she pays, sale price included), allow_layaway
--     (default true), is_active, note.
--   * Applies to the PIECES only - never shipping, services or the COD fee. Coupon first,
--     then points: the points cap becomes pieces - coupon. Layaway: the plan price is
--     pieces - coupon, with the same plan-minimum check.
--   * A use is HELD at checkout (the draft), COUNTED ('used') when staff Confirm, and
--     RELEASED when the draft is declined or expires - exactly like points.
--   * ALL the coupon maths is public.website_coupon_quote(). The website edge function and
--     the storefront only relay its figures. create_web_draft_atomic re-checks it inside the
--     transaction that holds the pieces, with the coupon row locked FOR UPDATE so two
--     checkouts cannot both take the last use.
--   * The draft stores the REDUCED figures (subtotal / total / subtotal_jpy / total_jpy are
--     after the coupon) plus coupon_code / coupon_discount_jpy / coupon_discount. The Hub
--     review screen adds coupon_discount back to show the full pieces price; staff keep their
--     manual Discount box, which starts at the coupon amount and may not go below it
--     (discount_below_coupon, here and in _shared/web-draft-figures.ts). The order's
--     discount_amount is the WHOLE discount including the coupon; coupon_code is the label.
--   * Coupons are changed ONLY through upsert_website_coupon / set_website_coupon_active
--     (admin role, one audit_logs row each). The tables have no write policies.
--
--   Function changes are md5-guarded IN-PLACE patches of the live bodies (Bug #280,
--   docs/MIGRATIONS.md), anchored on the bodies recorded in
--   20261216100000_website_sale_price.sql (create_web_draft_atomic),
--   20261203100000_record_live_l2l8_cod_bodies.sql (materialize_web_draft_atomic) and
--   20261107100100_record_live_checkout_choice_bodies.sql (decline_web_draft_atomic, also the
--   path of expire_web_drafts_atomic). A body that has moved stops the patch and nothing
--   changes. No comment line inside any patch anchor or new text. A re-run is a no-op.
--   After the apply, commit a record-only migration of the three patched bodies.

SET lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.website_coupons (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text NOT NULL CHECK (code ~ '^[A-Z0-9-]{3,20}$'),
  kind               text NOT NULL CHECK (kind IN ('percent', 'amount')),
  value              integer NOT NULL CHECK (value > 0),
  min_subtotal_jpy   integer NULL CHECK (min_subtotal_jpy IS NULL OR min_subtotal_jpy > 0),
  starts_at          timestamptz NULL,
  ends_at            timestamptz NULL,
  max_uses           integer NULL CHECK (max_uses IS NULL OR max_uses > 0),
  per_customer_limit integer NOT NULL DEFAULT 1 CHECK (per_customer_limit > 0),
  full_price_only    boolean NOT NULL DEFAULT false,
  allow_layaway      boolean NOT NULL DEFAULT true,
  is_active          boolean NOT NULL DEFAULT true,
  note               text NULL,
  created_by         uuid NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT website_coupons_percent_max CHECK (kind <> 'percent' OR value <= 100),
  CONSTRAINT website_coupons_dates CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS website_coupons_code_uq ON public.website_coupons (upper(code));
ALTER TABLE public.website_coupons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS website_coupons_staff_select ON public.website_coupons;
CREATE POLICY website_coupons_staff_select ON public.website_coupons
  FOR SELECT TO authenticated USING ((SELECT public.is_staff((SELECT auth.uid()))));
COMMENT ON TABLE public.website_coupons IS
  'Website checkout coupon codes (owner 2026-10-15). Pieces only, one per order. Maths: website_coupon_quote(). Written ONLY by upsert_website_coupon / set_website_coupon_active (admin, audited); no write policies.';

CREATE TABLE IF NOT EXISTS public.website_coupon_uses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id    uuid NOT NULL REFERENCES public.website_coupons(id),
  customer_id  uuid NOT NULL REFERENCES public.customers(id),
  web_draft_id uuid NOT NULL UNIQUE REFERENCES public.web_order_drafts(id),
  status       text NOT NULL CHECK (status IN ('held', 'used', 'released')),
  discount_jpy integer NOT NULL CHECK (discount_jpy >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz NULL
);
CREATE INDEX IF NOT EXISTS website_coupon_uses_coupon_status_idx ON public.website_coupon_uses (coupon_id, status);
CREATE INDEX IF NOT EXISTS website_coupon_uses_coupon_customer_idx ON public.website_coupon_uses (coupon_id, customer_id);
ALTER TABLE public.website_coupon_uses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS website_coupon_uses_staff_select ON public.website_coupon_uses;
CREATE POLICY website_coupon_uses_staff_select ON public.website_coupon_uses
  FOR SELECT TO authenticated USING ((SELECT public.is_staff((SELECT auth.uid()))));
COMMENT ON TABLE public.website_coupon_uses IS
  'One row per website draft that used a coupon: held at checkout, used when staff Confirm, released when the draft is declined or expires. held + used count towards max_uses and per_customer_limit.';

-- ---------------------------------------------------------------------------
-- 2. Columns.
-- ---------------------------------------------------------------------------
ALTER TABLE public.checkout_quotes  ADD COLUMN IF NOT EXISTS coupon_code text NULL;
ALTER TABLE public.checkout_quotes  ADD COLUMN IF NOT EXISTS coupon_discount_jpy integer NOT NULL DEFAULT 0;
ALTER TABLE public.web_order_drafts ADD COLUMN IF NOT EXISTS coupon_code text NULL;
ALTER TABLE public.web_order_drafts ADD COLUMN IF NOT EXISTS coupon_discount_jpy integer NOT NULL DEFAULT 0;
ALTER TABLE public.web_order_drafts ADD COLUMN IF NOT EXISTS coupon_discount numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.web_order_drafts ADD COLUMN IF NOT EXISTS coupon_use_id uuid NULL REFERENCES public.website_coupon_uses(id);
ALTER TABLE public.cash_orders      ADD COLUMN IF NOT EXISTS coupon_code text NULL;
ALTER TABLE public.layaway_accounts ADD COLUMN IF NOT EXISTS coupon_code text NULL;

DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checkout_quotes_coupon_check') THEN
    ALTER TABLE public.checkout_quotes ADD CONSTRAINT checkout_quotes_coupon_check
      CHECK (coupon_discount_jpy >= 0 AND (coupon_discount_jpy = 0 OR coupon_code IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'web_order_drafts_coupon_check') THEN
    ALTER TABLE public.web_order_drafts ADD CONSTRAINT web_order_drafts_coupon_check
      CHECK (coupon_discount_jpy >= 0 AND coupon_discount >= 0
             AND ((coupon_discount_jpy = 0 AND coupon_discount = 0) OR coupon_code IS NOT NULL));
  END IF;
END $c$;

COMMENT ON COLUMN public.checkout_quotes.coupon_code IS
  'Coupon code the customer entered (upper-case). The yen it is worth is coupon_discount_jpy, validated by website_coupon_quote().';
COMMENT ON COLUMN public.checkout_quotes.coupon_discount_jpy IS
  'Coupon discount in yen on the pieces, as website_coupon_quote() answered when the code was applied. subtotal_jpy / total_jpy on the quote are BEFORE it.';
COMMENT ON COLUMN public.web_order_drafts.coupon_code IS
  'Coupon label. The money is already taken off subtotal / total / subtotal_jpy / total_jpy; on the order it becomes part of discount_amount.';
COMMENT ON COLUMN public.web_order_drafts.coupon_discount_jpy IS
  'Coupon discount in yen (already off subtotal_jpy / total_jpy). The review screen adds it back to show the full pieces price.';
COMMENT ON COLUMN public.web_order_drafts.coupon_discount IS
  'Coupon discount in the settlement currency (already off subtotal / total). Staff Discount at Confirm may not go below it.';
COMMENT ON COLUMN public.web_order_drafts.coupon_use_id IS
  'The website_coupon_uses row held by this draft (used on Confirm, released on decline / expiry).';
COMMENT ON COLUMN public.cash_orders.coupon_code IS
  'Website coupon label. The money is in discount_amount (which includes the coupon).';
COMMENT ON COLUMN public.layaway_accounts.coupon_code IS
  'Website coupon label. The money is in discount_amount (which includes the coupon).';

-- ---------------------------------------------------------------------------
-- 3. The single place the coupon maths is decided.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.website_coupon_quote(
  p_code text, p_customer_id uuid, p_subtotal_jpy integer, p_full_price_subtotal_jpy integer, p_mode text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_code  text := upper(btrim(coalesce(p_code, '')));
  v_c     public.website_coupons%ROWTYPE;
  v_basis integer;
  v_taken integer;
  v_mine  integer;
  v_disc  integer;
BEGIN
  IF v_code = '' THEN
    RETURN jsonb_build_object('error', 'coupon_not_found', 'code', v_code);
  END IF;
  SELECT * INTO v_c FROM public.website_coupons WHERE upper(code) = v_code;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'coupon_not_found', 'code', v_code);
  END IF;
  IF NOT v_c.is_active THEN
    RETURN jsonb_build_object('error', 'coupon_inactive', 'code', v_c.code);
  END IF;
  IF v_c.starts_at IS NOT NULL AND v_c.starts_at > now() THEN
    RETURN jsonb_build_object('error', 'coupon_not_started', 'code', v_c.code, 'starts_at', v_c.starts_at);
  END IF;
  IF v_c.ends_at IS NOT NULL AND v_c.ends_at <= now() THEN
    RETURN jsonb_build_object('error', 'coupon_expired', 'code', v_c.code);
  END IF;
  IF p_mode = 'layaway' AND NOT v_c.allow_layaway THEN
    RETURN jsonb_build_object('error', 'coupon_layaway_not_allowed', 'code', v_c.code);
  END IF;
  v_basis := greatest(coalesce(CASE WHEN v_c.full_price_only THEN p_full_price_subtotal_jpy ELSE p_subtotal_jpy END, 0), 0);
  IF v_c.full_price_only AND v_basis <= 0 THEN
    RETURN jsonb_build_object('error', 'coupon_full_price_only', 'code', v_c.code);
  END IF;
  IF v_c.min_subtotal_jpy IS NOT NULL AND coalesce(p_subtotal_jpy, 0) < v_c.min_subtotal_jpy THEN
    RETURN jsonb_build_object('error', 'coupon_min_subtotal', 'code', v_c.code, 'min_subtotal_jpy', v_c.min_subtotal_jpy);
  END IF;
  SELECT count(*), count(*) FILTER (WHERE u.customer_id = p_customer_id)
    INTO v_taken, v_mine
    FROM public.website_coupon_uses u
   WHERE u.coupon_id = v_c.id AND u.status IN ('held', 'used');
  IF v_c.max_uses IS NOT NULL AND v_taken >= v_c.max_uses THEN
    RETURN jsonb_build_object('error', 'coupon_exhausted', 'code', v_c.code);
  END IF;
  IF v_mine >= v_c.per_customer_limit THEN
    RETURN jsonb_build_object('error', 'coupon_customer_limit', 'code', v_c.code, 'per_customer_limit', v_c.per_customer_limit);
  END IF;
  v_disc := CASE WHEN v_c.kind = 'percent' THEN floor(v_basis::numeric * v_c.value / 100)::integer ELSE v_c.value END;
  v_disc := least(v_disc, v_basis, greatest(coalesce(p_subtotal_jpy, 0), 0));
  RETURN jsonb_build_object('ok', true, 'coupon_id', v_c.id, 'code', v_c.code, 'kind', v_c.kind,
                            'value', v_c.value, 'discount_jpy', v_disc);
END
$fn$;
REVOKE ALL ON FUNCTION public.website_coupon_quote(text, uuid, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.website_coupon_quote(text, uuid, integer, integer, text) TO service_role;
COMMENT ON FUNCTION public.website_coupon_quote(text, uuid, integer, integer, text) IS
  'The single place a website coupon is validated and priced. Basis = pieces subtotal (yen), or the full-price pieces only for a full_price_only coupon. percent: floor(basis * value / 100); amount: value; capped at the basis. held + used uses count. Read-only; create_web_draft_atomic locks the coupon row before calling it. Service role only.';

-- ---------------------------------------------------------------------------
-- 4. Admin RPCs (mirror set_shipping_rate: admin ROLE, one audit_logs row each).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_website_coupons()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  RETURN jsonb_build_object(
    'can_change', true,
    'coupons', coalesce((
      SELECT jsonb_agg(to_jsonb(c) || jsonb_build_object(
               'used_count', (SELECT count(*) FROM public.website_coupon_uses u WHERE u.coupon_id = c.id AND u.status = 'used'),
               'held_count', (SELECT count(*) FROM public.website_coupon_uses u WHERE u.coupon_id = c.id AND u.status = 'held'))
             ORDER BY c.is_active DESC, c.created_at DESC)
        FROM public.website_coupons c), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_website_coupons() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_website_coupons() TO authenticated;
COMMENT ON FUNCTION public.get_website_coupons() IS
  'Every website coupon with used_count and held_count, for Hub -> Website -> Settings -> Coupons. Admin role only.';

CREATE OR REPLACE FUNCTION public.upsert_website_coupon(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid    uuid := auth.uid();
  v_id     uuid;
  v_code   text;
  v_kind   text;
  v_value  integer;
  v_min    integer;
  v_start  timestamptz;
  v_end    timestamptz;
  v_max    integer;
  v_per    integer;
  v_full   boolean;
  v_lay    boolean;
  v_active boolean;
  v_note   text;
  v_old    public.website_coupons%ROWTYPE;
  v_new    public.website_coupons%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  p := coalesce(p, '{}'::jsonb);
  BEGIN
    v_id     := nullif(btrim(coalesce(p ->> 'id', '')), '')::uuid;
    v_code   := upper(btrim(coalesce(p ->> 'code', '')));
    v_kind   := btrim(coalesce(p ->> 'kind', ''));
    v_value  := (p ->> 'value')::integer;
    v_min    := nullif(btrim(coalesce(p ->> 'min_subtotal_jpy', '')), '')::integer;
    v_start  := nullif(btrim(coalesce(p ->> 'starts_at', '')), '')::timestamptz;
    v_end    := nullif(btrim(coalesce(p ->> 'ends_at', '')), '')::timestamptz;
    v_max    := nullif(btrim(coalesce(p ->> 'max_uses', '')), '')::integer;
    v_per    := coalesce(nullif(btrim(coalesce(p ->> 'per_customer_limit', '')), '')::integer, 1);
    v_full   := coalesce((p ->> 'full_price_only')::boolean, false);
    v_lay    := coalesce((p ->> 'allow_layaway')::boolean, true);
    v_active := coalesce((p ->> 'is_active')::boolean, true);
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format
                 OR datetime_field_overflow THEN
    RETURN jsonb_build_object('error', 'invalid_input');
  END;
  v_note := nullif(btrim(coalesce(p ->> 'note', '')), '');

  IF v_code !~ '^[A-Z0-9-]{3,20}$' THEN RETURN jsonb_build_object('error', 'invalid_code'); END IF;
  IF v_kind NOT IN ('percent', 'amount') THEN RETURN jsonb_build_object('error', 'invalid_kind'); END IF;
  IF v_value IS NULL OR v_value <= 0 OR (v_kind = 'percent' AND v_value > 100) OR v_value > 100000000 THEN
    RETURN jsonb_build_object('error', 'invalid_value');
  END IF;
  IF v_min IS NOT NULL AND (v_min <= 0 OR v_min > 100000000) THEN
    RETURN jsonb_build_object('error', 'invalid_min_subtotal');
  END IF;
  IF v_start IS NOT NULL AND v_end IS NOT NULL AND v_end <= v_start THEN
    RETURN jsonb_build_object('error', 'invalid_dates');
  END IF;
  IF v_max IS NOT NULL AND v_max <= 0 THEN RETURN jsonb_build_object('error', 'invalid_max_uses'); END IF;
  IF v_per <= 0 THEN RETURN jsonb_build_object('error', 'invalid_per_customer_limit'); END IF;

  IF EXISTS (SELECT 1 FROM public.website_coupons c
              WHERE upper(c.code) = v_code AND (v_id IS NULL OR c.id <> v_id)) THEN
    RETURN jsonb_build_object('error', 'coupon_code_taken', 'code', v_code);
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.website_coupons (code, kind, value, min_subtotal_jpy, starts_at, ends_at, max_uses,
                                        per_customer_limit, full_price_only, allow_layaway, is_active, note, created_by)
    VALUES (v_code, v_kind, v_value, v_min, v_start, v_end, v_max, v_per, v_full, v_lay, v_active, v_note, v_uid)
    RETURNING * INTO v_new;
  ELSE
    SELECT * INTO v_old FROM public.website_coupons WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    IF v_old.code <> v_code AND EXISTS (SELECT 1 FROM public.website_coupon_uses u WHERE u.coupon_id = v_id) THEN
      RETURN jsonb_build_object('error', 'coupon_code_locked', 'code', v_old.code);
    END IF;
    UPDATE public.website_coupons
       SET code = v_code, kind = v_kind, value = v_value, min_subtotal_jpy = v_min, starts_at = v_start,
           ends_at = v_end, max_uses = v_max, per_customer_limit = v_per, full_price_only = v_full,
           allow_layaway = v_lay, is_active = v_active, note = v_note, updated_at = now()
     WHERE id = v_id
    RETURNING * INTO v_new;
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('website_coupon', v_new.id, 'upsert_website_coupon',
          CASE WHEN v_old.id IS NULL THEN NULL ELSE to_jsonb(v_old) END,
          to_jsonb(v_new) || jsonb_build_object('change', CASE WHEN v_old.id IS NULL THEN 'created' ELSE 'edited' END),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'coupon', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.upsert_website_coupon(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_website_coupon(jsonb) TO authenticated;
COMMENT ON FUNCTION public.upsert_website_coupon(jsonb) IS
  'Creates (no id) or edits (id) a website coupon. Validates every field, upper-cases the code, refuses a duplicate (coupon_code_taken) and a code change once the coupon has been used (coupon_code_locked). Admin role only; one audit_logs row (website_coupon / upsert_website_coupon, old -> new).';

CREATE OR REPLACE FUNCTION public.set_website_coupon_active(p_id uuid, p_active boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_old public.website_coupons%ROWTYPE;
  v_new public.website_coupons%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF p_active IS NULL THEN RETURN jsonb_build_object('error', 'invalid_input'); END IF;
  SELECT * INTO v_old FROM public.website_coupons WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_old.is_active = p_active THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'coupon', to_jsonb(v_old));
  END IF;
  UPDATE public.website_coupons SET is_active = p_active, updated_at = now() WHERE id = p_id RETURNING * INTO v_new;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('website_coupon', p_id, 'set_website_coupon_active', to_jsonb(v_old), to_jsonb(v_new), v_uid, now());
  RETURN jsonb_build_object('ok', true, 'changed', true, 'coupon', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.set_website_coupon_active(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_website_coupon_active(uuid, boolean) TO authenticated;
COMMENT ON FUNCTION public.set_website_coupon_active(uuid, boolean) IS
  'Switches a website coupon on or off. Never deletes. Admin role only; one audit_logs row (website_coupon / set_website_coupon_active).';

-- ---------------------------------------------------------------------------
-- 5. In-place patches of the live bodies (md5-guarded).
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

-- 5a. create_web_draft_atomic: the coupon is re-validated (coupon row locked) right after the
--     settlement figures, BEFORE the plan-minimum check, so a layaway is priced on pieces - coupon.
--     Points cap = pieces - coupon. The draft stores the reduced figures and holds a use.
SELECT pg_temp.cj_patch('public.create_web_draft_atomic(uuid,uuid,text,text,timestamp with time zone)', 'c5e96511d21cd479149ccb752dda31da', jsonb_build_array(
  jsonb_build_object('old', $o$  v_cod_fee   integer := 0;
BEGIN
$o$,
                     'new', $n$  v_cod_fee   integer := 0;
  v_coupon     jsonb;
  v_coupon_jpy integer := 0;
  v_coupon_val numeric(12,2) := 0;
  v_coupon_code text;
  v_use_id     uuid;
  v_full_sub   integer;
BEGIN
$n$),
  jsonb_build_object('old', $o$  v_subtotal := v_total - coalesce(v_shipping, 0);
$o$,
                     'new', $n$  v_subtotal := v_total - coalesce(v_shipping, 0);
  IF nullif(btrim(coalesce(v_quote.coupon_code, '')), '') IS NOT NULL THEN
    PERFORM 1 FROM public.website_coupons c WHERE upper(c.code) = upper(btrim(v_quote.coupon_code)) FOR UPDATE;
    SELECT coalesce(sum((i ->> 'line_total_jpy')::numeric), 0)::integer INTO v_full_sub
      FROM jsonb_array_elements(v_quote.items) i
      JOIN public.website_product_variants pv ON pv.id = (i ->> 'variant_id')::uuid
     WHERE (i ->> 'unit_price_jpy')::numeric = pv.price_jpy;
    v_coupon := public.website_coupon_quote(v_quote.coupon_code, p_customer_id, v_quote.subtotal_jpy, v_full_sub, v_quote.mode);
    IF v_coupon ? 'error' THEN
      RETURN v_coupon;
    END IF;
    v_coupon_jpy  := (v_coupon ->> 'discount_jpy')::integer;
    v_coupon_code := v_coupon ->> 'code';
    IF v_coupon_jpy <> coalesce(v_quote.coupon_discount_jpy, 0) THEN
      RETURN jsonb_build_object('error', 'coupon_changed', 'code', v_coupon_code, 'discount_jpy', v_coupon_jpy);
    END IF;
    IF v_quote.total_jpy - v_coupon_jpy <= 0 THEN
      RETURN jsonb_build_object('error', 'coupon_total_zero', 'code', v_coupon_code);
    END IF;
    v_coupon_val := CASE WHEN v_cur = 'PHP' THEN round(v_coupon_jpy * v_rate) ELSE v_coupon_jpy END;
    v_total    := v_total - v_coupon_val;
    v_subtotal := v_subtotal - v_coupon_val;
  END IF;
$n$),
  jsonb_build_object('old', $o$    IF v_points > coalesce(v_quote.subtotal_jpy, 0) THEN
      RETURN jsonb_build_object('error', 'points_exceed_subtotal', 'max_points', coalesce(v_quote.subtotal_jpy, 0));
$o$,
                     'new', $n$    IF v_points > coalesce(v_quote.subtotal_jpy, 0) - v_coupon_jpy THEN
      RETURN jsonb_build_object('error', 'points_exceed_subtotal', 'max_points', coalesce(v_quote.subtotal_jpy, 0) - v_coupon_jpy);
$n$),
  jsonb_build_object('old', $o$    IF v_quote.mode = 'full' AND v_pts_value > v_subtotal THEN
      RETURN jsonb_build_object('error', 'points_exceed_subtotal', 'max_points', coalesce(v_quote.subtotal_jpy, 0));
$o$,
                     'new', $n$    IF v_quote.mode = 'full' AND v_pts_value > v_subtotal THEN
      RETURN jsonb_build_object('error', 'points_exceed_subtotal', 'max_points', coalesce(v_quote.subtotal_jpy, 0) - v_coupon_jpy);
$n$),
  jsonb_build_object('old', $o$    v_quote.subtotal_jpy, v_quote.shipping_jpy, v_quote.total_jpy, v_subtotal, v_shipping, v_total, v_deposit, v_schedule,
$o$,
                     'new', $n$    v_quote.subtotal_jpy - v_coupon_jpy, v_quote.shipping_jpy, v_quote.total_jpy - v_coupon_jpy, v_subtotal, v_shipping, v_total, v_deposit, v_schedule,
$n$),
  jsonb_build_object('old', $o$  UPDATE public.web_order_drafts
     SET payment_method = v_method, points = v_points, points_value = v_pts_value,
$o$,
                     'new', $n$  IF v_coupon_jpy > 0 THEN
    INSERT INTO public.website_coupon_uses (coupon_id, customer_id, web_draft_id, status, discount_jpy)
    VALUES ((v_coupon ->> 'coupon_id')::uuid, p_customer_id, v_draft_id, 'held', v_coupon_jpy)
    RETURNING id INTO v_use_id;
  END IF;
  UPDATE public.web_order_drafts
     SET payment_method = v_method, points = v_points, points_value = v_pts_value,
$n$),
  jsonb_build_object('old', $o$         cod_fee_jpy = v_cod_fee, cod_fee = v_cod_fee,
$o$,
                     'new', $n$         cod_fee_jpy = v_cod_fee, cod_fee = v_cod_fee,
         coupon_code = CASE WHEN v_coupon_jpy > 0 THEN v_coupon_code END, coupon_discount_jpy = v_coupon_jpy,
         coupon_discount = v_coupon_val, coupon_use_id = v_use_id,
$n$),
  jsonb_build_object('old', $o$    'mode', v_quote.mode, 'currency', v_cur, 'total', v_total + v_cod_fee, 'total_jpy', v_quote.total_jpy + v_cod_fee,
$o$,
                     'new', $n$    'mode', v_quote.mode, 'currency', v_cur, 'total', v_total + v_cod_fee, 'total_jpy', v_quote.total_jpy - v_coupon_jpy + v_cod_fee,
$n$),
  jsonb_build_object('old', $o$    'payment_method', v_method, 'points', v_points, 'points_value', v_pts_value);
$o$,
                     'new', $n$    'payment_method', v_method, 'points', v_points, 'points_value', v_pts_value,
    'coupon_code', CASE WHEN v_coupon_jpy > 0 THEN v_coupon_code END, 'coupon_discount', v_coupon_val,
    'coupon_discount_jpy', v_coupon_jpy);
$n$)
));

-- 5b. materialize_web_draft_atomic: the staff discount may not go below the coupon; the order
--     carries coupon_code; the held use is counted ('used'); the audit row names the coupon.
SELECT pg_temp.cj_patch('public.materialize_web_draft_atomic(uuid,uuid,jsonb,jsonb,jsonb)', 'a52553d50cccf5bbfc28b898f0750179', jsonb_build_array(
  jsonb_build_object('old', $o$  v_discount := coalesce((p_order ->> 'discount_amount')::numeric, 0);
$o$,
                     'new', $n$  v_discount := coalesce((p_order ->> 'discount_amount')::numeric, 0);
  IF v_discount < coalesce(v_draft.coupon_discount, 0) THEN
    RETURN jsonb_build_object('error', 'discount_below_coupon', 'coupon_discount', v_draft.coupon_discount,
                              'coupon_code', v_draft.coupon_code);
  END IF;
$n$),
  jsonb_build_object('old', $o$      ready_confirmed_at, ready_confirmed_by, created_by_user_id, planned_shipping_method_id
    ) VALUES (
$o$,
                     'new', $n$      ready_confirmed_at, ready_confirmed_by, created_by_user_id, planned_shipping_method_id, coupon_code
    ) VALUES (
$n$),
  jsonb_build_object('old', $o$      v_now, p_user_id, p_user_id, v_courier
    ) RETURNING id INTO v_order_id;
$o$,
                     'new', $n$      v_now, p_user_id, p_user_id, v_courier, v_draft.coupon_code
    ) RETURNING id INTO v_order_id;
$n$),
  jsonb_build_object('old', $o$      planned_shipping_method_id, cod_fee
    ) VALUES (
$o$,
                     'new', $n$      planned_shipping_method_id, cod_fee, coupon_code
    ) VALUES (
$n$),
  jsonb_build_object('old', $o$      v_courier, v_cod
    ) RETURNING id INTO v_order_id;
$o$,
                     'new', $n$      v_courier, v_cod, v_draft.coupon_code
    ) RETURNING id INTO v_order_id;
$n$),
  jsonb_build_object('old', $o$         layaway_account_id = CASE WHEN v_draft.mode = 'layaway' THEN v_order_id END
   WHERE id = p_draft_id;
$o$,
                     'new', $n$         layaway_account_id = CASE WHEN v_draft.mode = 'layaway' THEN v_order_id END
   WHERE id = p_draft_id;
  IF v_draft.coupon_use_id IS NOT NULL THEN
    UPDATE public.website_coupon_uses SET status = 'used', decided_at = v_now
     WHERE id = v_draft.coupon_use_id AND status = 'held';
  END IF;
$n$),
  jsonb_build_object('old', $o$                             'points_value', v_pts_value, 'cod_fee', v_cod),
$o$,
                     'new', $n$                             'points_value', v_pts_value, 'cod_fee', v_cod,
                             'coupon_code', v_draft.coupon_code, 'coupon_discount', v_draft.coupon_discount),
$n$)
));

-- 5c. decline_web_draft_atomic (also expire_web_drafts_atomic's path): a held coupon use is released.
SELECT pg_temp.cj_patch('public.decline_web_draft_atomic(uuid,text,uuid,text)', '0ece552455fb89a2fa5b0e335f4ff04f', jsonb_build_array(
  jsonb_build_object('old', $o$  v_points_released integer := 0;
BEGIN
$o$,
                     'new', $n$  v_points_released integer := 0;
  v_coupon_released integer := 0;
BEGIN
$n$),
  jsonb_build_object('old', $o$  GET DIAGNOSTICS v_points_released = ROW_COUNT;
$o$,
                     'new', $n$  GET DIAGNOSTICS v_points_released = ROW_COUNT;
  UPDATE public.website_coupon_uses SET status = 'released', decided_at = v_now
   WHERE web_draft_id = p_draft_id AND status = 'held';
  GET DIAGNOSTICS v_coupon_released = ROW_COUNT;
$n$),
  jsonb_build_object('old', $o$                              'points_redemptions_released', v_points_released,
$o$,
                     'new', $n$                              'points_redemptions_released', v_points_released,
                             'coupon_uses_released', v_coupon_released,
$n$)
));

-- ---------------------------------------------------------------------------
-- Verify after apply (read-only):
--   SELECT md5(pg_get_functiondef('public.create_web_draft_atomic(uuid,uuid,text,text,timestamp with time zone)'::regprocedure));
--   SELECT md5(pg_get_functiondef('public.materialize_web_draft_atomic(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure));
--   SELECT md5(pg_get_functiondef('public.decline_web_draft_atomic(uuid,text,uuid,text)'::regprocedure));
--   SELECT count(*) FROM public.website_coupons;  -- 0
-- ---------------------------------------------------------------------------
