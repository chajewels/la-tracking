-- Cash on Delivery (代金引換) as a website checkout payment method (owner plan 2026-10-10,
-- project doc claude/cod-plan-2026-10-10.md; docs/COD.md).
--
--   * Method 'cod': yen only, Japan delivery address, full payment only (never layaway, never pesos).
--   * Off unless cod_mode = "on" (fail-closed). cod_mode and the fee table change ONLY through
--     set_cod_settings (admin role, audited, guard trigger trg_guard_cod_settings). Seeded "off".
--   * ONE fee rule: public.cod_fee_jpy(collected). Amount collected = pieces after points +
--     shipping (+ services − discount once staff edit at Confirm). Brackets are inclusive; the
--     fee itself is not counted in the limit (the top bracket). NULL = COD not possible.
--     TS mirror: supabase/functions/_shared/cod-fee.ts (development/cod-checkout.test.ts).
--   * The fee is its own column (checkout_quotes.cod_fee_jpy, web_order_drafts.cod_fee_jpy +
--     cod_fee, cash_orders.cod_fee), included in total_amount / remaining_balance, NEVER in
--     loyalty_jpy_amount; points never pay it (nor shipping).
--   * No payment deadline: materialize accepts NULL for 'cod' only; the lapse / any automated
--     termination and web_payment_reminder_eligible skip COD. Staff cancel still returns stock.
--   * Switching to / from COD (staff and customer) re-brackets and moves total and remaining by
--     the fee delta in the same transaction; refused while any payment lock is set (unchanged).
--     Switching TO cod clears transfer_due_at / expires_at (a stale deadline must never come back:
--     review H1); switching a confirmed order AWAY from cod arms a fresh deadline through
--     set_account_deadlines (the one deadline writer, CLAUDE.md WEB LAYAWAY rule) at the
--     customer's web rule (web_deposit_deadline_hours), audited (review M1).
--   * A shipped order is never expired or ended by automation, whatever the method (review H1).
--   * A COD order's total / shipping / discount / fee change ONLY together with its method
--     (trg_guard_cod_order_amount): a Manage Invoice edit that would leave the fee out of the total
--     is refused — switch the method first, or cancel and recreate (review H2).
--   * set_account_deadlines refuses a COD order (cod_no_deadline) (review L2).
--
--   Every function change is an md5-guarded IN-PLACE patch of the live body (Bug #280), read
--   2026-10-10. No comment line inside any patch anchor or new text (Lovable's runner drops such
--   lines). A re-run is a no-op. After the apply, commit a record-only migration of the patched
--   bodies (docs/MIGRATIONS.md).

SET lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Columns and CHECKs.
-- ---------------------------------------------------------------------------
ALTER TABLE public.checkout_quotes  ADD COLUMN IF NOT EXISTS cod_fee_jpy integer NOT NULL DEFAULT 0;
ALTER TABLE public.web_order_drafts ADD COLUMN IF NOT EXISTS cod_fee_jpy integer NOT NULL DEFAULT 0;
ALTER TABLE public.web_order_drafts ADD COLUMN IF NOT EXISTS cod_fee numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.cash_orders      ADD COLUMN IF NOT EXISTS cod_fee numeric(12,2) NOT NULL DEFAULT 0;

ALTER TABLE public.checkout_quotes DROP CONSTRAINT IF EXISTS checkout_quotes_payment_method_check;
ALTER TABLE public.checkout_quotes ADD CONSTRAINT checkout_quotes_payment_method_check
  CHECK (payment_method IS NULL OR payment_method IN ('transfer', 'paidy', 'square', 'cod'));
ALTER TABLE public.web_order_drafts DROP CONSTRAINT IF EXISTS web_order_drafts_payment_method_check;
ALTER TABLE public.web_order_drafts ADD CONSTRAINT web_order_drafts_payment_method_check
  CHECK (payment_method IN ('transfer', 'paidy', 'square', 'cod'));
ALTER TABLE public.cash_orders DROP CONSTRAINT IF EXISTS cash_orders_payment_method_check;
ALTER TABLE public.cash_orders ADD CONSTRAINT cash_orders_payment_method_check
  CHECK (payment_method IS NULL OR payment_method IN ('square', 'transfer', 'paidy', 'cod'));

DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checkout_quotes_cod_fee_check') THEN
    ALTER TABLE public.checkout_quotes ADD CONSTRAINT checkout_quotes_cod_fee_check
      CHECK (cod_fee_jpy >= 0 AND (cod_fee_jpy = 0 OR payment_method = 'cod'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'web_order_drafts_cod_fee_check') THEN
    ALTER TABLE public.web_order_drafts ADD CONSTRAINT web_order_drafts_cod_fee_check
      CHECK (cod_fee_jpy >= 0 AND cod_fee >= 0 AND ((cod_fee_jpy = 0 AND cod_fee = 0) OR payment_method = 'cod'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'web_order_drafts_cod_yen_full') THEN
    ALTER TABLE public.web_order_drafts ADD CONSTRAINT web_order_drafts_cod_yen_full
      CHECK (payment_method <> 'cod' OR (mode = 'full' AND settlement_currency = 'JPY'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_orders_cod_fee_check') THEN
    ALTER TABLE public.cash_orders ADD CONSTRAINT cash_orders_cod_fee_check
      CHECK (cod_fee >= 0 AND (cod_fee = 0 OR payment_method = 'cod'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_orders_cod_yen') THEN
    ALTER TABLE public.cash_orders ADD CONSTRAINT cash_orders_cod_yen
      CHECK (payment_method IS DISTINCT FROM 'cod' OR currency = 'JPY'::account_currency);
  END IF;
END $c$;

COMMENT ON COLUMN public.checkout_quotes.cod_fee_jpy IS
  'Cash on delivery fee (代引手数料) for this quote, yen, set when the customer chose cod (public.cod_fee_jpy). 0 otherwise. docs/COD.md.';
COMMENT ON COLUMN public.web_order_drafts.cod_fee_jpy IS
  'Cash on delivery fee, yen. Included in total / total_jpy. Never paid by points, never in the loyalty basis. Re-bracketed by change_web_payment_method_atomic and at Confirm. docs/COD.md.';
COMMENT ON COLUMN public.web_order_drafts.cod_fee IS
  'Cash on delivery fee in the draft''s currency (always yen: COD is yen only). Equals cod_fee_jpy.';
COMMENT ON COLUMN public.cash_orders.cod_fee IS
  'Cash on delivery fee (代引手数料), its own line, included in total_amount / remaining_balance, NEVER in loyalty_jpy_amount. Non-zero only while payment_method = ''cod''. docs/COD.md.';

-- ---------------------------------------------------------------------------
-- 2. The switch and the fee table. Inserted only when absent; an existing value is NEVER
--    written here.
-- ---------------------------------------------------------------------------
INSERT INTO public.system_settings (key, value, description)
VALUES ('cod_mode', '"off"'::jsonb,
        'Cash on delivery (代金引換) at website checkout: "off" | "on". Anything else reads as off. Changed only from Website → Settings → Cash on delivery (set_cod_settings; admin; audited). docs/COD.md.')
ON CONFLICT (key) DO NOTHING;
INSERT INTO public.system_settings (key, value, description)
VALUES ('cod_fee_table',
        '[{"max_jpy":10000,"fee_jpy":1040},{"max_jpy":30000,"fee_jpy":1150},{"max_jpy":100000,"fee_jpy":1370},{"max_jpy":300000,"fee_jpy":1810}]'::jsonb,
        'Cash on delivery fee brackets: amount collected up to and including max_jpy → fee_jpy. The top max_jpy is the COD limit (the fee is not counted in it). Changed only through set_cod_settings. docs/COD.md.')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.guard_cod_settings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF (OLD.key IN ('cod_mode','cod_fee_table')
      AND (TG_OP = 'DELETE' OR NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value))
     OR (TG_OP = 'UPDATE' AND NEW.key IN ('cod_mode','cod_fee_table')
         AND OLD.key IS DISTINCT FROM NEW.key)
  THEN
    IF coalesce(current_setting('app.allow_cod_settings_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'Cash on delivery settings are changed only from the Hub: Website → Settings → Cash on delivery (set_cod_settings).'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_cod_settings() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_cod_settings ON public.system_settings;
CREATE TRIGGER trg_guard_cod_settings
BEFORE UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_cod_settings();

-- ---------------------------------------------------------------------------
-- 3. Readers. Fail-closed: a bad mode is off, a bad table is "no COD".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cod_mode()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT CASE WHEN v = 'on' THEN 'on' ELSE 'off' END
    FROM (SELECT (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'cod_mode') AS v) s
$fn$;

CREATE OR REPLACE FUNCTION public.cod_fee_table_valid(p_table jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public'
AS $fn$
DECLARE
  e      jsonb;
  v_prev numeric := 0;
  v_n    integer := 0;
BEGIN
  IF p_table IS NULL OR jsonb_typeof(p_table) <> 'array' THEN RETURN false; END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(p_table) LOOP
    v_n := v_n + 1;
    IF jsonb_typeof(e) <> 'object' OR jsonb_typeof(e -> 'max_jpy') <> 'number' OR jsonb_typeof(e -> 'fee_jpy') <> 'number' THEN
      RETURN false;
    END IF;
    IF (e ->> 'max_jpy')::numeric <> trunc((e ->> 'max_jpy')::numeric)
       OR (e ->> 'fee_jpy')::numeric <> trunc((e ->> 'fee_jpy')::numeric)
       OR (e ->> 'max_jpy')::numeric <= v_prev
       OR (e ->> 'max_jpy')::numeric > 10000000
       OR (e ->> 'fee_jpy')::numeric < 0
       OR (e ->> 'fee_jpy')::numeric > 100000 THEN
      RETURN false;
    END IF;
    v_prev := (e ->> 'max_jpy')::numeric;
  END LOOP;
  RETURN v_n BETWEEN 1 AND 10;
END
$fn$;

CREATE OR REPLACE FUNCTION public.cod_limit_jpy()
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT CASE WHEN public.cod_fee_table_valid(t)
              THEN (SELECT max((e ->> 'max_jpy')::integer) FROM jsonb_array_elements(t) e) END
    FROM (SELECT (SELECT value FROM public.system_settings WHERE key = 'cod_fee_table') AS t) s
$fn$;

CREATE OR REPLACE FUNCTION public.cod_fee_jpy(p_collected numeric)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT CASE
           WHEN p_collected IS NULL OR p_collected <= 0 OR NOT public.cod_fee_table_valid(t) THEN NULL
           ELSE (SELECT (e ->> 'fee_jpy')::integer
                   FROM jsonb_array_elements(t) e
                  WHERE p_collected <= (e ->> 'max_jpy')::numeric
                  ORDER BY (e ->> 'max_jpy')::numeric
                  LIMIT 1)
         END
    FROM (SELECT (SELECT value FROM public.system_settings WHERE key = 'cod_fee_table') AS t) s
$fn$;

REVOKE ALL ON FUNCTION public.cod_mode() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cod_limit_jpy() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cod_fee_jpy(numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cod_fee_table_valid(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cod_mode() TO service_role;
GRANT EXECUTE ON FUNCTION public.cod_limit_jpy() TO service_role;
GRANT EXECUTE ON FUNCTION public.cod_fee_jpy(numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.cod_fee_table_valid(jsonb) TO service_role;
COMMENT ON FUNCTION public.cod_fee_jpy(numeric) IS
  'THE cash on delivery fee rule: the fee for an amount collected (pieces after points + shipping + services − discount; the fee itself excluded), from system_settings.cod_fee_table, brackets inclusive. NULL when COD is not possible (nothing to collect, over the limit, or an invalid table). TS mirror _shared/cod-fee.ts. docs/COD.md.';

-- ---------------------------------------------------------------------------
-- 4. Read and write the switch. Read: admin, admin_settings, or staff who confirm website orders /
--    payments (the Change payment method warning). Write: ADMIN ROLE only — no override grants it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_cod_settings()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_mode public.system_settings%ROWTYPE;
  v_tab  public.system_settings%ROWTYPE;
  v_by   uuid;
  v_at   timestamptz;
  v_name text;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT (public.has_role(v_uid, 'admin'::public.app_role)
          OR public.has_permission(v_uid, 'admin_settings')
          OR public.has_permission(v_uid, 'confirm_payment')
          OR public.has_permission(v_uid, 'confirm_web_order_ready')) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  SELECT * INTO v_mode FROM public.system_settings WHERE key = 'cod_mode';
  SELECT * INTO v_tab  FROM public.system_settings WHERE key = 'cod_fee_table';
  IF v_tab.updated_at IS NOT NULL AND (v_mode.updated_at IS NULL OR v_tab.updated_at > v_mode.updated_at)
     AND v_tab.updated_by_user_id IS NOT NULL THEN
    v_by := v_tab.updated_by_user_id; v_at := v_tab.updated_at;
  ELSE
    v_by := v_mode.updated_by_user_id; v_at := v_mode.updated_at;
  END IF;
  IF v_by IS NOT NULL THEN
    SELECT full_name INTO v_name FROM public.profiles WHERE user_id = v_by LIMIT 1;
  END IF;
  RETURN jsonb_build_object(
    'found',              v_mode.id IS NOT NULL AND v_tab.id IS NOT NULL,
    'mode',               public.cod_mode(),
    'raw_mode',           v_mode.value,
    'fee_table',          v_tab.value,
    'fee_table_valid',    public.cod_fee_table_valid(v_tab.value),
    'limit_jpy',          public.cod_limit_jpy(),
    'updated_at',         v_at,
    'updated_by_user_id', v_by,
    'updated_by_name',    v_name,
    'can_change',         public.has_role(v_uid, 'admin'::public.app_role),
    'open_cod_orders',    (SELECT count(*) FROM public.cash_orders
                            WHERE payment_method = 'cod' AND status = 'pending'::cash_order_status),
    'open_cod_drafts',    (SELECT count(*) FROM public.web_order_drafts
                            WHERE payment_method = 'cod' AND status = 'to_confirm'));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_cod_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cod_settings() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_cod_settings(p_mode text, p_fee_table jsonb DEFAULT NULL, p_expected_mode text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid       uuid := auth.uid();
  v_mode_row  public.system_settings%ROWTYPE;
  v_tab_row   public.system_settings%ROWTYPE;
  v_old_mode  text;
  v_new_mode  text;
  v_new_tab   jsonb;
  v_mode_changed boolean;
  v_tab_changed  boolean;
  v_now       timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;

  SELECT * INTO v_mode_row FROM public.system_settings WHERE key = 'cod_mode' FOR UPDATE;
  SELECT * INTO v_tab_row  FROM public.system_settings WHERE key = 'cod_fee_table' FOR UPDATE;
  IF v_mode_row.id IS NULL OR v_tab_row.id IS NULL THEN RETURN jsonb_build_object('error', 'setting_missing'); END IF;

  v_old_mode := public.cod_mode();
  v_new_mode := coalesce(btrim(p_mode), v_old_mode);
  IF v_new_mode NOT IN ('off','on') THEN
    RETURN jsonb_build_object('error', 'invalid_mode');
  END IF;
  IF p_expected_mode IS NOT NULL AND p_expected_mode IS DISTINCT FROM v_old_mode THEN
    RETURN jsonb_build_object('error', 'stale', 'mode', v_old_mode);
  END IF;

  v_new_tab := coalesce(p_fee_table, v_tab_row.value);
  IF NOT public.cod_fee_table_valid(v_new_tab) THEN
    RETURN jsonb_build_object('error', 'invalid_fee_table');
  END IF;
  SELECT jsonb_agg(jsonb_build_object('max_jpy', (e ->> 'max_jpy')::integer, 'fee_jpy', (e ->> 'fee_jpy')::integer)
                   ORDER BY (e ->> 'max_jpy')::integer)
    INTO v_new_tab FROM jsonb_array_elements(v_new_tab) e;

  v_mode_changed := v_mode_row.value IS DISTINCT FROM to_jsonb(v_new_mode);
  v_tab_changed  := v_tab_row.value IS DISTINCT FROM v_new_tab;
  IF NOT v_mode_changed AND NOT v_tab_changed THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'mode', v_old_mode, 'fee_table', v_new_tab);
  END IF;

  PERFORM set_config('app.allow_cod_settings_change', 'on', true);
  IF v_mode_changed THEN
    UPDATE public.system_settings SET value = to_jsonb(v_new_mode), updated_by_user_id = v_uid, updated_at = v_now
     WHERE id = v_mode_row.id;
  END IF;
  IF v_tab_changed THEN
    UPDATE public.system_settings SET value = v_new_tab, updated_by_user_id = v_uid, updated_at = v_now
     WHERE id = v_tab_row.id;
  END IF;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('system_setting', v_mode_row.id, 'set_cod_settings',
          jsonb_build_object('mode', v_old_mode, 'raw_mode', v_mode_row.value, 'fee_table', v_tab_row.value,
                             'updated_at', v_mode_row.updated_at, 'updated_by_user_id', v_mode_row.updated_by_user_id),
          jsonb_build_object('mode', v_new_mode, 'fee_table', v_new_tab,
                             'mode_changed', v_mode_changed, 'fee_table_changed', v_tab_changed),
          v_uid, v_now);
  PERFORM set_config('app.allow_cod_settings_change', '', true);

  RETURN jsonb_build_object('ok', true, 'changed', true, 'mode', v_new_mode, 'old_mode', v_old_mode,
                            'fee_table', v_new_tab, 'updated_at', v_now);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_cod_settings(text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_cod_settings(text, jsonb, text) TO authenticated, service_role;
COMMENT ON FUNCTION public.set_cod_settings(text, jsonb, text) IS
  'The ONLY writer of system_settings.cod_mode and cod_fee_table (trg_guard_cod_settings refuses every other write). Admin role only. Mode off|on; fee table 1–10 brackets {max_jpy, fee_jpy}, whole yen, strictly ascending max. One audit_logs row (system_setting / set_cod_settings, old -> new). p_expected_mode = the mode the caller saw; a mismatch returns {error:"stale"}.';

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

-- 5a. create_web_draft_atomic: 'cod' accepted (switch on, Japan delivery; yen and full payment by the
--     existing method rules), the fee bracketed on pieces after points + shipping, stored on the draft
--     and the quote, included in the draft total.
SELECT pg_temp.cj_patch('public.create_web_draft_atomic(uuid,uuid,text,text,timestamp with time zone)', 'f0a9ffb0b7da4270b95a11f12598e202', jsonb_build_array(
  jsonb_build_object('old', $o$  v_red_id    uuid;
BEGIN
$o$,
                     'new', $n$  v_red_id    uuid;
  v_cod_fee   integer := 0;
BEGIN
$n$),
  jsonb_build_object('old', $o$  IF v_method NOT IN ('transfer', 'paidy', 'square') THEN
    RETURN jsonb_build_object('error', 'bad_method');
  END IF;
$o$,
                     'new', $n$  IF v_method NOT IN ('transfer', 'paidy', 'square', 'cod') THEN
    RETURN jsonb_build_object('error', 'bad_method');
  END IF;
$n$),
  jsonb_build_object('old', $o$     OR (v_method = 'square' AND NOT public.square_card_allowed(p_customer_id)) THEN
    RETURN jsonb_build_object('error', 'method_unavailable', 'method', v_method);
  END IF;
$o$,
                     'new', $n$     OR (v_method = 'square' AND NOT public.square_card_allowed(p_customer_id))
     OR (v_method = 'cod' AND (public.cod_mode() <> 'on' OR coalesce(v_country, '') <> 'JP')) THEN
    RETURN jsonb_build_object('error', 'method_unavailable', 'method', v_method);
  END IF;
$n$),
  jsonb_build_object('old', $o$  v_seq       := CASE WHEN v_quote.mode = 'layaway'
$o$,
                     'new', $n$  IF v_method = 'cod' THEN
    v_cod_fee := public.cod_fee_jpy(v_total - v_pts_value);
    IF v_cod_fee IS NULL THEN
      RETURN jsonb_build_object('error', CASE WHEN v_total - v_pts_value <= 0 THEN 'cod_nothing_to_collect' ELSE 'over_cod_limit' END,
                                'method', v_method, 'collected', v_total - v_pts_value, 'limit', public.cod_limit_jpy());
    END IF;
  END IF;
  v_seq       := CASE WHEN v_quote.mode = 'layaway'
$n$),
  jsonb_build_object('old', $o$     SET payment_method = v_method, points = v_points, points_value = v_pts_value,
         points_redemption_id = v_red_id
   WHERE id = v_draft_id;
$o$,
                     'new', $n$     SET payment_method = v_method, points = v_points, points_value = v_pts_value,
         points_redemption_id = v_red_id,
         cod_fee_jpy = v_cod_fee, cod_fee = v_cod_fee,
         total = total + v_cod_fee, total_jpy = total_jpy + v_cod_fee
   WHERE id = v_draft_id;
$n$),
  jsonb_build_object('old', $o$  UPDATE public.checkout_quotes SET consumed_at = now() WHERE id = v_quote.id;
$o$,
                     'new', $n$  UPDATE public.checkout_quotes SET consumed_at = now(), cod_fee_jpy = v_cod_fee WHERE id = v_quote.id;
$n$),
  jsonb_build_object('old', $o$    'mode', v_quote.mode, 'currency', v_cur, 'total', v_total, 'total_jpy', v_quote.total_jpy,
$o$,
                     'new', $n$    'mode', v_quote.mode, 'currency', v_cur, 'total', v_total + v_cod_fee, 'total_jpy', v_quote.total_jpy + v_cod_fee,
    'cod_fee', v_cod_fee,
$n$)
));

-- 5b. materialize_web_draft_atomic: COD has no deadline (NULL accepted for 'cod' only, and forced
--     NULL); the fee sent by confirm-web-draft must equal cod_fee_jpy(collected) and stay within the
--     limit; points never pay the fee; the order carries cod_fee.
SELECT pg_temp.cj_patch('public.materialize_web_draft_atomic(uuid,uuid,jsonb,jsonb,jsonb)', '705947d28506eccffc57e78dcdade34b', jsonb_build_array(
  jsonb_build_object('old', $o$  v_approve   jsonb;
BEGIN
$o$,
                     'new', $n$  v_approve   jsonb;
  v_cod       numeric(12,2) := 0;
  v_collect   numeric(12,2);
BEGIN
$n$),
  jsonb_build_object('old', $o$  IF v_due IS NULL THEN
    RETURN jsonb_build_object('error', 'deadline_required');
  END IF;
$o$,
                     'new', $n$  IF coalesce(v_draft.payment_method, 'transfer') = 'cod' THEN
    v_due := NULL;
  ELSIF v_due IS NULL THEN
    RETURN jsonb_build_object('error', 'deadline_required');
  END IF;
$n$),
  jsonb_build_object('old', $o$  IF v_draft.points_redemption_id IS NOT NULL THEN
    SELECT * INTO v_red FROM public.loyalty_redemptions WHERE id = v_draft.points_redemption_id FOR UPDATE;
$o$,
                     'new', $n$  v_cod := coalesce((p_order ->> 'cod_fee')::numeric, 0);
  IF coalesce(v_draft.payment_method, 'transfer') = 'cod' THEN
    IF v_draft.mode <> 'full' OR v_draft.settlement_currency <> 'JPY' THEN
      RETURN jsonb_build_object('error', 'method_full_payment_only');
    END IF;
    v_collect := v_total - v_cod - coalesce(v_draft.points_value, 0);
    IF public.cod_fee_jpy(v_collect) IS NULL THEN
      RETURN jsonb_build_object('error', CASE WHEN v_collect <= 0 THEN 'cod_nothing_to_collect' ELSE 'over_cod_limit' END,
                                'collected', v_collect, 'limit', public.cod_limit_jpy());
    END IF;
    IF v_cod <> public.cod_fee_jpy(v_collect) THEN
      RETURN jsonb_build_object('error', 'cod_fee_mismatch', 'cod_fee', public.cod_fee_jpy(v_collect), 'sent', v_cod);
    END IF;
  ELSIF v_cod <> 0 THEN
    RETURN jsonb_build_object('error', 'cod_fee_not_cod');
  END IF;
  IF v_draft.points_redemption_id IS NOT NULL THEN
    SELECT * INTO v_red FROM public.loyalty_redemptions WHERE id = v_draft.points_redemption_id FOR UPDATE;
$n$),
  jsonb_build_object('old', $o$    ELSIF v_pts_value > v_total - v_shipping THEN
$o$,
                     'new', $n$    ELSIF v_pts_value > v_total - v_shipping - v_cod THEN
$n$),
  jsonb_build_object('old', $o$      ready_confirmed_at, ready_confirmed_by, created_by_user_id, fx_rate_used, fx_rate_date,
      planned_shipping_method_id
    ) VALUES (
$o$,
                     'new', $n$      ready_confirmed_at, ready_confirmed_by, created_by_user_id, fx_rate_used, fx_rate_date,
      planned_shipping_method_id, cod_fee
    ) VALUES (
$n$),
  jsonb_build_object('old', $o$      v_now, p_user_id, p_user_id, v_rate, v_rate_date,
      v_courier
    ) RETURNING id INTO v_order_id;
$o$,
                     'new', $n$      v_now, p_user_id, p_user_id, v_rate, v_rate_date,
      v_courier, v_cod
    ) RETURNING id INTO v_order_id;
$n$),
  jsonb_build_object('old', $o$                             'points_value', v_pts_value),
          p_user_id);
$o$,
                     'new', $n$                             'points_value', v_pts_value, 'cod_fee', v_cod),
          p_user_id);
$n$),
  jsonb_build_object('old', $o$                            'points_value', v_pts_value, 'points_approval', v_approve);
$o$,
                     'new', $n$                            'points_value', v_pts_value, 'points_approval', v_approve,
                            'cod_fee', v_cod);
$n$)
));

-- 5c. change_web_payment_method_atomic (staff): 'cod' with the checkout's eligibility; the fee is
--     re-bracketed and total / remaining move by the fee delta in the same transaction.
SELECT pg_temp.cj_patch('public.change_web_payment_method_atomic(text,uuid,text,text,uuid)', '4d07cf117230e17683ac15238ad52af8', jsonb_build_array(
  jsonb_build_object('old', $o$  v_cust   uuid;
BEGIN
$o$,
                     'new', $n$  v_cust   uuid;
  v_base   numeric(12,2);
  v_old_fee numeric(12,2) := 0;
  v_new_fee integer := 0;
  v_dl     jsonb;
BEGIN
$n$),
  jsonb_build_object('old', $o$  IF p_method IS NULL OR p_method NOT IN ('transfer', 'paidy', 'square') THEN
$o$,
                     'new', $n$  IF p_method IS NULL OR p_method NOT IN ('transfer', 'paidy', 'square', 'cod') THEN
$n$),
  jsonb_build_object('old', $o$     OR (p_method = 'square' AND NOT public.square_card_allowed(v_cust)) THEN
$o$,
                     'new', $n$     OR (p_method = 'square' AND NOT public.square_card_allowed(v_cust))
     OR (p_method = 'cod' AND (public.cod_mode() <> 'on' OR coalesce(v_country, '') <> 'JP')) THEN
$n$),
  jsonb_build_object('old', $o$  IF p_entity_type = 'draft' THEN
    UPDATE public.web_order_drafts SET payment_method = p_method, updated_at = now() WHERE id = p_entity_id;
  ELSE
    UPDATE public.cash_orders SET payment_method = p_method, updated_at = now() WHERE id = p_entity_id;
  END IF;
$o$,
                     'new', $n$  IF p_entity_type = 'draft' THEN
    SELECT total - coalesce(cod_fee, 0) - coalesce(points_value, 0), coalesce(cod_fee, 0)
      INTO v_base, v_old_fee FROM public.web_order_drafts WHERE id = p_entity_id;
  ELSE
    SELECT remaining_balance - coalesce(cod_fee, 0), coalesce(cod_fee, 0)
      INTO v_base, v_old_fee FROM public.cash_orders WHERE id = p_entity_id;
  END IF;
  IF p_method = 'cod' THEN
    v_new_fee := public.cod_fee_jpy(v_base);
    IF v_new_fee IS NULL THEN
      RETURN jsonb_build_object('error', CASE WHEN v_base <= 0 THEN 'cod_nothing_to_collect' ELSE 'over_cod_limit' END,
                                'method', p_method, 'collected', v_base, 'limit', public.cod_limit_jpy());
    END IF;
  END IF;
  IF p_entity_type = 'draft' THEN
    UPDATE public.web_order_drafts
       SET payment_method = p_method, cod_fee_jpy = v_new_fee, cod_fee = v_new_fee,
           total = total - v_old_fee + v_new_fee, total_jpy = total_jpy - v_old_fee::integer + v_new_fee,
           updated_at = now()
     WHERE id = p_entity_id;
  ELSE
    UPDATE public.cash_orders
       SET payment_method = p_method, cod_fee = v_new_fee,
           total_amount = total_amount - v_old_fee + v_new_fee,
           remaining_balance = remaining_balance - v_old_fee + v_new_fee,
           transfer_due_at = CASE WHEN p_method = 'cod' THEN NULL ELSE transfer_due_at END,
           expires_at = CASE WHEN p_method = 'cod' THEN NULL ELSE expires_at END,
           updated_at = now()
     WHERE id = p_entity_id;
    IF v_old = 'cod' AND p_method <> 'cod' AND v_ready IS NOT NULL THEN
      v_dl := public.set_account_deadlines('cash_order', p_entity_id,
                now() + make_interval(hours => public.web_deposit_deadline_hours(v_cust, p_entity_id)),
                'Payment method changed from cash on delivery: ' || v_reason, p_user_id);
      IF v_dl ? 'error' THEN
        RAISE EXCEPTION 'deadline_not_set: %', v_dl ->> 'error';
      END IF;
    END IF;
  END IF;
$n$),
  jsonb_build_object('old', $o$          jsonb_build_object('payment_method', p_method, 'reason', v_reason, 'reference', v_ref),
$o$,
                     'new', $n$          jsonb_build_object('payment_method', p_method, 'reason', v_reason, 'reference', v_ref,
                             'cod_fee', v_new_fee, 'old_cod_fee', v_old_fee::integer),
$n$),
  jsonb_build_object('old', $o$                            'old_method', v_old, 'payment_method', p_method, 'reference', v_ref);
$o$,
                     'new', $n$                            'old_method', v_old, 'payment_method', p_method, 'reference', v_ref,
                            'cod_fee', v_new_fee, 'old_cod_fee', v_old_fee::integer, 'fee_delta', v_new_fee - v_old_fee::integer,
                            'transfer_due_at', v_dl -> 'new' ->> 'transfer_due_at');
$n$)
));

-- 5d. switch_web_payment_method_by_customer_atomic (customer, after a rejection): the same COD
--     eligibility and fee delta.
SELECT pg_temp.cj_patch('public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text)', 'd1ade6ebaeef2a1737dcd7c7a8dbb511', jsonb_build_array(
  jsonb_build_object('old', $o$  v_decided_at timestamptz;
BEGIN
$o$,
                     'new', $n$  v_decided_at timestamptz;
  v_base     numeric(12,2);
  v_old_fee  numeric(12,2) := 0;
  v_new_fee  integer := 0;
  v_country  text;
  v_dl       jsonb;
BEGIN
$n$),
  jsonb_build_object('old', $o$  IF p_method IS NULL OR p_method NOT IN ('transfer', 'paidy', 'square') THEN
$o$,
                     'new', $n$  IF p_method IS NULL OR p_method NOT IN ('transfer', 'paidy', 'square', 'cod') THEN
$n$),
  jsonb_build_object('old', $o$  UPDATE public.cash_orders SET payment_method = p_method, updated_at = now() WHERE id = p_order_id;
$o$,
                     'new', $n$  SELECT remaining_balance - coalesce(cod_fee, 0), coalesce(cod_fee, 0),
         upper(nullif(btrim(coalesce(ship_to_snapshot ->> 'country', '')), ''))
    INTO v_base, v_old_fee, v_country FROM public.cash_orders WHERE id = p_order_id;
  IF p_method = 'cod' THEN
    IF public.cod_mode() <> 'on' OR coalesce(v_country, '') <> 'JP' THEN
      RETURN jsonb_build_object('error', 'method_unavailable', 'method', p_method);
    END IF;
    v_new_fee := public.cod_fee_jpy(v_base);
    IF v_new_fee IS NULL THEN
      RETURN jsonb_build_object('error', CASE WHEN v_base <= 0 THEN 'cod_nothing_to_collect' ELSE 'over_cod_limit' END,
                                'method', p_method);
    END IF;
  END IF;
  UPDATE public.cash_orders
     SET payment_method = p_method, cod_fee = v_new_fee,
         total_amount = total_amount - v_old_fee + v_new_fee,
         remaining_balance = remaining_balance - v_old_fee + v_new_fee,
         transfer_due_at = CASE WHEN p_method = 'cod' THEN NULL ELSE transfer_due_at END,
         expires_at = CASE WHEN p_method = 'cod' THEN NULL ELSE expires_at END,
         updated_at = now()
   WHERE id = p_order_id;
  IF v_old = 'cod' AND p_method <> 'cod' THEN
    v_dl := public.set_account_deadlines('cash_order', p_order_id,
              now() + make_interval(hours => public.web_deposit_deadline_hours(p_customer_id, p_order_id)),
              'Customer switched from cash on delivery after a rejected payment', NULL);
    IF v_dl ? 'error' THEN
      RAISE EXCEPTION 'deadline_not_set: %', v_dl ->> 'error';
    END IF;
  END IF;
$n$),
  jsonb_build_object('old', $o$          jsonb_build_object('payment_method', p_method, 'actor', 'customer',
                             'customer_id', p_customer_id, 'reference', v_ref),
$o$,
                     'new', $n$          jsonb_build_object('payment_method', p_method, 'actor', 'customer',
                             'customer_id', p_customer_id, 'reference', v_ref,
                             'cod_fee', v_new_fee, 'old_cod_fee', v_old_fee::integer),
$n$),
  jsonb_build_object('old', $o$                            'decision_id', v_decision_id);
$o$,
                     'new', $n$                            'decision_id', v_decision_id, 'cod_fee', v_new_fee, 'old_cod_fee', v_old_fee::integer);
$n$)
));

-- 5e. terminate_web_order_atomic: a COD order has no deadline, so it never lapses and no automated
--     path ends it (expire_web_order_atomic reaches this guard too). A staff cancel (refused parcel)
--     still runs and returns the stock.
SELECT pg_temp.cj_patch('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)', '2901b12e50afdc83dfc51ef07c91bc1b', jsonb_build_array(
  jsonb_build_object('old', $o$  IF v_status IN ('cancelled','expired') THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'already_terminal',
      'status', v_status, 'already_cancelled', (v_status = 'cancelled'));
  END IF;
$o$,
                     'new', $n$  IF v_status IN ('cancelled','expired') THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'already_terminal',
      'status', v_status, 'already_cancelled', (v_status = 'cancelled'));
  END IF;
  IF (p_outcome = 'expired' OR v_is_system)
     AND EXISTS (SELECT 1 FROM public.cash_orders WHERE id = p_order_id AND shipped_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'shipped', 'status', v_status);
  END IF;
  IF (p_outcome = 'expired' OR v_is_system)
     AND EXISTS (SELECT 1 FROM public.cash_orders WHERE id = p_order_id AND payment_method = 'cod') THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'cod_no_deadline', 'status', v_status);
  END IF;
$n$)
));

-- 5f. web_payment_reminder_eligible: no transfer reminder for a COD order.
SELECT pg_temp.cj_patch('public.web_payment_reminder_eligible(text,uuid)', '384a7617728fe87832646d9f98b47dfd', jsonb_build_array(
  jsonb_build_object('old', $o$       AND o.transfer_due_at IS NOT NULL
       AND o.remaining_balance > 0
$o$,
                     'new', $n$       AND o.transfer_due_at IS NOT NULL
       AND o.remaining_balance > 0
       AND coalesce(o.payment_method, 'transfer') <> 'cod'
$n$)
));

-- 5g. set_account_deadlines: a COD order has no payment deadline to set or move (review L2).
--     revive_web_cash_order_atomic is NOT patched: a COD order can never reach 'expired' (5e refuses
--     every automated termination and staff can only cancel), so revive cannot see one.
SELECT pg_temp.cj_patch('public.set_account_deadlines(text,uuid,timestamp with time zone,text,uuid)', '540e9b703377a02e3d4126143197ef79', jsonb_build_array(
  jsonb_build_object('old', $o$    UPDATE public.cash_orders
       SET transfer_due_at = p_transfer_due_at,
$o$,
                     'new', $n$    IF EXISTS (SELECT 1 FROM public.cash_orders WHERE id = p_entity_id AND payment_method = 'cod') THEN
      RETURN jsonb_build_object('error', 'cod_no_deadline');
    END IF;
    UPDATE public.cash_orders
       SET transfer_due_at = p_transfer_due_at,
$n$)
));

-- 5h. A COD order's money moves only with its method (review H2). Manage Invoice writes cash_orders
--     from the browser; an edit of total / shipping / discount / fee on an order that stays 'cod'
--     would drop or double the fee, so it is refused here. The two method-switch functions change
--     payment_method in the same UPDATE and pass.
CREATE OR REPLACE FUNCTION public.guard_cod_order_amount()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF OLD.payment_method = 'cod' AND NEW.payment_method = 'cod'
     AND (NEW.total_amount IS DISTINCT FROM OLD.total_amount
          OR NEW.shipping_fee IS DISTINCT FROM OLD.shipping_fee
          OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
          OR NEW.cod_fee IS DISTINCT FROM OLD.cod_fee) THEN
    RAISE EXCEPTION 'cod_amount_locked: this order is paid cash on delivery and its fee is bracketed on the amount collected. Change the payment method first (the fee is removed), edit, then switch back — or cancel and recreate the order.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_cod_order_amount() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_guard_cod_order_amount ON public.cash_orders;
CREATE TRIGGER trg_guard_cod_order_amount
BEFORE UPDATE OF total_amount, shipping_fee, discount_amount, cod_fee ON public.cash_orders
FOR EACH ROW EXECUTE FUNCTION public.guard_cod_order_amount();

-- ---------------------------------------------------------------------------
-- 6. Self-check (grants included). Anything unexpected rolls the whole migration back.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  v_def text;
BEGIN
  IF public.cod_mode() NOT IN ('off','on') OR public.cod_limit_jpy() IS NULL THEN
    RAISE EXCEPTION 'STOP — cod settings unreadable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_cod_settings') THEN
    RAISE EXCEPTION 'STOP — trg_guard_cod_settings missing';
  END IF;
  IF public.cod_fee_table_valid('[{"max_jpy":10000,"fee_jpy":1040},{"max_jpy":30000,"fee_jpy":1150},{"max_jpy":100000,"fee_jpy":1370},{"max_jpy":300000,"fee_jpy":1810}]'::jsonb) IS NOT TRUE
     OR public.cod_fee_table_valid('[{"max_jpy":30000,"fee_jpy":1150},{"max_jpy":10000,"fee_jpy":1040}]'::jsonb) IS NOT FALSE THEN
    RAISE EXCEPTION 'STOP — cod_fee_table_valid wrong';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'cash_orders_payment_method_check')) NOT LIKE '%cod%'
     OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'web_order_drafts_payment_method_check')) NOT LIKE '%cod%'
     OR pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'checkout_quotes_payment_method_check')) NOT LIKE '%cod%' THEN
    RAISE EXCEPTION 'STOP — payment_method CHECKs do not allow cod';
  END IF;
  v_def := pg_get_functiondef('public.create_web_draft_atomic(uuid,uuid,text,text,timestamptz)'::regprocedure);
  IF position('v_cod_fee := public.cod_fee_jpy(v_total - v_pts_value);' IN v_def) = 0 THEN
    RAISE EXCEPTION 'STOP — create_web_draft_atomic not patched';
  END IF;
  v_def := pg_get_functiondef('public.materialize_web_draft_atomic(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
  IF position('cod_fee_mismatch' IN v_def) = 0 OR position('planned_shipping_method_id, cod_fee' IN v_def) = 0 THEN
    RAISE EXCEPTION 'STOP — materialize_web_draft_atomic not patched';
  END IF;
  IF position('v_new_fee := public.cod_fee_jpy(v_base);' IN pg_get_functiondef('public.change_web_payment_method_atomic(text,uuid,text,text,uuid)'::regprocedure)) = 0
     OR position('v_new_fee := public.cod_fee_jpy(v_base);' IN pg_get_functiondef('public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'STOP — method switch functions not patched';
  END IF;
  IF position('cod_no_deadline' IN pg_get_functiondef('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)'::regprocedure)) = 0
     OR position($q$coalesce(o.payment_method, 'transfer') <> 'cod'$q$ IN pg_get_functiondef('public.web_payment_reminder_eligible(text,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'STOP — expiry / reminder skip not patched';
  END IF;
  IF position($q$'reason', 'shipped'$q$ IN pg_get_functiondef('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)'::regprocedure)) = 0
     OR position('cod_no_deadline' IN pg_get_functiondef('public.set_account_deadlines(text,uuid,timestamptz,text,uuid)'::regprocedure)) = 0
     OR position('Payment method changed from cash on delivery' IN pg_get_functiondef('public.change_web_payment_method_atomic(text,uuid,text,text,uuid)'::regprocedure)) = 0
     OR position('Customer switched from cash on delivery' IN pg_get_functiondef('public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text)'::regprocedure)) = 0
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_cod_order_amount') THEN
    RAISE EXCEPTION 'STOP — review fixes (H1 / H2 / M1 / L2) not complete';
  END IF;
  IF has_function_privilege('anon', 'public.set_cod_settings(text,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_cod_settings()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.cod_fee_jpy(numeric)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cod_fee_jpy(numeric)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.cod_mode()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.cod_limit_jpy()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_cod_settings()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_cod_settings(text,jsonb,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.cod_fee_jpy(numeric)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.create_web_draft_atomic(uuid,uuid,text,text,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.materialize_web_draft_atomic(uuid,uuid,jsonb,jsonb,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.change_web_payment_method_atomic(text,uuid,text,text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.set_account_deadlines(text,uuid,timestamptz,text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_cod_order_amount()', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — grants not as expected';
  END IF;
END
$self$;
