-- ===========================================================================
-- Website orders PR 3 of 10 — DRAFT FOUNDATION, DORMANT (owner "go PR3",
-- 2026-09-29). Plan: ~/Code/reference/website-orders/INVESTIGATION-v2.md
-- §2.1, §2.4, §2.8, §2.9, §7 row 3; decisions W2-1..W2-12 approved 2026-09-27.
-- Full text: docs/WEB-ORDER-DRAFTS.md.
--
-- WHAT CHANGES FOR ANYONE TODAY: NOTHING. The new switch web_checkout_mode is
-- seeded 'order' (today's checkout). Nothing calls the new writers until PR 4
-- (review screen + Confirm) and PR 6 (website checkout) ship and the owner
-- flips the switch (PR 8).
--
-- WHAT IT ADDS
--   1. web_order_drafts + web_order_draft_lines. A website checkout (in
--      'draft' mode) writes a DRAFT, not an order: the piece is held (stock
--      taken, line hold_state 'held'), nothing is booked. Staff confirm it on
--      the review screen (PR 4), which creates the real cash order / layaway
--      plan from the final figures (shipping, service lines, discount).
--   2. create_web_draft_atomic   — the checkout's writer (service role).
--      decline_web_draft_atomic  — "Can't supply" / the 72h expiry; stock back.
--      expire_web_drafts_atomic  — the sweep (72h unconfirmed).
--      materialize_web_draft_atomic — Confirm's single SQL write: order row,
--        schedule, lines, hold TRANSFERRED (no second stock move), draft
--        confirmed, service requests re-pointed, audit. One transaction, so a
--        web row is never half-written (trg_prevent_web_*_delete).
--   3. web_released_at on cash_orders / layaway_accounts, stamped by AFTER
--      triggers on payments and cash_payments on the FIRST real payment
--      (loyalty redemption excluded; store credit counts). Sticky. Backfilled.
--      The park area (PR 5) lists web orders until this is set.
--   4. web_checkout_mode ('order' | 'draft'), fail-closed to 'order'; changed
--      only by set_web_checkout_mode (admin, audited, guard trigger).
--   5. service_requests.web_draft_id (W2-5): a request may target a draft;
--      Confirm re-points it to the new order.
--   6. Three live functions extended so drafts are seen:
--      page365_web_holds (a held draft line keeps the piece off sale during
--      the Page365 inventory sync — without this the next scheduled read puts
--      a drafted piece back on sale), email_delivery_report (draft emails are
--      expected), web_reservation_expiring_bells (48h bell for drafts).
--      FUNCTION CHANGES START FROM LIVE (Bug #280): each is md5-guarded against
--      the live body; any other body aborts with nothing changed.
--   7. A staff bell on every new draft: "New website order — confirm the piece".
--
-- Re-running is safe: IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT, and the
-- md5 guards accept this file's own bodies.
-- ===========================================================================

BEGIN;

-- --------------------------------------------------------------- 0. pre-flight
DO $pre$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.page365_web_holds(uuid)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('6417708e3c92f960abb519fca2daea5b', '45bb5a67f283468824870545ca41c204') THEN
    RAISE EXCEPTION 'web_drafts: live page365_web_holds differs from the repo (md5 %) — stop and send its pg_get_functiondef', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.email_delivery_report(integer)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('c5e8e93e89c8edc2cdcfc9383880360a', '640083183d6b994101543ebbea7810eb') THEN
    RAISE EXCEPTION 'web_drafts: live email_delivery_report differs from the repo (md5 %) — stop and send its pg_get_functiondef', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.web_reservation_expiring_bells()');
  IF v_md5 IS NULL OR v_md5 NOT IN ('0909b5efefdac33ea37d9d0078e7850c', 'a90b52945e1acde7c279d3190a99ee8e') THEN
    RAISE EXCEPTION 'web_drafts: live web_reservation_expiring_bells differs from the repo (md5 %) — stop and send its pg_get_functiondef', v_md5;
  END IF;

  IF to_regclass('public.web_order_number_seq') IS NULL THEN
    RAISE EXCEPTION 'web_drafts: sequence web_order_number_seq is missing';
  END IF;
  IF to_regprocedure('public.has_permission(uuid,text)') IS NULL
     OR to_regprocedure('public.address_snapshot(uuid)') IS NULL
     OR to_regprocedure('public.layaway_quote(integer,integer,text,date,integer,integer)') IS NULL
     OR to_regprocedure('public.staff_notify(text,text,text,uuid,uuid,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'web_drafts: a helper function is missing (has_permission / address_snapshot / layaway_quote / staff_notify)';
  END IF;
  -- service_requests is a live-only table (docs/SERVICE-REQUESTS.md): check the
  -- shape this file relies on before touching it.
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'service_requests'
         AND column_name IN ('cash_order_id', 'layaway_account_id')) <> 2 THEN
    RAISE EXCEPTION 'web_drafts: service_requests does not have cash_order_id + layaway_account_id';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('cash_orders', 'layaway_accounts')
         AND column_name IN ('ready_confirmed_at', 'ready_confirmed_by', 'planned_shipping_method_id',
                             'ship_to_snapshot', 'web_reference', 'quote_id', 'fx_rate_used')) <> 14 THEN
    RAISE EXCEPTION 'web_drafts: an expected web column is missing on cash_orders / layaway_accounts';
  END IF;
END
$pre$;

-- ------------------------------------------------------------------- 1. tables
CREATE TABLE IF NOT EXISTS public.web_order_drafts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One draft per checkout quote; the quote id stays the agreement's key (§2.6).
  quote_id            uuid NOT NULL UNIQUE REFERENCES public.checkout_quotes(id),
  customer_id         uuid NOT NULL REFERENCES public.customers(id),
  mode                text NOT NULL CHECK (mode IN ('full', 'layaway')),
  term_months         integer,
  -- Money as quoted. Yen figures are the quote's; the settlement-currency
  -- figures are the quote converted ONCE at the quote's rate (the same
  -- integer half-up as create_web_order_atomic). All PROVISIONAL: shipping and
  -- service lines may be added at confirmation.
  settlement_currency text NOT NULL DEFAULT 'JPY' CHECK (settlement_currency IN ('JPY', 'PHP')),
  fx_rate             numeric(12,6),
  fx_rate_date        date,
  subtotal_jpy        integer NOT NULL CHECK (subtotal_jpy >= 0),
  shipping_jpy        integer CHECK (shipping_jpy >= 0),          -- NULL = added at confirmation
  total_jpy           integer NOT NULL CHECK (total_jpy > 0),
  subtotal            numeric(12,2) NOT NULL,
  shipping            numeric(12,2),                               -- NULL = added at confirmation
  total               numeric(12,2) NOT NULL,
  deposit             numeric(12,2),                               -- layaway, provisional
  schedule            jsonb,                                       -- layaway, provisional
  -- Where it goes: the address AS IT WAS at checkout (CUSTOMER ADDRESSES rule).
  ship_to_address_id  uuid REFERENCES public.customer_addresses(id) ON DELETE SET NULL,
  ship_to_snapshot    jsonb,
  country             text,
  order_type          text NOT NULL DEFAULT 'SELF',
  recipient_name      text,
  recipient_phone     text,
  gift_note           text,
  customer_lang       text CHECK (customer_lang IS NULL OR customer_lang IN ('ja', 'en')),
  agreement_version   text,
  agreement_signed_at timestamptz,
  -- The invoice number, reserved now for BOTH modes, so every email about
  -- this checkout carries the number the order will have.
  invoice_seq         bigint NOT NULL UNIQUE,
  web_reference       text NOT NULL UNIQUE,
  status              text NOT NULL DEFAULT 'to_confirm'
                        CHECK (status IN ('to_confirm', 'confirmed', 'declined', 'expired')),
  reservation_reminded_at timestamptz,
  decided_at          timestamptz,
  decided_by          uuid,
  decline_reason      text,
  cash_order_id       uuid REFERENCES public.cash_orders(id),
  layaway_account_id  uuid REFERENCES public.layaway_accounts(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT web_order_drafts_term CHECK ((mode = 'layaway') = (term_months IS NOT NULL)),
  CONSTRAINT web_order_drafts_fx CHECK (settlement_currency = 'JPY' OR fx_rate > 0),
  -- A plan may not exist unless the customer signed the agreement (AGR:4-6).
  CONSTRAINT web_order_drafts_agreement CHECK (
    mode = 'full' OR (agreement_version IS NOT NULL AND agreement_signed_at IS NOT NULL)),
  CONSTRAINT web_order_drafts_outcome CHECK (
    CASE status
      WHEN 'confirmed' THEN (mode = 'full'    AND cash_order_id IS NOT NULL AND layaway_account_id IS NULL)
                         OR (mode = 'layaway' AND layaway_account_id IS NOT NULL AND cash_order_id IS NULL)
      ELSE cash_order_id IS NULL AND layaway_account_id IS NULL
    END),
  CONSTRAINT web_order_drafts_decided CHECK ((status = 'to_confirm') = (decided_at IS NULL))
);

CREATE INDEX IF NOT EXISTS web_order_drafts_open_idx ON public.web_order_drafts (created_at) WHERE status = 'to_confirm';
CREATE INDEX IF NOT EXISTS web_order_drafts_customer_idx ON public.web_order_drafts (customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS web_order_drafts_cash_order_uq ON public.web_order_drafts (cash_order_id) WHERE cash_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS web_order_drafts_layaway_uq ON public.web_order_drafts (layaway_account_id) WHERE layaway_account_id IS NOT NULL;

COMMENT ON TABLE public.web_order_drafts IS
  'Website orders PR 3 (2026-09-29). One row per website checkout in draft mode: the piece is held, nothing is booked until staff confirm it on the review screen (materialize_web_draft_atomic creates the real cash order / layaway plan). Written ONLY by the *_web_draft_atomic functions (service role). docs/WEB-ORDER-DRAFTS.md.';

CREATE TABLE IF NOT EXISTS public.web_order_draft_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id           uuid NOT NULL REFERENCES public.web_order_drafts(id),
  -- ON DELETE SET NULL like cash_order_items / layaway_account_items: a
  -- variant removed from the catalogue must not block anything; its hold then
  -- has nothing to return to.
  variant_id         uuid REFERENCES public.website_product_variants(id) ON DELETE SET NULL,
  website_product_id uuid REFERENCES public.website_products(id) ON DELETE SET NULL,
  title              text NOT NULL,
  sku                text,
  qty                integer NOT NULL CHECK (qty > 0),
  unit_price_jpy     integer NOT NULL CHECK (unit_price_jpy >= 0),
  line_total_jpy     integer NOT NULL CHECK (line_total_jpy >= 0),
  image_url          text,
  -- held: stock taken for this draft; released: given back (declined/expired);
  -- transferred: now an order line (Confirm) — never a second stock movement.
  hold_state         text NOT NULL DEFAULT 'held' CHECK (hold_state IN ('held', 'released', 'transferred')),
  released_at        timestamptz,
  transferred_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS web_order_draft_lines_draft_idx ON public.web_order_draft_lines (draft_id);
CREATE INDEX IF NOT EXISTS web_order_draft_lines_held_idx ON public.web_order_draft_lines (variant_id) WHERE hold_state = 'held';

COMMENT ON TABLE public.web_order_draft_lines IS
  'Website orders PR 3. The pieces of a web_order_drafts row, each holding its stock (hold_state). page365_web_holds counts held lines so the Page365 inventory sync never puts a drafted piece back on sale.';

-- Staff read (the park area and review screen); every write goes through the
-- SECURITY DEFINER functions below. has_permission is SECURITY DEFINER, so the
-- policy reads no other RLS table (Bug #165), and it runs once per statement
-- inside a scalar sub-select (PR #265).
ALTER TABLE public.web_order_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.web_order_draft_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS web_order_drafts_staff_read ON public.web_order_drafts;
CREATE POLICY web_order_drafts_staff_read ON public.web_order_drafts
  FOR SELECT TO authenticated
  USING ((SELECT public.has_permission((SELECT auth.uid()), 'confirm_web_order_ready')));

DROP POLICY IF EXISTS web_order_draft_lines_staff_read ON public.web_order_draft_lines;
CREATE POLICY web_order_draft_lines_staff_read ON public.web_order_draft_lines
  FOR SELECT TO authenticated
  USING ((SELECT public.has_permission((SELECT auth.uid()), 'confirm_web_order_ready')));

REVOKE ALL ON public.web_order_drafts, public.web_order_draft_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.web_order_drafts, public.web_order_draft_lines TO authenticated;
GRANT ALL ON public.web_order_drafts, public.web_order_draft_lines TO service_role;

-- ------------------------------------------------ 2. released stamp (R7, §2.8)
ALTER TABLE public.cash_orders      ADD COLUMN IF NOT EXISTS web_released_at timestamptz;
ALTER TABLE public.layaway_accounts ADD COLUMN IF NOT EXISTS web_released_at timestamptz;

COMMENT ON COLUMN public.cash_orders.web_released_at IS
  'Website orders (PR 3). When a WEB order received its first real payment (loyalty redemption excluded, store credit counts). Stamped by trg_web_released_* on cash_payments; sticky — a later void does not clear it. NULL on a web order = still in the park area (Awaiting payment). Always NULL on Hub orders.';
COMMENT ON COLUMN public.layaway_accounts.web_released_at IS
  'Website orders (PR 3). When a WEB plan received its first real payment (loyalty redemption excluded, store credit counts). Stamped by trg_web_released_* on payments; sticky. NULL on a web plan = still in the park area. Always NULL on Hub plans.';

CREATE INDEX IF NOT EXISTS cash_orders_web_released_idx ON public.cash_orders (web_released_at) WHERE source_channel = 'web';
CREATE INDEX IF NOT EXISTS layaway_accounts_web_released_idx ON public.layaway_accounts (web_released_at) WHERE source_channel = 'web';

CREATE OR REPLACE FUNCTION public.web_mark_released()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  -- Money, not points: a loyalty redemption is a discount (STORE CREDIT rule:
  -- LOYALTY-% is synthetic). Store credit is real money and counts.
  IF NEW.voided_at IS NULL AND coalesce(NEW.amount_paid, 0) > 0
     AND NEW.payment_method IS DISTINCT FROM 'loyalty_redemption'
     AND coalesce(NEW.reference_number, '') NOT LIKE 'LOYALTY-%' THEN
    IF TG_TABLE_NAME = 'payments' THEN
      UPDATE public.layaway_accounts SET web_released_at = now()
       WHERE id = NEW.account_id AND source_channel = 'web' AND web_released_at IS NULL;
    ELSE
      UPDATE public.cash_orders SET web_released_at = now()
       WHERE id = NEW.cash_order_id AND source_channel = 'web' AND web_released_at IS NULL;
    END IF;
  END IF;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.web_mark_released() FROM PUBLIC, anon, authenticated;

-- UPDATE OF voided_at catches a restore (restore-payment / restore-cash-payment
-- un-void rather than insert). One trigger covers every write path (§1.5).
DROP TRIGGER IF EXISTS trg_web_released_payments ON public.payments;
CREATE TRIGGER trg_web_released_payments
AFTER INSERT OR UPDATE OF voided_at, amount_paid ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.web_mark_released();

DROP TRIGGER IF EXISTS trg_web_released_cash_payments ON public.cash_payments;
CREATE TRIGGER trg_web_released_cash_payments
AFTER INSERT OR UPDATE OF voided_at, amount_paid ON public.cash_payments
FOR EACH ROW EXECUTE FUNCTION public.web_mark_released();

-- Backfill: every existing web order that already has a qualifying payment,
-- stamped with that payment's time.
UPDATE public.layaway_accounts a
   SET web_released_at = q.first_paid
  FROM (SELECT p.account_id, min(p.created_at) AS first_paid
          FROM public.payments p
         WHERE p.voided_at IS NULL AND p.amount_paid > 0
           AND p.payment_method IS DISTINCT FROM 'loyalty_redemption'
           AND coalesce(p.reference_number, '') NOT LIKE 'LOYALTY-%'
         GROUP BY p.account_id) q
 WHERE a.id = q.account_id AND a.source_channel = 'web' AND a.web_released_at IS NULL;

UPDATE public.cash_orders o
   SET web_released_at = q.first_paid
  FROM (SELECT p.cash_order_id, min(p.created_at) AS first_paid
          FROM public.cash_payments p
         WHERE p.voided_at IS NULL AND p.amount_paid > 0
           AND p.payment_method IS DISTINCT FROM 'loyalty_redemption'
           AND coalesce(p.reference_number, '') NOT LIKE 'LOYALTY-%'
         GROUP BY p.cash_order_id) q
 WHERE o.id = q.cash_order_id AND o.source_channel = 'web' AND o.web_released_at IS NULL;

-- ---------------------------------------------------- 3. the switch (§2.9)
INSERT INTO public.system_settings (key, value, description)
VALUES ('web_checkout_mode', '"order"'::jsonb,
        'Website orders (2026-09-29). ''order'' = today''s checkout (the website creates the order / reservation at pay). ''draft'' = checkout creates a DRAFT that staff confirm on the review screen, which creates the real order from the final figures. Fails closed to ''order''. Changed ONLY by set_web_checkout_mode (admin, audited). Flip to draft only once website-orders PRs 4–7 are live (PR 8).')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.web_checkout_mode()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  -- Fail closed: anything but exactly "draft" is today's path.
  SELECT CASE WHEN (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'web_checkout_mode') = 'draft'
              THEN 'draft' ELSE 'order' END
$fn$;

REVOKE ALL ON FUNCTION public.web_checkout_mode() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_checkout_mode() TO service_role;

CREATE OR REPLACE FUNCTION public.guard_web_checkout_mode()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF (OLD.key = 'web_checkout_mode'
      AND (TG_OP = 'DELETE' OR NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value))
     OR (TG_OP = 'UPDATE' AND NEW.key = 'web_checkout_mode' AND OLD.key <> 'web_checkout_mode')
  THEN
    IF coalesce(current_setting('app.allow_web_checkout_mode_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'web_checkout_mode is changed only from the Hub (set_web_checkout_mode).'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;

REVOKE ALL ON FUNCTION public.guard_web_checkout_mode() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_web_checkout_mode ON public.system_settings;
CREATE TRIGGER trg_guard_web_checkout_mode
BEFORE UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_web_checkout_mode();

CREATE OR REPLACE FUNCTION public.get_web_checkout_mode()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_row     public.system_settings%ROWTYPE;
  v_by_name text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'user_identity_required');
  END IF;
  IF NOT (public.has_role(v_uid, 'admin'::public.app_role)
          OR public.has_permission(v_uid, 'manage_website_content')
          OR public.has_permission(v_uid, 'confirm_web_order_ready')) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  SELECT * INTO v_row FROM public.system_settings WHERE key = 'web_checkout_mode';
  IF v_row.updated_by_user_id IS NOT NULL THEN
    SELECT full_name INTO v_by_name FROM public.profiles WHERE user_id = v_row.updated_by_user_id LIMIT 1;
  END IF;
  RETURN jsonb_build_object(
    'found',              v_row.id IS NOT NULL,
    'mode',               public.web_checkout_mode(),
    'raw_value',          v_row.value,
    'updated_at',         v_row.updated_at,
    'updated_by_user_id', v_row.updated_by_user_id,
    'updated_by_name',    v_by_name,
    'can_change',         public.has_role(v_uid, 'admin'::public.app_role),
    'drafts_to_confirm',  (SELECT count(*) FROM public.web_order_drafts WHERE status = 'to_confirm')
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.get_web_checkout_mode() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_web_checkout_mode() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_web_checkout_mode(p_mode text, p_expected text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.system_settings%ROWTYPE;
  v_old text;
  v_now timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'user_identity_required');
  END IF;
  -- ADMIN ONLY — by role, not by permission key, so no override can grant it.
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('order', 'draft') THEN
    RETURN jsonb_build_object('error', 'invalid_mode');
  END IF;

  SELECT * INTO v_row FROM public.system_settings WHERE key = 'web_checkout_mode' FOR UPDATE;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'setting_missing');
  END IF;
  v_old := public.web_checkout_mode();

  IF p_expected IS NOT NULL AND p_expected IS DISTINCT FROM v_old THEN
    RETURN jsonb_build_object('error', 'stale', 'mode', v_old);
  END IF;
  IF v_old = p_mode AND v_row.value = to_jsonb(p_mode) THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'mode', v_old);
  END IF;

  PERFORM set_config('app.allow_web_checkout_mode_change', 'on', true);
  UPDATE public.system_settings
     SET value = to_jsonb(p_mode), updated_by_user_id = v_uid, updated_at = v_now
   WHERE id = v_row.id;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('system_setting', v_row.id, 'set_web_checkout_mode',
          jsonb_build_object('key', 'web_checkout_mode', 'value', v_row.value, 'mode', v_old,
                             'updated_at', v_row.updated_at, 'updated_by_user_id', v_row.updated_by_user_id),
          jsonb_build_object('key', 'web_checkout_mode', 'value', to_jsonb(p_mode), 'mode', p_mode,
                             'drafts_to_confirm', (SELECT count(*) FROM public.web_order_drafts WHERE status = 'to_confirm')),
          v_uid, v_now);
  PERFORM set_config('app.allow_web_checkout_mode_change', '', true);

  RETURN jsonb_build_object('ok', true, 'changed', true, 'mode', p_mode, 'old_mode', v_old, 'updated_at', v_now);
END
$fn$;

REVOKE ALL ON FUNCTION public.set_web_checkout_mode(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_web_checkout_mode(text, text) TO authenticated, service_role;

-- ------------------------------------------- 4. service requests on a draft (W2-5)
ALTER TABLE public.service_requests
  ADD COLUMN IF NOT EXISTS web_draft_id uuid REFERENCES public.web_order_drafts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS service_requests_web_draft_idx ON public.service_requests (web_draft_id) WHERE web_draft_id IS NOT NULL;
ALTER TABLE public.service_requests DROP CONSTRAINT IF EXISTS service_requests_check;
ALTER TABLE public.service_requests DROP CONSTRAINT IF EXISTS service_requests_target_check;
ALTER TABLE public.service_requests ADD CONSTRAINT service_requests_target_check
  CHECK (cash_order_id IS NOT NULL OR layaway_account_id IS NOT NULL OR web_draft_id IS NOT NULL);
COMMENT ON COLUMN public.service_requests.web_draft_id IS
  'Website orders PR 3 (W2-5). A request filed on a website draft before it is confirmed. materialize_web_draft_atomic points the request at the new order and keeps this link as history.';

-- ------------------------------------------------ 5. the draft writer (§2.1)
-- The checkout's writer in 'draft' mode (PR 6 calls it from the website edge
-- function, service role). One transaction: the quote is checked and
-- consumed, the invoice number reserved, the address snapshotted, the stock
-- held. Refusals are returned as {error}, exactly like
-- create_web_order_atomic / create_web_layaway_atomic, whose checks it keeps.
CREATE OR REPLACE FUNCTION public.create_web_draft_atomic(
  p_customer_id         uuid,
  p_quote_id            uuid,
  p_lang                text DEFAULT NULL,
  p_agreement_version   text DEFAULT NULL,
  p_agreement_signed_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_quote     public.checkout_quotes%ROWTYPE;
  v_item      jsonb;
  v_variant   public.website_product_variants%ROWTYPE;
  v_qty       integer;
  v_updated   integer;
  v_seq       bigint;
  v_reference text;
  v_draft_id  uuid;
  v_lang      text := CASE WHEN p_lang IN ('ja', 'en') THEN p_lang ELSE NULL END;
  v_agr_ver   text := nullif(btrim(coalesce(p_agreement_version, '')), '');
  v_cur       text;
  v_rate      numeric(12,6);
  v_total     numeric(12,2);
  v_shipping  numeric(12,2);
  v_subtotal  numeric(12,2);
  v_snapshot  jsonb;
  v_country   text;
  v_q         jsonb;
  v_deposit   numeric(12,2);
  v_schedule  jsonb;
  v_title     text;
  v_lines     integer := 0;
BEGIN
  -- Dormant until the owner flips the switch (PR 8): the edge function only
  -- calls this in 'draft' mode, and this refuses otherwise.
  IF public.web_checkout_mode() <> 'draft' THEN
    RETURN jsonb_build_object('error', 'checkout_mode_not_draft');
  END IF;

  SELECT * INTO v_quote FROM public.checkout_quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND OR v_quote.customer_id <> p_customer_id THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'quote_already_used');
  END IF;
  IF v_quote.expires_at <= now() THEN
    RETURN jsonb_build_object('error', 'quote_expired');
  END IF;
  IF v_quote.mode NOT IN ('full', 'layaway') THEN
    RETURN jsonb_build_object('error', 'unsupported_mode');
  END IF;
  IF coalesce(v_quote.total_jpy, 0) <= 0 THEN
    RETURN jsonb_build_object('error', 'empty_quote');
  END IF;
  IF v_quote.mode = 'layaway' AND (v_agr_ver IS NULL OR p_agreement_signed_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'agreement_missing');
  END IF;

  v_snapshot := public.address_snapshot(v_quote.ship_to_address_id);
  v_country  := upper(nullif(btrim(coalesce(v_snapshot ->> 'country', '')), ''));

  -- Shipping may be added at confirmation (R4) — but never for a destination
  -- that HAS a rate card: there the quote must carry the fee.
  IF v_quote.shipping_jpy IS NULL AND v_country IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.shipping_rates r WHERE r.country = v_country AND r.is_active) THEN
    RETURN jsonb_build_object('error', 'shipping_quote_required');
  END IF;

  -- The customer's currency, converted ONCE at the quote's rate: the same
  -- arithmetic as create_web_order_atomic / create_web_layaway_atomic (whole
  -- pesos half-up; shipping on its own, items the remainder).
  v_cur := coalesce(v_quote.settlement_currency, 'JPY');
  IF v_cur = 'PHP' THEN
    v_rate := v_quote.fx_rate;
    IF v_rate IS NULL OR v_rate <= 0 THEN
      RETURN jsonb_build_object('error', 'fx_rate_missing');
    END IF;
    v_total    := round(v_quote.total_jpy * v_rate);
    v_shipping := CASE WHEN v_quote.shipping_jpy IS NULL THEN NULL ELSE round(v_quote.shipping_jpy * v_rate) END;
  ELSE
    v_cur      := 'JPY';
    v_rate     := NULL;
    v_total    := v_quote.total_jpy;
    v_shipping := v_quote.shipping_jpy;
  END IF;
  v_subtotal := v_total - coalesce(v_shipping, 0);

  -- A layaway is checked against the plan minimum now (as today), so a draft
  -- that could never be confirmed is never written. Figures are provisional.
  IF v_quote.mode = 'layaway' THEN
    v_q := public.layaway_quote(v_subtotal::integer, v_quote.term_months, v_cur,
                                (now() AT TIME ZONE 'Asia/Manila')::date, coalesce(v_shipping, 0)::integer, 0);
    IF NOT coalesce((v_q ->> 'eligible')::boolean, false)
       OR coalesce((v_q ->> 'term_downgraded')::boolean, false) THEN
      RETURN jsonb_build_object('error', 'below_plan_minimum', 'total', v_total, 'currency', v_cur,
                                'requested_term_months', v_quote.term_months,
                                'max_term_months', v_q -> 'max_term_months');
    END IF;
    v_deposit  := (v_q ->> 'deposit')::numeric;
    v_schedule := v_q -> 'schedule';
  END IF;

  -- The number: a layaway's was reserved at quote time (the agreement was
  -- signed against it); a cash order's is drawn now.
  v_seq       := CASE WHEN v_quote.mode = 'layaway'
                      THEN coalesce(v_quote.reserved_invoice_seq, nextval('public.web_order_number_seq'))
                      ELSE nextval('public.web_order_number_seq') END;
  v_reference := 'CJ-W-' || lpad(v_seq::text, 6, '0');

  INSERT INTO public.web_order_drafts (
    quote_id, customer_id, mode, term_months,
    settlement_currency, fx_rate, fx_rate_date,
    subtotal_jpy, shipping_jpy, total_jpy, subtotal, shipping, total, deposit, schedule,
    ship_to_address_id, ship_to_snapshot, country, order_type, recipient_name, recipient_phone, gift_note,
    customer_lang, agreement_version, agreement_signed_at, invoice_seq, web_reference
  ) VALUES (
    v_quote.id, p_customer_id, v_quote.mode, CASE WHEN v_quote.mode = 'layaway' THEN v_quote.term_months END,
    v_cur, v_rate, CASE WHEN v_rate IS NULL THEN NULL ELSE v_quote.fx_rate_date END,
    v_quote.subtotal_jpy, v_quote.shipping_jpy, v_quote.total_jpy, v_subtotal, v_shipping, v_total, v_deposit, v_schedule,
    v_quote.ship_to_address_id, v_snapshot, v_country, coalesce(v_quote.order_type, 'SELF'),
    v_quote.recipient_name, v_quote.recipient_phone, v_quote.gift_note,
    v_lang,
    CASE WHEN v_quote.mode = 'layaway' THEN v_agr_ver END,
    CASE WHEN v_quote.mode = 'layaway' THEN p_agreement_signed_at END,
    v_seq, v_reference
  ) RETURNING id INTO v_draft_id;

  -- Hold the pieces: the same guarded decrement as the order writers.
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_quote.items) LOOP
    v_qty := GREATEST(coalesce((v_item ->> 'qty')::int, 1), 1);
    SELECT * INTO v_variant FROM public.website_product_variants WHERE id = (v_item ->> 'variant_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'variant_missing:%', v_item ->> 'variant_id';
    END IF;
    UPDATE public.website_product_variants
       SET stock_qty = stock_qty - v_qty, updated_at = now()
     WHERE id = v_variant.id AND stock_qty >= v_qty;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RAISE EXCEPTION 'out_of_stock:%', v_variant.id;
    END IF;
    SELECT trim(both ' ' FROM p.name
                 || coalesce(' / ' || nullif(v_variant.size, ''), '')
                 || coalesce(' / ' || nullif(v_variant.stone, ''), ''))
      INTO v_title FROM public.website_products p WHERE p.id = v_variant.product_id;
    INSERT INTO public.web_order_draft_lines (
      draft_id, variant_id, website_product_id, title, sku, qty, unit_price_jpy, line_total_jpy
    ) VALUES (
      v_draft_id, v_variant.id, v_variant.product_id, coalesce(v_title, 'Item'),
      (SELECT p.sku FROM public.website_products p WHERE p.id = v_variant.product_id),
      v_qty, v_variant.price_jpy, v_variant.price_jpy * v_qty
    );
    v_lines := v_lines + 1;
  END LOOP;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'empty_quote:';
  END IF;

  UPDATE public.checkout_quotes SET consumed_at = now() WHERE id = v_quote.id;

  RETURN jsonb_build_object(
    'ok', true, 'draft_id', v_draft_id, 'web_reference', v_reference, 'invoice_number', v_seq::text,
    'mode', v_quote.mode, 'currency', v_cur, 'total', v_total, 'total_jpy', v_quote.total_jpy,
    'shipping_pending', v_shipping IS NULL, 'deposit', v_deposit, 'schedule', v_schedule,
    'term_months', CASE WHEN v_quote.mode = 'layaway' THEN v_quote.term_months END,
    'fx_rate', v_rate, 'awaiting_confirmation', true);
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM LIKE 'out_of_stock:%' THEN
      RETURN jsonb_build_object('error', 'out_of_stock', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'variant_missing:%' THEN
      RETURN jsonb_build_object('error', 'variant_missing', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'empty_quote:%' THEN
      RETURN jsonb_build_object('error', 'empty_quote');
    END IF;
    RAISE;
END
$fn$;

REVOKE ALL ON FUNCTION public.create_web_draft_atomic(uuid, uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_web_draft_atomic(uuid, uuid, text, text, timestamptz) TO service_role;

-- ------------------------------------- 6. decline ("Can't supply") and expiry
-- Staff decline needs confirm_web_order_ready and a reason; p_source 'system'
-- is the 72h sweep (status 'expired'). The stock goes back exactly once: only
-- 'held' lines are released, and the status flip is the guard. INVARIANT 12
-- cannot apply — no payment submission can exist before an order does.
CREATE OR REPLACE FUNCTION public.decline_web_draft_atomic(
  p_draft_id uuid,
  p_reason   text,
  p_user_id  uuid DEFAULT NULL,
  p_source   text DEFAULT 'staff'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_reason    text := nullif(btrim(coalesce(p_reason, '')), '');
  v_is_system boolean := (p_source = 'system');
  v_draft     public.web_order_drafts%ROWTYPE;
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

  SELECT * INTO v_draft FROM public.web_order_drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_draft.status <> 'to_confirm' THEN
    RETURN jsonb_build_object('error', 'not_open', 'status', v_draft.status);
  END IF;

  WITH released AS (
    UPDATE public.web_order_draft_lines l
       SET hold_state = 'released', released_at = v_now
     WHERE l.draft_id = p_draft_id AND l.hold_state = 'held'
     RETURNING l.variant_id, l.qty
  ), per_variant AS (
    SELECT variant_id, sum(qty)::integer AS qty FROM released WHERE variant_id IS NOT NULL GROUP BY variant_id
  ), restored AS (
    UPDATE public.website_product_variants v
       SET stock_qty = v.stock_qty + pv.qty, updated_at = v_now
      FROM per_variant pv
     WHERE v.id = pv.variant_id
     RETURNING v.id
  )
  SELECT count(*) INTO v_restored FROM restored;

  UPDATE public.web_order_drafts
     SET status = CASE WHEN v_is_system THEN 'expired' ELSE 'declined' END,
         decided_at = v_now, decided_by = p_user_id, decline_reason = v_reason, updated_at = v_now
   WHERE id = p_draft_id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('web_order_draft', p_draft_id,
          CASE WHEN v_is_system THEN 'web_draft_expired' ELSE 'web_draft_declined' END,
          jsonb_build_object('web_reference', v_draft.web_reference, 'invoice_number', v_draft.invoice_seq::text,
                             'mode', v_draft.mode, 'reason', v_reason, 'stock_variants_restored', v_restored,
                             'source', p_source),
          p_user_id);

  RETURN jsonb_build_object('ok', true, 'draft_id', p_draft_id, 'status',
                            CASE WHEN v_is_system THEN 'expired' ELSE 'declined' END,
                            'web_reference', v_draft.web_reference, 'invoice_number', v_draft.invoice_seq::text,
                            'mode', v_draft.mode, 'customer_id', v_draft.customer_id,
                            'customer_lang', v_draft.customer_lang, 'stock_variants_restored', v_restored);
END
$fn$;

REVOKE ALL ON FUNCTION public.decline_web_draft_atomic(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decline_web_draft_atomic(uuid, text, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.expire_web_drafts_atomic(
  p_hours integer DEFAULT 72,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_hours   integer := GREATEST(coalesce(p_hours, 72), 1);
  v_cutoff  timestamptz := now() - make_interval(hours => GREATEST(coalesce(p_hours, 72), 1));
  v_reason  text := format('Not confirmed within %s hours (auto-cancelled)', GREATEST(coalesce(p_hours, 72), 1));
  r         record;
  v_r       jsonb;
  v_done    jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
BEGIN
  FOR r IN
    SELECT d.id, d.web_reference, d.invoice_seq, d.customer_id, d.customer_lang, d.mode, d.created_at
      FROM public.web_order_drafts d
     WHERE d.status = 'to_confirm' AND d.created_at < v_cutoff
     ORDER BY d.created_at
     LIMIT GREATEST(coalesce(p_limit, 100), 1)
  LOOP
    -- One draft's failure never stops the others.
    BEGIN
      v_r := public.decline_web_draft_atomic(r.id, v_reason, NULL, 'system');
      IF coalesce((v_r ->> 'ok')::boolean, false) THEN
        v_done := v_done || jsonb_build_object('id', r.id, 'web_reference', r.web_reference,
                                               'invoice_number', r.invoice_seq::text, 'mode', r.mode,
                                               'customer_id', r.customer_id, 'customer_lang', r.customer_lang,
                                               'created_at', r.created_at,
                                               'stock_variants_restored', v_r -> 'stock_variants_restored');
      ELSE
        v_skipped := v_skipped || jsonb_build_object('id', r.id, 'web_reference', r.web_reference,
                                                     'reason', coalesce(v_r ->> 'error', 'refused'));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped || jsonb_build_object('id', r.id, 'web_reference', r.web_reference,
                                                   'reason', 'error', 'detail', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'cutoff', v_cutoff, 'hours', v_hours,
                            'expired_drafts', v_done, 'skipped', v_skipped);
END
$fn$;

REVOKE ALL ON FUNCTION public.expire_web_drafts_atomic(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_web_drafts_atomic(integer, integer) TO service_role;

-- ----------------------------------------------- 7. Confirm (§2.4, R1)
-- The review screen's Confirm, through create-cash-order / create-layaway-
-- account's web branch (PR 4): they keep their auth, permission, loyalty and
-- plan checks and compute the figures; this does EVERY write in one
-- transaction, so the no-delete triggers on web rows are never reached.
--
-- p_order (order currency unless named *_jpy):
--   total_amount (required), shipping_fee, discount_amount, discount_type,
--   discount_value, order_date (default PHT today), transfer_due_at
--   (required), notes, is_trade, loyalty_jpy_amount (default the draft's
--   product subtotal in yen), planned_shipping_method_id,
--   layaway only: downpayment_amount (required), payment_plan_months (must
--   equal the draft's term — W2-3), end_date (default the last due date).
-- p_schedule (layaway): [{installment_number, due_date, amount}], exactly the
--   term's rows; downpayment + Σ amount must equal total_amount.
-- p_service_lines: [{title, quantity, unit_price_jpy, line_total_jpy}] —
--   service lines are item rows without a variant (Page365 rule R3); yen,
--   like every line (order-extras).
CREATE OR REPLACE FUNCTION public.materialize_web_draft_atomic(
  p_draft_id      uuid,
  p_user_id       uuid,
  p_order         jsonb,
  p_schedule      jsonb DEFAULT NULL,
  p_service_lines jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_draft     public.web_order_drafts%ROWTYPE;
  v_now       timestamptz := now();
  v_total     numeric(12,2);
  v_shipping  numeric(12,2);
  v_discount  numeric(12,2);
  v_due       timestamptz;
  v_date      date;
  v_loyalty   numeric;
  v_courier   uuid;
  v_notes     text;
  v_trade     boolean;
  v_dp        numeric(12,2);
  v_term      integer;
  v_end       date;
  v_sum       numeric(12,2);
  v_rows      integer;
  v_order_id  uuid;
  v_row       jsonb;
  v_n         integer;
  v_lines     integer;
  v_services  integer := 0;
  v_requests  integer := 0;
  v_rate      numeric;
  v_rate_date date;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'user_identity_required');
  END IF;
  IF NOT public.has_permission(p_user_id, 'confirm_web_order_ready') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;

  SELECT * INTO v_draft FROM public.web_order_drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_draft.status <> 'to_confirm' THEN
    RETURN jsonb_build_object('error', 'not_open', 'status', v_draft.status);
  END IF;
  IF NOT public.has_permission(p_user_id, CASE WHEN v_draft.mode = 'full' THEN 'create_cash_order' ELSE 'create_account' END) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;

  SELECT count(*) FILTER (WHERE hold_state = 'held'), count(*) INTO v_lines, v_n
    FROM public.web_order_draft_lines WHERE draft_id = p_draft_id;
  IF v_lines = 0 OR v_lines <> v_n THEN
    RETURN jsonb_build_object('error', 'hold_lost');
  END IF;

  p_order := coalesce(p_order, '{}'::jsonb);
  v_total    := (p_order ->> 'total_amount')::numeric;
  v_shipping := coalesce((p_order ->> 'shipping_fee')::numeric, 0);
  v_discount := coalesce((p_order ->> 'discount_amount')::numeric, 0);
  v_due      := (p_order ->> 'transfer_due_at')::timestamptz;
  v_date     := coalesce((p_order ->> 'order_date')::date, (v_now AT TIME ZONE 'Asia/Manila')::date);
  v_loyalty  := coalesce((p_order ->> 'loyalty_jpy_amount')::numeric, v_draft.subtotal_jpy);
  v_courier  := nullif(p_order ->> 'planned_shipping_method_id', '')::uuid;
  v_notes    := nullif(btrim(coalesce(p_order ->> 'notes', '')), '');
  v_trade    := coalesce((p_order ->> 'is_trade')::boolean, false);
  v_rate      := CASE WHEN v_draft.settlement_currency = 'PHP' THEN v_draft.fx_rate END;
  v_rate_date := CASE WHEN v_draft.settlement_currency = 'PHP' THEN v_draft.fx_rate_date END;

  IF v_total IS NULL OR v_total <= 0 THEN
    RETURN jsonb_build_object('error', 'total_required');
  END IF;
  IF v_shipping < 0 OR v_discount < 0 OR v_loyalty < 0 THEN
    RETURN jsonb_build_object('error', 'negative_amount');
  END IF;
  -- A deadline is moved, never removed (WEB LAYAWAY rule): Confirm starts it.
  IF v_due IS NULL THEN
    RETURN jsonb_build_object('error', 'deadline_required');
  END IF;
  IF jsonb_typeof(coalesce(p_service_lines, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('error', 'service_lines_invalid');
  END IF;
  FOR v_row IN SELECT * FROM jsonb_array_elements(coalesce(p_service_lines, '[]'::jsonb)) LOOP
    IF nullif(btrim(coalesce(v_row ->> 'title', '')), '') IS NULL
       OR coalesce((v_row ->> 'quantity')::numeric, 0) <= 0
       OR (v_row ->> 'quantity')::numeric <> trunc((v_row ->> 'quantity')::numeric)
       OR coalesce((v_row ->> 'unit_price_jpy')::numeric, -1) < 0
       OR coalesce((v_row ->> 'line_total_jpy')::numeric, -1) < 0 THEN
      RETURN jsonb_build_object('error', 'service_lines_invalid');
    END IF;
  END LOOP;

  IF v_draft.mode = 'layaway' THEN
    v_dp   := (p_order ->> 'downpayment_amount')::numeric;
    v_term := coalesce((p_order ->> 'payment_plan_months')::integer, v_draft.term_months);
    IF v_term IS DISTINCT FROM v_draft.term_months THEN
      RETURN jsonb_build_object('error', 'term_locked', 'term_months', v_draft.term_months);
    END IF;
    IF v_draft.agreement_version IS NULL OR v_draft.agreement_signed_at IS NULL THEN
      RETURN jsonb_build_object('error', 'agreement_missing');
    END IF;
    IF v_dp IS NULL OR v_dp <= 0 THEN
      RETURN jsonb_build_object('error', 'downpayment_required');
    END IF;
    IF jsonb_typeof(coalesce(p_schedule, 'null'::jsonb)) <> 'array' THEN
      RETURN jsonb_build_object('error', 'schedule_required');
    END IF;
    SELECT count(*), coalesce(sum((s ->> 'amount')::numeric), 0), max((s ->> 'due_date')::date)
      INTO v_rows, v_sum, v_end
      FROM jsonb_array_elements(p_schedule) s;
    IF v_rows <> v_term
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_schedule) s
                   WHERE coalesce((s ->> 'amount')::numeric, 0) <= 0 OR (s ->> 'due_date') IS NULL)
       OR (SELECT count(DISTINCT (s ->> 'installment_number')::integer) FROM jsonb_array_elements(p_schedule) s
            WHERE (s ->> 'installment_number')::integer BETWEEN 1 AND v_term) <> v_term THEN
      RETURN jsonb_build_object('error', 'schedule_invalid');
    END IF;
    IF v_dp + v_sum <> v_total THEN
      RETURN jsonb_build_object('error', 'schedule_mismatch', 'total_amount', v_total,
                                'downpayment', v_dp, 'installments', v_sum);
    END IF;
    v_end := coalesce((p_order ->> 'end_date')::date, v_end);

    INSERT INTO public.layaway_accounts (
      invoice_number, customer_id, currency, total_amount, payment_plan_months,
      order_date, end_date, status, total_paid, remaining_balance,
      downpayment_amount, loyalty_jpy_amount, shipping_fee,
      discount_amount, discount_type, discount_value,
      source_channel, web_reference, quote_id, transfer_due_at, ship_to_snapshot,
      customer_lang, fx_rate_used, fx_rate_date, notes, is_trade,
      agreement_version, agreement_acceptance_date,
      ready_confirmed_at, ready_confirmed_by, created_by_user_id, planned_shipping_method_id
    ) VALUES (
      v_draft.invoice_seq::text, v_draft.customer_id, v_draft.settlement_currency::account_currency, v_total, v_term,
      v_date, v_end, 'active', 0, v_total,
      v_dp, v_loyalty, v_shipping,
      v_discount, nullif(p_order ->> 'discount_type', ''), (p_order ->> 'discount_value')::numeric,
      'web', v_draft.web_reference, v_draft.quote_id, v_due, v_draft.ship_to_snapshot,
      v_draft.customer_lang, v_rate, v_rate_date,
      'Website layaway ' || v_draft.web_reference || coalesce(E'\n' || v_notes, ''), v_trade,
      v_draft.agreement_version, v_draft.agreement_signed_at,
      v_now, p_user_id, p_user_id, v_courier
    ) RETURNING id INTO v_order_id;

    FOR v_row IN SELECT * FROM jsonb_array_elements(p_schedule) ORDER BY (value ->> 'installment_number')::integer LOOP
      INSERT INTO public.layaway_schedule (
        account_id, installment_number, due_date, base_installment_amount,
        penalty_amount, total_due_amount, paid_amount, currency, status
      ) VALUES (
        v_order_id, (v_row ->> 'installment_number')::integer, (v_row ->> 'due_date')::date,
        (v_row ->> 'amount')::numeric, 0, (v_row ->> 'amount')::numeric, 0,
        v_draft.settlement_currency::account_currency, 'pending'
      );
    END LOOP;

    INSERT INTO public.layaway_account_items (account_id, website_product_id, variant_id, title, sku, quantity,
                                              unit_price_jpy, line_total_jpy, image_url)
    SELECT v_order_id, l.website_product_id, l.variant_id, l.title, l.sku, l.qty, l.unit_price_jpy, l.line_total_jpy, l.image_url
      FROM public.web_order_draft_lines l WHERE l.draft_id = p_draft_id AND l.hold_state = 'held'
     ORDER BY l.created_at, l.id;

    INSERT INTO public.layaway_account_items (account_id, title, quantity, unit_price_jpy, line_total_jpy)
    SELECT v_order_id, btrim(s ->> 'title'), (s ->> 'quantity')::integer,
           (s ->> 'unit_price_jpy')::numeric, (s ->> 'line_total_jpy')::numeric
      FROM jsonb_array_elements(coalesce(p_service_lines, '[]'::jsonb)) s;
    GET DIAGNOSTICS v_services = ROW_COUNT;
  ELSE
    INSERT INTO public.cash_orders (
      invoice_number, customer_id, currency, total_amount, total_paid,
      remaining_balance, status, source_channel, order_type, payment_method,
      payment_status, ship_to_address_id, ship_to_snapshot, recipient_name, recipient_phone,
      gift_note, quote_id, web_reference, transfer_due_at, expires_at, shipping_fee,
      discount_amount, discount_type, discount_value,
      loyalty_jpy_amount, item_description, order_date, customer_lang, notes, is_trade,
      ready_confirmed_at, ready_confirmed_by, created_by_user_id, fx_rate_used, fx_rate_date,
      planned_shipping_method_id
    ) VALUES (
      v_draft.invoice_seq::text, v_draft.customer_id, v_draft.settlement_currency::account_currency, v_total, 0,
      v_total, 'pending'::cash_order_status, 'web', v_draft.order_type, 'transfer',
      'pending_transfer', v_draft.ship_to_address_id, v_draft.ship_to_snapshot, v_draft.recipient_name, v_draft.recipient_phone,
      -- expires_at = transfer_due_at: the deadline the expiry cron reads.
      v_draft.gift_note, v_draft.quote_id, v_draft.web_reference, v_due, v_due, v_shipping,
      v_discount, nullif(p_order ->> 'discount_type', ''), (p_order ->> 'discount_value')::numeric,
      v_loyalty, 'Website order ' || v_draft.web_reference, v_date, v_draft.customer_lang, v_notes, v_trade,
      v_now, p_user_id, p_user_id, v_rate, v_rate_date,
      v_courier
    ) RETURNING id INTO v_order_id;

    INSERT INTO public.cash_order_items (cash_order_id, website_product_id, variant_id, title, sku, quantity,
                                         unit_price_jpy, line_total_jpy, image_url)
    SELECT v_order_id, l.website_product_id, l.variant_id, l.title, l.sku, l.qty, l.unit_price_jpy, l.line_total_jpy, l.image_url
      FROM public.web_order_draft_lines l WHERE l.draft_id = p_draft_id AND l.hold_state = 'held'
     ORDER BY l.created_at, l.id;

    INSERT INTO public.cash_order_items (cash_order_id, title, quantity, unit_price_jpy, line_total_jpy)
    SELECT v_order_id, btrim(s ->> 'title'), (s ->> 'quantity')::integer,
           (s ->> 'unit_price_jpy')::numeric, (s ->> 'line_total_jpy')::numeric
      FROM jsonb_array_elements(coalesce(p_service_lines, '[]'::jsonb)) s;
    GET DIAGNOSTICS v_services = ROW_COUNT;
  END IF;

  -- The hold becomes the order's: NO second stock movement (risk 3). From here
  -- page365_web_holds counts the order line instead of the draft line.
  UPDATE public.web_order_draft_lines
     SET hold_state = 'transferred', transferred_at = v_now
   WHERE draft_id = p_draft_id AND hold_state = 'held';

  UPDATE public.web_order_drafts
     SET status = 'confirmed', decided_at = v_now, decided_by = p_user_id, updated_at = v_now,
         cash_order_id      = CASE WHEN v_draft.mode = 'full'    THEN v_order_id END,
         layaway_account_id = CASE WHEN v_draft.mode = 'layaway' THEN v_order_id END
   WHERE id = p_draft_id;

  -- A service request filed on the draft now belongs to the order (W2-5).
  UPDATE public.service_requests
     SET cash_order_id      = CASE WHEN v_draft.mode = 'full'    THEN v_order_id ELSE cash_order_id END,
         layaway_account_id = CASE WHEN v_draft.mode = 'layaway' THEN v_order_id ELSE layaway_account_id END,
         updated_at = v_now
   WHERE web_draft_id = p_draft_id;
  GET DIAGNOSTICS v_requests = ROW_COUNT;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('web_order_draft', p_draft_id, 'web_draft_confirmed',
          jsonb_build_object('web_reference', v_draft.web_reference, 'invoice_number', v_draft.invoice_seq::text,
                             'mode', v_draft.mode,
                             'entity_type', CASE WHEN v_draft.mode = 'full' THEN 'cash_order' ELSE 'layaway_account' END,
                             'entity_id', v_order_id, 'currency', v_draft.settlement_currency,
                             'quoted_total', v_draft.total, 'total_amount', v_total,
                             'shipping_fee', v_shipping, 'discount_amount', v_discount,
                             'service_lines', v_services, 'service_requests_moved', v_requests,
                             'transfer_due_at', v_due, 'planned_shipping_method_id', v_courier),
          p_user_id);

  RETURN jsonb_build_object('ok', true, 'draft_id', p_draft_id,
                            'entity_type', CASE WHEN v_draft.mode = 'full' THEN 'cash_order' ELSE 'layaway_account' END,
                            'entity_id', v_order_id,
                            'order_id',   CASE WHEN v_draft.mode = 'full'    THEN v_order_id END,
                            'account_id', CASE WHEN v_draft.mode = 'layaway' THEN v_order_id END,
                            'invoice_number', v_draft.invoice_seq::text, 'web_reference', v_draft.web_reference,
                            'service_lines', v_services, 'service_requests_moved', v_requests);
END
$fn$;

REVOKE ALL ON FUNCTION public.materialize_web_draft_atomic(uuid, uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materialize_web_draft_atomic(uuid, uuid, jsonb, jsonb, jsonb) TO service_role;

-- --------------------------------------------------- 8. the draft bell (§2.1)
CREATE OR REPLACE FUNCTION public.notify_web_draft_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE v_who text;
BEGIN
  BEGIN
    v_who := coalesce((SELECT nullif(btrim(c.full_name), '') FROM public.customers c WHERE c.id = NEW.customer_id),
                      'a website customer');
    PERFORM public.staff_notify(
      'account_created', 'New website order — confirm the piece',
      NEW.web_reference || ' · ' || v_who || ' · '
        || CASE WHEN NEW.mode = 'layaway' THEN 'layaway ' || NEW.term_months || ' months' ELSE 'paid in full' END
        || ' · ' || public.notify_money_label(NEW.total, NEW.settlement_currency)
        || CASE WHEN NEW.shipping IS NULL THEN ' + shipping to add' ELSE '' END
        || ' · auto-cancels after 72 hours',
      NULL, NEW.customer_id, NEW.invoice_seq::text,
      jsonb_build_object('web_draft_id', NEW.id, 'entity_type', 'web_draft', 'entity_id', NEW.id,
                         'source_channel', 'web', 'web_reference', NEW.web_reference,
                         'mode', NEW.mode, 'currency', NEW.settlement_currency, 'total', NEW.total,
                         'shipping_pending', NEW.shipping IS NULL, 'draft', true));
  EXCEPTION WHEN OTHERS THEN NULL;  -- a bell never blocks a checkout
  END;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.notify_web_draft_created() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_notify_web_draft_created ON public.web_order_drafts;
CREATE TRIGGER trg_notify_web_draft_created
AFTER INSERT ON public.web_order_drafts
FOR EACH ROW EXECUTE FUNCTION public.notify_web_draft_created();

-- ------------------------------ 9. live functions extended (md5-guarded above)
-- page365_web_holds: + open draft lines. Everything else byte-for-byte live.
CREATE OR REPLACE FUNCTION public.page365_web_holds(p_variant_id uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT (
    coalesce((SELECT sum(i.quantity) FROM public.cash_order_items i
                JOIN public.cash_orders o ON o.id = i.cash_order_id
               WHERE i.variant_id = p_variant_id AND o.source_channel = 'web' AND o.status = 'pending'), 0)
  + coalesce((SELECT sum(i.quantity) FROM public.layaway_account_items i
                JOIN public.layaway_accounts a ON a.id = i.account_id
               WHERE i.variant_id = p_variant_id AND a.source_channel = 'web' AND a.stock_released_at IS NULL
                 AND a.status IN ('active','overdue') AND coalesce(a.total_paid, 0) = 0), 0)
  + coalesce((SELECT sum(l.qty) FROM public.web_order_draft_lines l
               WHERE l.variant_id = p_variant_id AND l.hold_state = 'held'), 0)
  )::integer
$fn$;

-- email_delivery_report: drafts are expected emails; an order made from a
-- draft is not counted twice. Everything else byte-for-byte live.
CREATE OR REPLACE FUNCTION public.email_delivery_report(p_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_since timestamptz := now() - make_interval(hours => GREATEST(1, COALESCE(p_hours, 24)));
  v_expected jsonb;
  v_expected_total integer;
  v_sent integer; v_failed integer; v_suppressed integer;
  v_last_sent timestamptz; v_first_fail timestamptz; v_last_fail timestamptz;
  v_streak_start timestamptz; v_newest_error text; v_newest_request_id text;
  v_sf_sent integer; v_sf_failed integer;
BEGIN
  -- Staff only. Customers hold authenticated sessions too, so the role check
  -- lives inside the function, not in the grant.
  IF auth.uid() IS NOT NULL AND NOT (
       public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'finance')
    OR public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'csr')) THEN
    RAISE EXCEPTION 'staff role required' USING ERRCODE = '42501';
  END IF;

  -- Events that each produce one customer email. Test customers excluded.
  SELECT jsonb_build_object(
    'payment_reminders', (SELECT count(*) FROM reminder_logs rl JOIN customers c ON c.id = rl.customer_id
                            WHERE rl.created_at >= v_since AND NOT c.is_test),
    'layaway_payment_confirmations', (SELECT count(*) FROM payments p JOIN layaway_accounts la ON la.id = p.account_id JOIN customers c ON c.id = la.customer_id
                            WHERE p.created_at >= v_since AND p.voided_at IS NULL AND NOT c.is_test AND la.invoice_number ~ '^[0-9]+$'),
    'cash_payment_confirmations', (SELECT count(*) FROM cash_payments cp JOIN cash_orders co ON co.id = cp.cash_order_id JOIN customers c ON c.id = co.customer_id
                            WHERE cp.created_at >= v_since AND cp.voided_at IS NULL AND NOT c.is_test),
    'portal_submission_acknowledgements', (SELECT count(*) FROM payment_submissions ps JOIN customers c ON c.id = ps.customer_id
                            WHERE ps.created_at >= v_since AND ps.portal_token IS NOT NULL AND NOT c.is_test),
    'payment_rejections', (SELECT count(*) FROM payment_submissions ps JOIN customers c ON c.id = ps.customer_id
                            WHERE ps.status = 'rejected' AND ps.updated_at >= v_since AND NOT c.is_test),
    'penalties_applied', (SELECT count(*) FROM penalty_fees f JOIN layaway_accounts la ON la.id = f.account_id JOIN customers c ON c.id = la.customer_id
                            WHERE f.created_at >= v_since AND NOT c.is_test),
    'waivers_approved', (SELECT count(*) FROM penalty_waiver_requests w JOIN layaway_accounts la ON la.id = w.account_id JOIN customers c ON c.id = la.customer_id
                            WHERE w.approved_at >= v_since AND NOT c.is_test),
    'accounts_forfeited', (SELECT count(*) FROM layaway_accounts la JOIN customers c ON c.id = la.customer_id
                            WHERE la.forfeited_at >= v_since AND NOT c.is_test),
    'loyalty_events', (SELECT count(*) FROM loyalty_transactions x JOIN loyalty_members m ON m.id = x.member_id JOIN customers c ON c.id = m.customer_id
                            WHERE x.created_at >= v_since AND NOT c.is_test AND x.transaction_type IN ('earned','expired','redeemed','tier_changed','bonus','birthday_bonus')),
    'loyalty_pre_expiry_warnings', (SELECT count(*) FROM loyalty_members m JOIN customers c ON c.id = m.customer_id
                            WHERE m.pre_expiry_warned_at >= v_since AND NOT c.is_test),
    'web_orders_placed', (SELECT count(*) FROM cash_orders co JOIN customers c ON c.id = co.customer_id
                            WHERE co.created_at >= v_since AND co.source_channel = 'web' AND NOT c.is_test
                              -- WEBSITE ORDERS PR 3: an order made by confirming a draft sends ONE
                              -- email (ready), already counted by web_reservations_confirmed.
                              AND NOT EXISTS (SELECT 1 FROM web_order_drafts d WHERE d.cash_order_id = co.id)),
    'web_orders_closed', (SELECT count(*) FROM cash_orders co JOIN customers c ON c.id = co.customer_id
                            WHERE co.source_channel = 'web' AND NOT c.is_test
                              AND (co.cancelled_at >= v_since OR co.expired_at >= v_since)),
    -- RESERVE-FIRST (A2), 2026-09-24.
    'web_layaways_placed', (SELECT count(*) FROM layaway_accounts la JOIN customers c ON c.id = la.customer_id
                            WHERE la.created_at >= v_since AND la.source_channel = 'web' AND NOT c.is_test
                              AND NOT EXISTS (SELECT 1 FROM web_order_drafts d WHERE d.layaway_account_id = la.id)),
    -- WEBSITE ORDERS PR 3 (2026-09-29): a draft sends the "received" email when
    -- it is written, and one more when it is declined or expires.
    'web_drafts_placed', (SELECT count(*) FROM web_order_drafts d JOIN customers c ON c.id = d.customer_id
                            WHERE d.created_at >= v_since AND NOT c.is_test),
    'web_drafts_closed', (SELECT count(*) FROM web_order_drafts d JOIN customers c ON c.id = d.customer_id
                            WHERE d.status IN ('declined', 'expired') AND d.decided_at >= v_since AND NOT c.is_test),
    'web_reservations_confirmed', (SELECT count(*) FROM cash_orders co JOIN customers c ON c.id = co.customer_id
                            WHERE co.source_channel = 'web' AND co.ready_confirmed_by IS NOT NULL
                              AND co.ready_confirmed_at >= v_since AND NOT c.is_test)
                          + (SELECT count(*) FROM layaway_accounts la JOIN customers c ON c.id = la.customer_id
                            WHERE la.source_channel = 'web' AND la.ready_confirmed_by IS NOT NULL
                              AND la.ready_confirmed_at >= v_since AND NOT c.is_test),
    'web_layaways_closed', (SELECT count(*) FROM layaway_accounts la JOIN customers c ON c.id = la.customer_id
                            WHERE la.source_channel = 'web' AND NOT c.is_test
                              AND (la.expired_at >= v_since
                                   OR EXISTS (SELECT 1 FROM audit_logs al
                                               WHERE al.entity_type = 'layaway_account' AND al.entity_id = la.id
                                                 AND al.action IN ('web_layaway_reservation_declined', 'web_layaway_reservation_expired')
                                                 AND al.created_at >= v_since)))
  ) INTO v_expected;

  SELECT COALESCE(sum((value)::integer), 0) INTO v_expected_total FROM jsonb_each_text(v_expected);

  SELECT count(*) FILTER (WHERE status = 'sent'),
         count(*) FILTER (WHERE status IN ('failed','dlq')),
         count(*) FILTER (WHERE status = 'suppressed'),
         max(created_at) FILTER (WHERE status = 'sent'),
         min(created_at) FILTER (WHERE status IN ('failed','dlq')),
         max(created_at) FILTER (WHERE status IN ('failed','dlq')),
         count(*) FILTER (WHERE status = 'sent' AND channel = 'storefront'),
         count(*) FILTER (WHERE status IN ('failed','dlq') AND channel = 'storefront')
    INTO v_sent, v_failed, v_suppressed, v_last_sent, v_first_fail, v_last_fail, v_sf_sent, v_sf_failed
    FROM email_send_log WHERE created_at >= v_since;

  -- Current refusal streak: first failure after the newest accepted send,
  -- across the whole log (not just the window), so a nine-day outage shows
  -- its true start date.
  SELECT min(created_at) INTO v_streak_start FROM email_send_log
   WHERE status IN ('failed','dlq')
     AND created_at > COALESCE((SELECT max(created_at) FROM email_send_log WHERE status = 'sent'), '-infinity'::timestamptz);

  SELECT left(error_message, 400), request_id INTO v_newest_error, v_newest_request_id
    FROM email_send_log WHERE status IN ('failed','dlq') ORDER BY created_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'window_hours', GREATEST(1, COALESCE(p_hours, 24)),
    'since', v_since,
    'generated_at', now(),
    'expected', v_expected,
    'expected_total', v_expected_total,
    'sent', v_sent,
    'failed', v_failed,
    'suppressed', v_suppressed,
    'storefront', jsonb_build_object('sent', v_sf_sent, 'failed', v_sf_failed),
    'last_sent_at', (SELECT max(created_at) FROM email_send_log WHERE status = 'sent'),
    'last_sent_in_window_at', v_last_sent,
    'first_failure_in_window_at', v_first_fail,
    'last_failure_at', v_last_fail,
    'refusal_streak_started_at', v_streak_start,
    'newest_error', v_newest_error,
    'newest_request_id', v_newest_request_id,
    -- verdict: refused = attempts refused and nothing accepted; silent = events
    -- happened but no attempt was even logged (a sender is bypassing the log);
    -- degraded = some refused, some accepted; ok otherwise.
    'status', CASE
      WHEN v_failed > 0 AND v_sent = 0 THEN 'refused'
      WHEN v_expected_total > 0 AND v_sent = 0 AND v_failed = 0 THEN 'silent'
      WHEN v_failed > 0 THEN 'degraded'
      ELSE 'ok' END
  );
END;
$$;

-- web_reservation_expiring_bells: + drafts unconfirmed 48–72h. Everything
-- else byte-for-byte live.
CREATE OR REPLACE FUNCTION public.web_reservation_expiring_bells()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_n integer := 0;
  v_k integer;
BEGIN
  WITH due AS (
    SELECT 'cash_order'::text AS entity_type, o.id, o.customer_id, o.invoice_number::text AS invoice_number,
           coalesce(o.web_reference, o.invoice_number::text) AS ref, o.created_at
      FROM public.cash_orders o
     WHERE o.source_channel = 'web' AND o.ready_confirmed_at IS NULL AND o.status::text = 'pending'
       AND o.created_at <= now() - interval '48 hours' AND o.created_at > now() - interval '72 hours'
    UNION ALL
    SELECT 'layaway'::text, a.id, a.customer_id, a.invoice_number::text,
           coalesce(a.web_reference, a.invoice_number::text), a.created_at
      FROM public.layaway_accounts a
     WHERE a.source_channel = 'web' AND a.ready_confirmed_at IS NULL AND a.status::text = 'active'
       AND a.created_at <= now() - interval '48 hours' AND a.created_at > now() - interval '72 hours'
    UNION ALL
    -- WEBSITE ORDERS PR 3 (2026-09-29): a draft not yet confirmed.
    SELECT 'web_draft'::text, w.id, w.customer_id, w.invoice_seq::text, w.web_reference, w.created_at
      FROM public.web_order_drafts w
     WHERE w.status = 'to_confirm'
       AND w.created_at <= now() - interval '48 hours' AND w.created_at > now() - interval '72 hours'
  ), ins AS (
    INSERT INTO public.staff_notifications (type, title, body, account_id, customer_id, invoice_number, metadata)
    SELECT 'web_reservation_expiring',
           'Last day — ' || d.ref || ' auto-cancels at '
             || to_char((d.created_at + interval '72 hours') AT TIME ZONE 'Asia/Manila', 'Mon FMDD HH24:MI') || ' PHT',
           d.ref || ' has waited 48 hours for staff to confirm the piece. Confirm or decline it before '
             || to_char((d.created_at + interval '72 hours') AT TIME ZONE 'Asia/Manila', 'Mon FMDD HH24:MI')
             || ' PHT, or it is cancelled automatically and the stock goes back on sale.',
           CASE WHEN d.entity_type = 'layaway' THEN d.id END,
           d.customer_id,
           d.invoice_number,
           CASE WHEN d.entity_type = 'cash_order'
                THEN jsonb_build_object('entity_type', d.entity_type, 'entity_id', d.id, 'cash_order_id', d.id,
                                        'web_reference', d.ref, 'source_channel', 'web')
                WHEN d.entity_type = 'web_draft'
                THEN jsonb_build_object('entity_type', d.entity_type, 'entity_id', d.id, 'web_draft_id', d.id,
                                        'web_reference', d.ref, 'source_channel', 'web', 'draft', true)
                ELSE jsonb_build_object('entity_type', d.entity_type, 'entity_id', d.id, 'layaway_account_id', d.id,
                                        'web_reference', d.ref, 'source_channel', 'web') END
      FROM due d
     WHERE NOT EXISTS (SELECT 1 FROM public.staff_notifications n
                        WHERE n.type = 'web_reservation_expiring'
                          AND n.metadata ->> 'entity_id' = d.id::text)
    RETURNING 1
  )
  SELECT count(*) INTO v_k FROM ins;
  v_n := v_n + coalesce(v_k, 0);
  RETURN v_n;
END
$fn$;

-- ---------------------------------------------------------------- 10. self-check
DO $self$
DECLARE
  v_fn  text;
  v_def text[] := ARRAY[
    'public.create_web_draft_atomic(uuid,uuid,text,text,timestamptz)',
    'public.decline_web_draft_atomic(uuid,text,uuid,text)',
    'public.expire_web_drafts_atomic(integer,integer)',
    'public.materialize_web_draft_atomic(uuid,uuid,jsonb,jsonb,jsonb)',
    'public.web_checkout_mode()'];
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.page365_web_holds(uuid)'::regprocedure)) <> '45bb5a67f283468824870545ca41c204'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.email_delivery_report(integer)'::regprocedure)) <> '640083183d6b994101543ebbea7810eb'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.web_reservation_expiring_bells()'::regprocedure)) <> 'a90b52945e1acde7c279d3190a99ee8e' THEN
    RAISE EXCEPTION 'web_drafts self-check: an extended function body is not this file''s';
  END IF;
  -- Service-role only: never callable from a browser session.
  FOREACH v_fn IN ARRAY v_def LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'web_drafts self-check: grants wrong on %', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.set_web_checkout_mode(text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_web_checkout_mode()', 'EXECUTE') THEN
    RAISE EXCEPTION 'web_drafts self-check: the switch is callable by anon';
  END IF;
  IF has_table_privilege('anon', 'public.web_order_drafts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.web_order_drafts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.web_order_draft_lines', 'UPDATE') THEN
    RAISE EXCEPTION 'web_drafts self-check: table grants too wide';
  END IF;
  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.web_order_drafts'::regclass) IS NOT TRUE
     OR (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.web_order_draft_lines'::regclass) IS NOT TRUE THEN
    RAISE EXCEPTION 'web_drafts self-check: RLS is off on a draft table';
  END IF;
  IF public.web_checkout_mode() <> 'order' AND NOT EXISTS (
       SELECT 1 FROM public.audit_logs WHERE action = 'set_web_checkout_mode') THEN
    RAISE EXCEPTION 'web_drafts self-check: the switch is not on ''order'' and nobody set it';
  END IF;
END
$self$;

COMMIT;

-- Verification (read-only) and the rollback-only preview: docs/sql/20261018_web_order_drafts_verify.sql
