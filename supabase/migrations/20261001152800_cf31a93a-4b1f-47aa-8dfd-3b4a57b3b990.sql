-- ============================================================================
-- WEBSITE ORDERS PR 10 (2026-10-01): retire the reserve-first path.
--
-- Plan: ~/Code/reference/website-orders/INVESTIGATION-v2.md §7 row 10, W2-12,
-- risk 5. Owner decisions 2026-10-01 23:00 JST: D1 retire now (SQL-4 = 0 rows
-- since 25 Sep; no old reservation is live), D2 remove the checkout-mode card
-- and keep web_checkout_mode() answering 'draft', D3 "reserve first, pay
-- after" copy is always on.
--
-- Every website checkout is a DRAFT confirmed by staff (PR 3–8). The old
-- path — a web order or plan written at checkout, holding the piece until
-- staff pressed Confirm / Can't supply, cancelled after 72 h — has no live
-- rows and no callers after this PR's edge-function deploy:
--
--   DROPPED  confirm_web_order_ready_atomic         (confirm-web-order-ready, deleted)
--   DROPPED  decline_web_layaway_reservation_atomic (decline-web-reservation, layaway branch removed)
--   DROPPED  expire_unconfirmed_web_reservations_atomic (web-reservation-sweep step 1 removed)
--   DROPPED  get_/set_/guard_web_reservation_mode + trg_guard_web_reservation_mode
--   DELETED  system_settings.web_reservation_mode   (audited; the storefront's
--            /settings key is now a constant true in the website function)
--   PATCHED  web_reservation_expiring_bells: the two old-reservation branches
--            removed, the draft branch kept (md5-guarded from live)
--   PATCHED  set_web_checkout_mode: 'order' is retired (mode_retired); the
--            value stays 'draft' and web_checkout_mode() is unchanged
--   KEPT     page365_web_holds: its cash/layaway terms also count orders
--            MATERIALIZED from drafts (pending web cash orders; unpaid web
--            plans), which still hold stock — nothing to trim.
--   KEPT     ready_confirmed_at: materialize_web_draft_atomic stamps it; the
--            storefront's awaiting_confirmation / ready_for_payment flags read it.
--
-- Rules: FUNCTION CHANGES START FROM LIVE (md5 guards below), REVOKE/GRANT
-- re-asserted after every CREATE, every migration version unique.
-- ============================================================================

-- ------------------------------------------------------------ 0. guards
DO $$
DECLARE
  v_live int;
BEGIN
  -- SQL-4: no unconfirmed reservation on the old path may exist.
  SELECT count(*) INTO v_live FROM (
    SELECT 1 FROM public.cash_orders
     WHERE source_channel = 'web' AND ready_confirmed_at IS NULL AND status = 'pending'
    UNION ALL
    SELECT 1 FROM public.layaway_accounts
     WHERE source_channel = 'web' AND ready_confirmed_at IS NULL AND status = 'active'
  ) s;
  IF v_live > 0 THEN
    RAISE EXCEPTION 'PR 10 refused: % unconfirmed old-flow reservation(s) still live (SQL-4). Confirm or decline them first.', v_live;
  END IF;

  -- The checkout switch must be on 'draft': the order path is gone after this.
  IF public.web_checkout_mode() <> 'draft' THEN
    RAISE EXCEPTION 'PR 10 refused: web_checkout_mode is %, not draft.', public.web_checkout_mode();
  END IF;

  -- Patched functions start from the live bodies this migration was written against.
  IF md5(pg_get_functiondef('public.web_reservation_expiring_bells()'::regprocedure)) <> '72c81b2c444aa910d3f3a556187074ea' THEN
    RAISE EXCEPTION 'PR 10 refused: web_reservation_expiring_bells drifted from the body this migration patches.';
  END IF;
  IF md5(pg_get_functiondef('public.set_web_checkout_mode(text, text)'::regprocedure)) <> 'f7f37e3d3669b8cb55d25dab4c466ee5' THEN
    RAISE EXCEPTION 'PR 10 refused: set_web_checkout_mode drifted from the body this migration patches.';
  END IF;
END $$;

-- ------------------------------------------------------------ 1. drop the old RPCs
DROP FUNCTION IF EXISTS public.confirm_web_order_ready_atomic(text, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.decline_web_layaway_reservation_atomic(uuid, text, uuid, text);
DROP FUNCTION IF EXISTS public.expire_unconfirmed_web_reservations_atomic(integer, integer);

-- ------------------------------------------------------------ 2. the reserve-first switch
DROP TRIGGER IF EXISTS trg_guard_web_reservation_mode ON public.system_settings;
DROP FUNCTION IF EXISTS public.guard_web_reservation_mode();
DROP FUNCTION IF EXISTS public.get_web_reservation_mode();
DROP FUNCTION IF EXISTS public.set_web_reservation_mode(boolean, boolean);

DO $$
DECLARE
  v_row public.system_settings%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.system_settings WHERE key = 'web_reservation_mode';
  IF v_row.id IS NOT NULL THEN
    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
    VALUES ('system_setting', v_row.id, 'retire_web_reservation_mode',
            jsonb_build_object('key', 'web_reservation_mode', 'value', v_row.value,
                               'updated_at', v_row.updated_at, 'updated_by_user_id', v_row.updated_by_user_id),
            jsonb_build_object('key', 'web_reservation_mode', 'deleted', true,
                               'reason', 'website orders PR 10: every checkout is a draft; reserve-first is the only path'),
            NULL, now());
    DELETE FROM public.system_settings WHERE id = v_row.id;
  END IF;
END $$;

-- ------------------------------------------------------------ 3. expiring bells: drafts only
-- Live body 72c81b2c…, with the cash_orders and layaway_accounts UNION branches
-- removed. Everything else byte-for-byte.
CREATE OR REPLACE FUNCTION public.web_reservation_expiring_bells()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_n integer := 0;
  v_k integer;
BEGIN
  WITH due AS (
    -- WEBSITE ORDERS PR 3 (2026-09-29): a draft not yet confirmed.
    -- PR 10 (2026-10-01): the old cash_orders / layaway_accounts reservation
    -- branches are gone — every checkout is a draft.
    SELECT 'web_draft'::text AS entity_type, w.id, w.customer_id, w.invoice_seq::text AS invoice_number,
           w.web_reference AS ref, w.created_at
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
           NULL,
           d.customer_id,
           d.invoice_number,
           jsonb_build_object('entity_type', d.entity_type, 'entity_id', d.id, 'web_draft_id', d.id,
                              'web_reference', d.ref, 'source_channel', 'web', 'draft', true)
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
$function$;

REVOKE ALL ON FUNCTION public.web_reservation_expiring_bells() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_reservation_expiring_bells() TO service_role;

-- ------------------------------------------------------------ 4. the checkout switch: 'order' retired
-- Live body f7f37e3d…, one change: p_mode 'order' answers mode_retired. The
-- value stays 'draft'; web_checkout_mode() and get_web_checkout_mode() are
-- unchanged. The Hub card is removed in the same PR (owner D2).
CREATE OR REPLACE FUNCTION public.set_web_checkout_mode(p_mode text, p_expected text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- WEBSITE ORDERS PR 10 (2026-10-01): the order path no longer exists.
  IF p_mode = 'order' THEN
    RETURN jsonb_build_object('error', 'mode_retired', 'mode', public.web_checkout_mode());
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
$function$;

REVOKE ALL ON FUNCTION public.set_web_checkout_mode(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_web_checkout_mode(text, text) TO authenticated, service_role;

-- ------------------------------------------------------------ 5. assertions
DO $$
BEGIN
  IF to_regprocedure('public.confirm_web_order_ready_atomic(text, uuid, uuid, text)') IS NOT NULL
     OR to_regprocedure('public.decline_web_layaway_reservation_atomic(uuid, text, uuid, text)') IS NOT NULL
     OR to_regprocedure('public.expire_unconfirmed_web_reservations_atomic(integer, integer)') IS NOT NULL
     OR to_regprocedure('public.set_web_reservation_mode(boolean, boolean)') IS NOT NULL
     OR to_regprocedure('public.get_web_reservation_mode()') IS NOT NULL
     OR to_regprocedure('public.guard_web_reservation_mode()') IS NOT NULL THEN
    RAISE EXCEPTION 'PR 10: an old reserve-first function survived.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'web_reservation_mode') THEN
    RAISE EXCEPTION 'PR 10: web_reservation_mode row survived.';
  END IF;
  IF public.web_checkout_mode() <> 'draft' THEN
    RAISE EXCEPTION 'PR 10: web_checkout_mode is not draft after the migration.';
  END IF;
END $$;