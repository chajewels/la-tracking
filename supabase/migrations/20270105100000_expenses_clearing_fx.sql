-- ============================================================================
-- Finance -> Expenses, Phase 6: provider fees, clearing, own-account transfers, peso revaluation
-- (owner 2026-10-26, D1–D6 as recommended). Plan: project doc claude/expenses-phase6-clearing-fx-plan-2026-10-26.md.
-- Branch feat/expenses. NOT APPLIED ANYWHERE.
--
-- What this does
--   * php_jpy_rate_history: every change of system_settings.php_jpy_rate is logged (trigger) and audited;
--     gl_rate_at(date) = the rate in effect on a day. set_php_jpy_rate(rate, effective_from) lets an admin date a
--     rate (historical rows do not change the live setting).
--   * provider_settlements: finance records each Square / Paidy / Stripe payout and each courier COD remittance
--     (amount received, statement fees, adjustments, bank account). Events settlement_payout (Dr bank / Cr clearing),
--     settlement_fee (Dr 6300 — or 5400 for the courier — / Cr clearing), settlement_adjustment (4900 / 6900).
--   * fund_transfers: money moved between the company's own accounts (SMBC -> BDO remittance, bank -> cash).
--     Event fund_transfer: Dr to / Cr from in each leg's currency, the bank's fee to 6300, the yen difference between
--     the legs to 4950 / 6800 (realised FX at the bank's actual rate vs the Hub's one rate).
--   * square_fee: Square's processing fee from the payment payload, Dr 6300 / Cr 1130 at capture; a refund that
--     returns fee posts the mirror.
--   * fx_revaluation: at each month end every ASSET / LIABILITY account carrying peso lines (not revenue or
--     expenses) is revalued to the rate in effect; balances are taken as the books stand at that month end
--     (a reversal dated today does not change a past month, exactly like the trial balance):
--     increment = (round(native ₱ / rate) − carrying yen) − previous month's cumulative → Dr account / Cr 4950 or
--     Dr 6800 / Cr account. Derived from posted PESO lines only (revaluation lines are yen), so a rate change
--     re-derives from that month on through the normal reversal + repost.
--   * The three provider-fee expense categories are booked automatically now: a manual or emailed expense in them
--     is refused (category_booked_automatically) and the email reader no longer offers them.
--   * gl_current_events = gl_base_events UNION gl_cogs_events UNION gl_clearing_events.
--
-- Rules kept: re-runnable; RLS as scalar sub-selects; REVOKE from PUBLIC/anon on every RPC; no "--" comment
-- lines inside any function body (Lovable strips them); never deleted — settlements and transfers are voided.
-- ============================================================================

SET lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Peso rate history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.php_jpy_rate_history (
  effective_from date PRIMARY KEY,
  rate           numeric(12,6) NOT NULL CHECK (rate > 0),
  set_by         uuid NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.php_jpy_rate_history ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.php_jpy_rate_history IS
  'Phase 6: the one peso rate (PHP per JPY, system_settings.php_jpy_rate) by the day it took effect. Written by the system_settings trigger and set_php_jpy_rate; read by gl_rate_at for month-end revaluation.';
DROP POLICY IF EXISTS php_jpy_rate_history_read ON public.php_jpy_rate_history;
CREATE POLICY php_jpy_rate_history_read ON public.php_jpy_rate_history FOR SELECT TO authenticated
  USING ((SELECT public.has_permission((SELECT auth.uid()), 'view_ledger')));
REVOKE ALL ON public.php_jpy_rate_history FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.php_jpy_rate_history FROM authenticated;
GRANT SELECT ON public.php_jpy_rate_history TO authenticated;

INSERT INTO public.php_jpy_rate_history (effective_from, rate)
SELECT coalesce(((to_jsonb(s) ->> 'updated_at')::timestamptz AT TIME ZONE 'Asia/Tokyo')::date, (now() AT TIME ZONE 'Asia/Tokyo')::date),
       (s.value #>> '{}')::numeric
  FROM public.system_settings s
 WHERE s.key = 'php_jpy_rate' AND (s.value #>> '{}') ~ '^[0-9]+(\.[0-9]+)?$' AND (s.value #>> '{}')::numeric > 0
ON CONFLICT (effective_from) DO NOTHING;

CREATE OR REPLACE FUNCTION public.php_jpy_rate_log()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_rate numeric;
  v_old numeric;
BEGIN
  IF NEW.key <> 'php_jpy_rate' THEN RETURN NULL; END IF;
  IF (NEW.value #>> '{}') !~ '^[0-9]+(\.[0-9]+)?$' THEN RETURN NULL; END IF;
  v_rate := (NEW.value #>> '{}')::numeric;
  IF v_rate <= 0 THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND (OLD.value #>> '{}') ~ '^[0-9]+(\.[0-9]+)?$' THEN v_old := (OLD.value #>> '{}')::numeric; END IF;
  IF v_old IS NOT NULL AND v_old = v_rate THEN RETURN NULL; END IF;
  INSERT INTO public.php_jpy_rate_history (effective_from, rate, set_by)
  VALUES ((now() AT TIME ZONE 'Asia/Tokyo')::date, v_rate, auth.uid())
  ON CONFLICT (effective_from) DO UPDATE SET rate = EXCLUDED.rate, set_by = EXCLUDED.set_by, created_at = now();
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('system_setting', md5('php_jpy_rate')::uuid, 'set_php_jpy_rate',
          CASE WHEN v_old IS NULL THEN NULL ELSE jsonb_build_object('rate', v_old) END,
          jsonb_build_object('rate', v_rate, 'effective_from', (now() AT TIME ZONE 'Asia/Tokyo')::date), auth.uid(), now());
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.php_jpy_rate_log() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS system_settings_php_jpy_rate_log ON public.system_settings;
CREATE TRIGGER system_settings_php_jpy_rate_log AFTER INSERT OR UPDATE ON public.system_settings
  FOR EACH ROW EXECUTE FUNCTION public.php_jpy_rate_log();

CREATE OR REPLACE FUNCTION public.gl_rate_at(p_date date)
RETURNS numeric
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  SELECT coalesce(
    (SELECT h.rate FROM public.php_jpy_rate_history h WHERE h.effective_from <= p_date ORDER BY h.effective_from DESC LIMIT 1),
    public.gl_rate())
$fn$;
REVOKE ALL ON FUNCTION public.gl_rate_at(date) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.gl_rate_at(date) IS 'Internal: PHP-per-JPY rate in effect on a day (latest history row on or before it, else the live setting).';

CREATE OR REPLACE FUNCTION public.set_php_jpy_rate(p_rate numeric, p_effective_from date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_from date := coalesce(p_effective_from, v_today);
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'admin_settings') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_rate IS NULL OR p_rate <= 0 OR p_rate > 100 THEN RETURN jsonb_build_object('error', 'invalid_rate'); END IF;
  IF v_from > v_today OR v_from < DATE '2020-01-01' THEN RETURN jsonb_build_object('error', 'invalid_date'); END IF;
  IF v_from = v_today THEN
    UPDATE public.system_settings SET value = to_jsonb(p_rate::text) WHERE key = 'php_jpy_rate';
    IF NOT FOUND THEN INSERT INTO public.system_settings (key, value) VALUES ('php_jpy_rate', to_jsonb(p_rate::text)); END IF;
  ELSE
    INSERT INTO public.php_jpy_rate_history (effective_from, rate, set_by) VALUES (v_from, p_rate, v_uid)
    ON CONFLICT (effective_from) DO UPDATE SET rate = EXCLUDED.rate, set_by = EXCLUDED.set_by, created_at = now();
    INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
    VALUES ('system_setting', md5('php_jpy_rate')::uuid, 'set_php_jpy_rate_history', jsonb_build_object('rate', p_rate, 'effective_from', v_from), v_uid, now());
  END IF;
  RETURN jsonb_build_object('ok', true, 'rate', p_rate, 'effective_from', v_from);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_php_jpy_rate(numeric, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_php_jpy_rate(numeric, date) TO authenticated;
COMMENT ON FUNCTION public.set_php_jpy_rate(numeric, date) IS
  'Phase 6: set the peso rate for today (changes the live setting; the trigger logs it) or date a rate in the past (history only, for month-end revaluation). admin_settings, audited.';

CREATE OR REPLACE FUNCTION public.get_rate_history()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'view_ledger') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  RETURN jsonb_build_object(
    'current', public.gl_rate(),
    'can_set', public.has_permission(v_uid, 'admin_settings'),
    'history', coalesce((SELECT jsonb_agg(jsonb_build_object('effective_from', h.effective_from, 'rate', h.rate, 'set_by', h.set_by, 'created_at', h.created_at) ORDER BY h.effective_from DESC)
                           FROM public.php_jpy_rate_history h), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_rate_history() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_rate_history() TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Provider settlements (payouts, statement fees, adjustments).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.provider_settlements (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider             text NOT NULL CHECK (provider IN ('square', 'paidy', 'stripe', 'cod_carrier')),
  received_on          date NOT NULL,
  period_from          date NULL,
  period_to            date NULL,
  amount_received_jpy  numeric(15,0) NOT NULL DEFAULT 0 CHECK (amount_received_jpy >= 0),
  fees_jpy             numeric(15,0) NOT NULL DEFAULT 0 CHECK (fees_jpy >= 0),
  adjustments_jpy      numeric(15,0) NOT NULL DEFAULT 0,
  bank_account         text NULL REFERENCES public.gl_accounts(code),
  reference            text NULL CHECK (reference IS NULL OR length(reference) <= 120),
  note                 text NULL CHECK (note IS NULL OR length(note) <= 500),
  created_by           uuid NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  voided_at            timestamptz NULL,
  voided_by            uuid NULL,
  void_reason          text NULL,
  CONSTRAINT provider_settlements_something CHECK (amount_received_jpy > 0 OR fees_jpy > 0 OR adjustments_jpy <> 0),
  CONSTRAINT provider_settlements_bank_when_received CHECK (amount_received_jpy = 0 OR bank_account IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS provider_settlements_provider_idx ON public.provider_settlements (provider, received_on DESC);
ALTER TABLE public.provider_settlements ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.provider_settlements IS
  'Phase 6: one payout / statement from Square, Paidy, Stripe or the COD courier, entered by finance. Ledger: Dr bank / Cr clearing (amount received); Dr 6300 or 5400 / Cr clearing (fees); adjustments to 4900 / 6900. Voided, never deleted.';
DROP POLICY IF EXISTS provider_settlements_read ON public.provider_settlements;
CREATE POLICY provider_settlements_read ON public.provider_settlements FOR SELECT TO authenticated
  USING ((SELECT public.has_permission((SELECT auth.uid()), 'view_ledger')));
REVOKE ALL ON public.provider_settlements FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.provider_settlements FROM authenticated;
GRANT SELECT ON public.provider_settlements TO authenticated;

CREATE OR REPLACE FUNCTION public.gl_clearing_account(p_provider text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT CASE p_provider WHEN 'square' THEN '1130' WHEN 'paidy' THEN '1131' WHEN 'stripe' THEN '1132' WHEN 'cod_carrier' THEN '1140' END
$fn$;
REVOKE ALL ON FUNCTION public.gl_clearing_account(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_provider_settlement(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_start date := public.gl_ledger_start();
  v_today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_provider text := lower(btrim(coalesce(p->>'provider', '')));
  v_on date;
  v_from date;
  v_to date;
  v_amount numeric;
  v_fees numeric;
  v_adj numeric;
  v_bank text := nullif(btrim(coalesce(p->>'bank_account', '')), '');
  v_row public.provider_settlements;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'post_journal') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF v_provider NOT IN ('square', 'paidy', 'stripe', 'cod_carrier') THEN RETURN jsonb_build_object('error', 'invalid_provider'); END IF;
  BEGIN
    v_on := nullif(p->>'received_on', '')::date;
    v_from := nullif(p->>'period_from', '')::date;
    v_to := nullif(p->>'period_to', '')::date;
    v_amount := coalesce(nullif(regexp_replace(coalesce(p->>'amount_received_jpy', ''), '[^0-9.-]', '', 'g'), ''), '0')::numeric;
    v_fees := coalesce(nullif(regexp_replace(coalesce(p->>'fees_jpy', ''), '[^0-9.-]', '', 'g'), ''), '0')::numeric;
    v_adj := coalesce(nullif(regexp_replace(coalesce(p->>'adjustments_jpy', ''), '[^0-9.-]', '', 'g'), ''), '0')::numeric;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('error', 'invalid_input');
  END;
  IF v_on IS NULL OR v_on > v_today OR (v_start IS NOT NULL AND v_on < v_start) THEN RETURN jsonb_build_object('error', 'invalid_date'); END IF;
  IF v_from IS NOT NULL AND v_to IS NOT NULL AND v_from > v_to THEN RETURN jsonb_build_object('error', 'invalid_date'); END IF;
  IF v_amount < 0 OR v_fees < 0 OR v_amount <> round(v_amount) OR v_fees <> round(v_fees) OR v_adj <> round(v_adj)
     OR v_amount > 1000000000 OR v_fees > 1000000000 OR abs(v_adj) > 1000000000 THEN
    RETURN jsonb_build_object('error', 'invalid_amount');
  END IF;
  IF v_amount = 0 AND v_fees = 0 AND v_adj = 0 THEN RETURN jsonb_build_object('error', 'invalid_amount'); END IF;
  IF v_amount > 0 AND (v_bank IS NULL OR NOT EXISTS (SELECT 1 FROM public.gl_accounts a WHERE a.code = v_bank AND a.active AND a.kind = 'asset' AND a.code < '1130')) THEN
    RETURN jsonb_build_object('error', 'invalid_account');
  END IF;
  IF EXISTS (SELECT 1 FROM public.gl_periods gp WHERE gp.period_start = date_trunc('month', v_on)::date AND gp.status = 'closed') THEN
    RETURN jsonb_build_object('error', 'period_closed');
  END IF;
  INSERT INTO public.provider_settlements (provider, received_on, period_from, period_to, amount_received_jpy, fees_jpy, adjustments_jpy, bank_account, reference, note, created_by)
  VALUES (v_provider, v_on, v_from, v_to, v_amount, v_fees, v_adj, CASE WHEN v_amount > 0 THEN v_bank ELSE NULL END,
          nullif(left(btrim(coalesce(p->>'reference', '')), 120), ''), nullif(left(btrim(coalesce(p->>'note', '')), 500), ''), v_uid)
  RETURNING * INTO v_row;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('provider_settlement', v_row.id, 'record_provider_settlement', to_jsonb(v_row), v_uid, now());
  RETURN jsonb_build_object('ok', true, 'settlement', to_jsonb(v_row));
END
$fn$;
REVOKE ALL ON FUNCTION public.record_provider_settlement(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_provider_settlement(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.void_provider_settlement(p_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.provider_settlements;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'post_journal') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN RETURN jsonb_build_object('error', 'reason_required'); END IF;
  SELECT * INTO v_row FROM public.provider_settlements s WHERE s.id = p_id FOR UPDATE;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_row.voided_at IS NOT NULL THEN RETURN jsonb_build_object('error', 'already_voided'); END IF;
  UPDATE public.provider_settlements SET voided_at = now(), voided_by = v_uid, void_reason = left(btrim(p_reason), 500) WHERE id = p_id;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('provider_settlement', p_id, 'void_provider_settlement', to_jsonb(v_row), jsonb_build_object('reason', left(btrim(p_reason), 500)), v_uid, now());
  RETURN jsonb_build_object('ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.void_provider_settlement(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_provider_settlement(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Transfers between the company's own accounts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fund_transfers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_on    date NOT NULL,
  from_account   text NOT NULL REFERENCES public.gl_accounts(code),
  from_amount    numeric(15,2) NOT NULL CHECK (from_amount > 0),
  from_currency  text NOT NULL CHECK (from_currency IN ('JPY', 'PHP')),
  to_account     text NOT NULL REFERENCES public.gl_accounts(code),
  to_amount      numeric(15,2) NOT NULL CHECK (to_amount > 0),
  to_currency    text NOT NULL CHECK (to_currency IN ('JPY', 'PHP')),
  fee_amount     numeric(15,2) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
  fee_currency   text NOT NULL DEFAULT 'JPY' CHECK (fee_currency IN ('JPY', 'PHP')),
  fee_account    text NOT NULL DEFAULT '6300' REFERENCES public.gl_accounts(code),
  reference      text NULL CHECK (reference IS NULL OR length(reference) <= 120),
  note           text NULL CHECK (note IS NULL OR length(note) <= 500),
  created_by     uuid NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  voided_at      timestamptz NULL,
  voided_by      uuid NULL,
  void_reason    text NULL,
  CONSTRAINT fund_transfers_distinct CHECK (from_account <> to_account)
);
CREATE INDEX IF NOT EXISTS fund_transfers_on_idx ON public.fund_transfers (transfer_on DESC);
ALTER TABLE public.fund_transfers ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.fund_transfers IS
  'Phase 6: money moved between the company''s own accounts (SMBC -> BDO remittance, bank -> cash). Ledger: Dr to / Cr from in each leg''s currency, fee to 6300, the yen difference between the legs to 4950 / 6800. Voided, never deleted.';
DROP POLICY IF EXISTS fund_transfers_read ON public.fund_transfers;
CREATE POLICY fund_transfers_read ON public.fund_transfers FOR SELECT TO authenticated
  USING ((SELECT public.has_permission((SELECT auth.uid()), 'view_ledger')));
REVOKE ALL ON public.fund_transfers FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.fund_transfers FROM authenticated;
GRANT SELECT ON public.fund_transfers TO authenticated;

CREATE OR REPLACE FUNCTION public.record_fund_transfer(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_start date := public.gl_ledger_start();
  v_today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_on date;
  v_from text := nullif(btrim(coalesce(p->>'from_account', '')), '');
  v_to text := nullif(btrim(coalesce(p->>'to_account', '')), '');
  v_from_amt numeric;
  v_to_amt numeric;
  v_fee numeric;
  v_from_cur text := upper(btrim(coalesce(p->>'from_currency', '')));
  v_to_cur text := upper(btrim(coalesce(p->>'to_currency', '')));
  v_fee_cur text := upper(btrim(coalesce(nullif(p->>'fee_currency', ''), p->>'from_currency', 'JPY')));
  v_fee_acct text := coalesce(nullif(btrim(p->>'fee_account'), ''), '6300');
  v_row public.fund_transfers;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'post_journal') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  BEGIN
    v_on := nullif(p->>'transfer_on', '')::date;
    v_from_amt := nullif(regexp_replace(coalesce(p->>'from_amount', ''), '[^0-9.]', '', 'g'), '')::numeric;
    v_to_amt := nullif(regexp_replace(coalesce(p->>'to_amount', ''), '[^0-9.]', '', 'g'), '')::numeric;
    v_fee := coalesce(nullif(regexp_replace(coalesce(p->>'fee_amount', ''), '[^0-9.]', '', 'g'), ''), '0')::numeric;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('error', 'invalid_input');
  END;
  IF v_on IS NULL OR v_on > v_today OR (v_start IS NOT NULL AND v_on < v_start) THEN RETURN jsonb_build_object('error', 'invalid_date'); END IF;
  IF v_from IS NULL OR v_to IS NULL OR v_from = v_to
     OR NOT EXISTS (SELECT 1 FROM public.gl_accounts a WHERE a.code = v_from AND a.active AND a.kind = 'asset' AND a.code < '1200')
     OR NOT EXISTS (SELECT 1 FROM public.gl_accounts a WHERE a.code = v_to AND a.active AND a.kind = 'asset' AND a.code < '1200') THEN
    RETURN jsonb_build_object('error', 'invalid_account');
  END IF;
  IF v_from_cur NOT IN ('JPY', 'PHP') OR v_to_cur NOT IN ('JPY', 'PHP') OR v_fee_cur NOT IN ('JPY', 'PHP') THEN RETURN jsonb_build_object('error', 'invalid_currency'); END IF;
  IF v_from_amt IS NULL OR v_to_amt IS NULL OR v_from_amt <= 0 OR v_to_amt <= 0 OR v_fee < 0
     OR v_from_amt > 1000000000 OR v_to_amt > 1000000000 OR v_fee > 1000000000
     OR (v_from_cur = 'JPY' AND v_from_amt <> round(v_from_amt)) OR (v_to_cur = 'JPY' AND v_to_amt <> round(v_to_amt)) OR (v_fee_cur = 'JPY' AND v_fee <> round(v_fee))
     OR v_from_amt <> round(v_from_amt, 2) OR v_to_amt <> round(v_to_amt, 2) OR v_fee <> round(v_fee, 2) THEN
    RETURN jsonb_build_object('error', 'invalid_amount');
  END IF;
  IF v_from_cur = v_to_cur AND v_from_cur = v_fee_cur AND v_from_amt <> v_to_amt + v_fee AND v_from_amt <> v_to_amt THEN
    RETURN jsonb_build_object('error', 'amounts_differ');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gl_accounts a WHERE a.code = v_fee_acct AND a.active AND a.kind IN ('expense', 'cogs')) THEN RETURN jsonb_build_object('error', 'invalid_account'); END IF;
  IF EXISTS (SELECT 1 FROM public.gl_periods gp WHERE gp.period_start = date_trunc('month', v_on)::date AND gp.status = 'closed') THEN
    RETURN jsonb_build_object('error', 'period_closed');
  END IF;
  INSERT INTO public.fund_transfers (transfer_on, from_account, from_amount, from_currency, to_account, to_amount, to_currency, fee_amount, fee_currency, fee_account, reference, note, created_by)
  VALUES (v_on, v_from, v_from_amt, v_from_cur, v_to, v_to_amt, v_to_cur, v_fee, v_fee_cur, v_fee_acct,
          nullif(left(btrim(coalesce(p->>'reference', '')), 120), ''), nullif(left(btrim(coalesce(p->>'note', '')), 500), ''), v_uid)
  RETURNING * INTO v_row;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('fund_transfer', v_row.id, 'record_fund_transfer', to_jsonb(v_row), v_uid, now());
  RETURN jsonb_build_object('ok', true, 'transfer', to_jsonb(v_row));
END
$fn$;
REVOKE ALL ON FUNCTION public.record_fund_transfer(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_fund_transfer(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.void_fund_transfer(p_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.fund_transfers;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'post_journal') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN RETURN jsonb_build_object('error', 'reason_required'); END IF;
  SELECT * INTO v_row FROM public.fund_transfers t WHERE t.id = p_id FOR UPDATE;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_row.voided_at IS NOT NULL THEN RETURN jsonb_build_object('error', 'already_voided'); END IF;
  UPDATE public.fund_transfers SET voided_at = now(), voided_by = v_uid, void_reason = left(btrim(p_reason), 500) WHERE id = p_id;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('fund_transfer', p_id, 'void_fund_transfer', to_jsonb(v_row), jsonb_build_object('reason', left(btrim(p_reason), 500)), v_uid, now());
  RETURN jsonb_build_object('ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.void_fund_transfer(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_fund_transfer(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Provider-fee categories are booked automatically from here on.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expenses_refuse_auto_fee_categories()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.category_id IS NOT DISTINCT FROM OLD.category_id THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.expense_categories c WHERE c.id = NEW.category_id AND c.system_key IN ('square_fees', 'paidy_fees', 'stripe_fees')) THEN
    RAISE EXCEPTION 'category_booked_automatically' USING ERRCODE = 'check_violation',
      HINT = 'Square, Paidy and Stripe fees are booked from the payments and settlements (Finance -> Ledger -> Clearing), not as expenses.';
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS expenses_auto_fee_guard ON public.expenses;
CREATE TRIGGER expenses_auto_fee_guard BEFORE INSERT OR UPDATE OF category_id ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.expenses_refuse_auto_fee_categories();

CREATE OR REPLACE FUNCTION public.expenses_email_context()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  IF auth.uid() IS NOT NULL THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  RETURN jsonb_build_object(
    'enabled', coalesce((SELECT (value #>> '{}') FROM public.system_settings WHERE key = 'expenses_email_enabled'), 'false') = 'true',
    'mailbox', coalesce((SELECT (value #>> '{}') FROM public.system_settings WHERE key = 'expenses_email_mailbox'), 'sales@chajewelsjp.com'),
    'rate_set', (SELECT (value #>> '{}')::numeric FROM public.system_settings WHERE key = 'php_jpy_rate') IS NOT NULL,
    'known_ids', coalesce((SELECT jsonb_agg(m.gmail_message_id) FROM public.expense_email_messages m WHERE m.created_at > now() - interval '14 days'), '[]'::jsonb),
    'categories', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'group_key', c.group_key) ORDER BY c.group_key, c.sort_order)
                              FROM public.expense_categories c WHERE c.active AND (c.system_key IS NULL OR c.system_key NOT IN ('payroll', 'commission', 'uncategorised', 'square_fees', 'paidy_fees', 'stripe_fees'))), '[]'::jsonb),
    'vendors', coalesce((SELECT jsonb_agg(v.name ORDER BY lower(v.name)) FROM public.expense_vendors v WHERE v.active), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.expenses_email_context() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expenses_email_context() TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Ledger events.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gl_clearing_events(p_until date)
RETURNS TABLE (source_type text, source_id uuid, source_date date, description text, lines jsonb,
               customer_id uuid, account_id uuid, cash_order_id uuid, expense_id uuid)
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  WITH s AS (SELECT public.gl_ledger_start() AS start_date, public.gl_rate() AS rate),

  sq_fee AS (
    SELECT sp.id, sp.cash_order_id,
           (coalesce(sp.captured_at, sp.updated_at) AT TIME ZONE 'Asia/Tokyo')::date AS d,
           (SELECT coalesce(sum((f->'amount_money'->>'amount')::numeric), 0)
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(sp.last_payload->'processing_fee') = 'array' THEN sp.last_payload->'processing_fee'
                                             WHEN jsonb_typeof(sp.last_payload->'payment'->'processing_fee') = 'array' THEN sp.last_payload->'payment'->'processing_fee'
                                             ELSE '[]'::jsonb END) f) AS fee
      FROM public.square_payments sp
     WHERE sp.captured_at IS NOT NULL AND coalesce(sp.test, false) = false AND coalesce(sp.environment, 'production') = 'production'
       AND sp.status NOT IN ('voided', 'rejected', 'failed')),

  settle AS (SELECT ps.*, public.gl_clearing_account(ps.provider) AS clearing FROM public.provider_settlements ps WHERE ps.voided_at IS NULL),

  months AS (
    SELECT (date_trunc('month', s.start_date) + (k || ' months')::interval)::date AS m_start,
           (date_trunc('month', s.start_date) + ((k + 1) || ' months')::interval - interval '1 day')::date AS m_end
      FROM s CROSS JOIN generate_series(0, 600) AS k
     WHERE s.start_date IS NOT NULL
       AND (date_trunc('month', s.start_date) + ((k + 1) || ' months')::interval - interval '1 day')::date <= p_until),
  php_acct AS (
    SELECT DISTINCT l.account_code FROM public.gl_journal_lines l JOIN public.gl_accounts a ON a.code = l.account_code
     WHERE l.currency = 'PHP' AND a.kind IN ('asset', 'liability')),
  bal AS (
    SELECT a.account_code, mo.m_end,
           coalesce(sum(l.debit - l.credit), 0) AS native,
           coalesce(sum(l.debit_jpy - l.credit_jpy), 0) AS carrying
      FROM php_acct a
      CROSS JOIN months mo
      LEFT JOIN (public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id)
             ON l.account_code = a.account_code AND l.currency = 'PHP' AND j.entry_date <= mo.m_end
     GROUP BY a.account_code, mo.m_end),
  cum AS (
    SELECT b.*, round(b.native / public.gl_rate_at(b.m_end)) - b.carrying AS cumulative, public.gl_rate_at(b.m_end) AS rate_used FROM bal b),
  inc AS (
    SELECT c.*, c.cumulative - coalesce(lag(c.cumulative) OVER (PARTITION BY c.account_code ORDER BY c.m_end), 0) AS increment FROM cum c)

  SELECT 'square_fee', sq.id, sq.d,
         'Square fee ' || coalesce(co.invoice_number, sq.id::text),
         jsonb_build_array(
           jsonb_build_object('a', '6300', 'side', 'dr', 'amt', sq.fee, 'cur', 'JPY', 'memo', 'Square processing fee'),
           jsonb_build_object('a', '1130', 'side', 'cr', 'amt', sq.fee, 'cur', 'JPY', 'memo', coalesce(co.invoice_number, 'Square'))),
         co.customer_id, NULL::uuid, sq.cash_order_id, NULL::uuid
    FROM sq_fee sq
    LEFT JOIN public.cash_orders co ON co.id = sq.cash_order_id
    CROSS JOIN s
   WHERE sq.fee > 0 AND coalesce(co.is_test, false) = false AND sq.d >= s.start_date AND sq.d <= p_until

  UNION ALL
  SELECT 'settlement_payout', st.id, st.received_on,
         initcap(replace(st.provider, '_', ' ')) || ' payout' || coalesce(' ' || st.reference, ''),
         jsonb_build_array(
           jsonb_build_object('a', st.bank_account, 'side', 'dr', 'amt', st.amount_received_jpy, 'cur', 'JPY', 'memo', coalesce(st.reference, 'Payout')),
           jsonb_build_object('a', st.clearing, 'side', 'cr', 'amt', st.amount_received_jpy, 'cur', 'JPY', 'memo', 'Settled')),
         NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid
    FROM settle st CROSS JOIN s
   WHERE st.amount_received_jpy > 0 AND st.received_on >= s.start_date AND st.received_on <= p_until

  UNION ALL
  SELECT 'settlement_fee', md5('settlement_fee:' || st.id::text)::uuid, st.received_on,
         initcap(replace(st.provider, '_', ' ')) || CASE WHEN st.provider = 'cod_carrier' THEN ' COD charges' ELSE ' statement fees' END || coalesce(' ' || st.reference, ''),
         jsonb_build_array(
           jsonb_build_object('a', CASE WHEN st.provider = 'cod_carrier' THEN '5400' ELSE '6300' END, 'side', 'dr', 'amt', st.fees_jpy, 'cur', 'JPY', 'memo', coalesce(st.note, 'Fees')),
           jsonb_build_object('a', st.clearing, 'side', 'cr', 'amt', st.fees_jpy, 'cur', 'JPY', 'memo', 'Fees deducted')),
         NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid
    FROM settle st CROSS JOIN s
   WHERE st.fees_jpy > 0 AND st.received_on >= s.start_date AND st.received_on <= p_until

  UNION ALL
  SELECT 'settlement_adjustment', md5('settlement_adj:' || st.id::text)::uuid, st.received_on,
         initcap(replace(st.provider, '_', ' ')) || ' adjustment' || coalesce(' ' || st.reference, ''),
         CASE WHEN st.adjustments_jpy > 0 THEN jsonb_build_array(
                jsonb_build_object('a', st.clearing, 'side', 'dr', 'amt', st.adjustments_jpy, 'cur', 'JPY', 'memo', 'Adjustment in our favour'),
                jsonb_build_object('a', '4900', 'side', 'cr', 'amt', st.adjustments_jpy, 'cur', 'JPY', 'memo', coalesce(st.note, 'Settlement adjustment')))
              ELSE jsonb_build_array(
                jsonb_build_object('a', '6900', 'side', 'dr', 'amt', -st.adjustments_jpy, 'cur', 'JPY', 'memo', coalesce(st.note, 'Settlement adjustment')),
                jsonb_build_object('a', st.clearing, 'side', 'cr', 'amt', -st.adjustments_jpy, 'cur', 'JPY', 'memo', 'Adjustment deducted')) END,
         NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid
    FROM settle st CROSS JOIN s
   WHERE st.adjustments_jpy <> 0 AND st.received_on >= s.start_date AND st.received_on <= p_until

  UNION ALL
  SELECT 'fund_transfer', ft.id, ft.transfer_on,
         'Transfer ' || ft.from_account || ' -> ' || ft.to_account || coalesce(' ' || ft.reference, ''),
         jsonb_build_array(
           jsonb_build_object('a', ft.to_account, 'side', 'dr', 'amt', ft.to_amount, 'cur', ft.to_currency, 'jpy', public.gl_to_jpy(ft.to_amount, ft.to_currency, s.rate), 'memo', 'Received'),
           jsonb_build_object('a', ft.from_account, 'side', 'cr', 'amt', ft.from_amount, 'cur', ft.from_currency, 'jpy', public.gl_to_jpy(ft.from_amount, ft.from_currency, s.rate), 'memo', 'Sent'))
         || CASE WHEN ft.fee_amount > 0 THEN jsonb_build_array(
                jsonb_build_object('a', ft.fee_account, 'side', 'dr', 'amt', ft.fee_amount, 'cur', ft.fee_currency, 'jpy', public.gl_to_jpy(ft.fee_amount, ft.fee_currency, s.rate), 'memo', 'Transfer fee'))
              ELSE '[]'::jsonb END
         || CASE WHEN public.gl_to_jpy(ft.from_amount, ft.from_currency, s.rate) - public.gl_to_jpy(ft.to_amount, ft.to_currency, s.rate) - public.gl_to_jpy(ft.fee_amount, ft.fee_currency, s.rate) > 0
                 THEN jsonb_build_array(jsonb_build_object('a', '6800', 'side', 'dr',
                        'amt', public.gl_to_jpy(ft.from_amount, ft.from_currency, s.rate) - public.gl_to_jpy(ft.to_amount, ft.to_currency, s.rate) - public.gl_to_jpy(ft.fee_amount, ft.fee_currency, s.rate),
                        'cur', 'JPY', 'memo', 'FX difference on transfer'))
                 WHEN public.gl_to_jpy(ft.from_amount, ft.from_currency, s.rate) - public.gl_to_jpy(ft.to_amount, ft.to_currency, s.rate) - public.gl_to_jpy(ft.fee_amount, ft.fee_currency, s.rate) < 0
                 THEN jsonb_build_array(jsonb_build_object('a', '4950', 'side', 'cr',
                        'amt', public.gl_to_jpy(ft.to_amount, ft.to_currency, s.rate) + public.gl_to_jpy(ft.fee_amount, ft.fee_currency, s.rate) - public.gl_to_jpy(ft.from_amount, ft.from_currency, s.rate),
                        'cur', 'JPY', 'memo', 'FX difference on transfer'))
                 ELSE '[]'::jsonb END,
         NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid
    FROM public.fund_transfers ft CROSS JOIN s
   WHERE ft.voided_at IS NULL AND ft.transfer_on >= s.start_date AND ft.transfer_on <= p_until

  UNION ALL
  SELECT 'fx_revaluation', md5('fxrev:' || i.account_code || ':' || to_char(i.m_end, 'YYYY-MM'))::uuid, i.m_end,
         'Peso revaluation ' || i.account_code || ' ' || to_char(i.m_end, 'Mon YYYY') || ' (₱1 = ¥' || round(1 / i.rate_used, 4) || ')',
         CASE WHEN i.increment > 0 THEN jsonb_build_array(
                jsonb_build_object('a', i.account_code, 'side', 'dr', 'amt', i.increment, 'cur', 'JPY', 'memo', 'Revalued at month-end rate'),
                jsonb_build_object('a', '4950', 'side', 'cr', 'amt', i.increment, 'cur', 'JPY', 'memo', 'Unrealised FX gain'))
              ELSE jsonb_build_array(
                jsonb_build_object('a', '6800', 'side', 'dr', 'amt', -i.increment, 'cur', 'JPY', 'memo', 'Unrealised FX loss'),
                jsonb_build_object('a', i.account_code, 'side', 'cr', 'amt', -i.increment, 'cur', 'JPY', 'memo', 'Revalued at month-end rate')) END,
         NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid
    FROM inc i
   WHERE i.increment <> 0
$fn$;
REVOKE ALL ON FUNCTION public.gl_clearing_events(date) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.gl_clearing_events(date) IS
  'Internal (Phase 6): square_fee, settlement_payout / settlement_fee / settlement_adjustment, fund_transfer, fx_revaluation (month-end, from posted peso lines only).';

CREATE OR REPLACE FUNCTION public.gl_current_events(p_until date)
RETURNS TABLE (source_type text, source_id uuid, source_date date, description text, lines jsonb,
               customer_id uuid, account_id uuid, cash_order_id uuid, expense_id uuid)
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  SELECT * FROM public.gl_base_events(p_until)
  UNION ALL
  SELECT * FROM public.gl_cogs_events(p_until)
  UNION ALL
  SELECT * FROM public.gl_clearing_events(p_until)
$fn$;
REVOKE ALL ON FUNCTION public.gl_current_events(date) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.gl_current_events(date) IS
  'Internal: every Hub money event the ledger should hold up to p_until — gl_base_events (Phases 2b–4) UNION gl_cogs_events (Phase 5) UNION gl_clearing_events (Phase 6). gl_post_pending diffs this against the live auto journals.';

-- ---------------------------------------------------------------------------
-- 6. Reads for Finance -> Ledger -> Clearing & FX.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_clearing_summary(p_months integer DEFAULT 6)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_since date := (date_trunc('month', (now() AT TIME ZONE 'Asia/Tokyo')::date) - ((greatest(coalesce(p_months, 6), 1) - 1) || ' months')::interval)::date;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'view_ledger') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  RETURN jsonb_build_object(
    'ledger_start', public.gl_ledger_start(),
    'can_post', public.has_permission(v_uid, 'post_journal'),
    'providers', (
      SELECT jsonb_agg(jsonb_build_object(
               'provider', p.provider, 'account', p.code, 'name', a.name,
               'captured_jpy', coalesce((SELECT sum(l.debit_jpy) FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id
                                           WHERE l.account_code = p.code AND j.source_type IN ('payment', 'cash_payment')), 0)
                             - coalesce((SELECT sum(l.credit_jpy) FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id
                                           WHERE l.account_code = p.code AND j.kind = 'reversal' AND j.source_type IN ('payment', 'cash_payment')), 0),
               'fees_jpy', coalesce((SELECT sum(l.credit_jpy) - sum(l.debit_jpy) FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id
                                       WHERE l.account_code = p.code AND j.source_type IN ('square_fee', 'settlement_fee')), 0),
               'refunds_jpy', coalesce((SELECT sum(l.credit_jpy) - sum(l.debit_jpy) FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id
                                          WHERE l.account_code = p.code AND j.source_type IN ('square_refund', 'paidy_refund', 'web_refund')), 0),
               'payouts_jpy', coalesce((SELECT sum(l.credit_jpy) - sum(l.debit_jpy) FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id
                                          WHERE l.account_code = p.code AND j.source_type = 'settlement_payout'), 0),
               'adjustments_jpy', coalesce((SELECT sum(l.debit_jpy) - sum(l.credit_jpy) FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id
                                              WHERE l.account_code = p.code AND j.source_type = 'settlement_adjustment'), 0),
               'balance_jpy', coalesce((SELECT sum(l.debit_jpy) - sum(l.credit_jpy) FROM public.gl_journal_lines l WHERE l.account_code = p.code), 0),
               'oldest_open', (SELECT min(j.entry_date) FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id
                                WHERE l.account_code = p.code AND l.debit_jpy > 0 AND j.status = 'posted' AND j.kind = 'auto' AND j.source_type IN ('payment', 'cash_payment')
                                  AND j.entry_date > coalesce((SELECT max(st.received_on) FROM public.provider_settlements st WHERE st.provider = p.provider AND st.voided_at IS NULL AND st.amount_received_jpy > 0), DATE '1900-01-01'))
             ) ORDER BY p.code)
        FROM (VALUES ('square', '1130'), ('paidy', '1131'), ('stripe', '1132'), ('cod_carrier', '1140')) AS p(provider, code)
        JOIN public.gl_accounts a ON a.code = p.code),
    'settlements', coalesce((SELECT jsonb_agg(to_jsonb(st) ORDER BY st.received_on DESC, st.created_at DESC)
                               FROM public.provider_settlements st WHERE st.received_on >= v_since), '[]'::jsonb),
    'transfers', coalesce((SELECT jsonb_agg(to_jsonb(ft) || jsonb_build_object(
                             'fx_jpy', public.gl_to_jpy(ft.to_amount, ft.to_currency, public.gl_rate()) + public.gl_to_jpy(ft.fee_amount, ft.fee_currency, public.gl_rate()) - public.gl_to_jpy(ft.from_amount, ft.from_currency, public.gl_rate()))
                             ORDER BY ft.transfer_on DESC, ft.created_at DESC)
                             FROM public.fund_transfers ft WHERE ft.transfer_on >= v_since), '[]'::jsonb),
    'accounts', coalesce((SELECT jsonb_agg(jsonb_build_object('code', a.code, 'name', a.name, 'currency_hint', a.currency_hint) ORDER BY a.sort_order)
                            FROM public.gl_accounts a WHERE a.active AND a.kind = 'asset' AND a.code < '1200'), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_clearing_summary(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_clearing_summary(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_fx_revaluation(p_month date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_month date := date_trunc('month', coalesce(p_month, (now() AT TIME ZONE 'Asia/Tokyo')::date))::date;
  v_end date;
  v_prev date;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'view_ledger') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  v_end := (v_month + interval '1 month' - interval '1 day')::date;
  v_prev := (v_month - interval '1 day')::date;
  RETURN jsonb_build_object(
    'month', v_month, 'month_end', v_end,
    'rate_used', public.gl_rate_at(v_end),
    'posted', v_end <= (now() AT TIME ZONE 'Asia/Tokyo')::date,
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'account', x.account_code, 'name', a.name, 'kind', a.kind,
               'native_php', x.native, 'carrying_jpy', x.carrying, 'target_jpy', round(x.native / public.gl_rate_at(v_end)),
               'cumulative_jpy', round(x.native / public.gl_rate_at(v_end)) - x.carrying,
               'previous_cumulative_jpy', coalesce(pv.cumulative, 0),
               'increment_jpy', (round(x.native / public.gl_rate_at(v_end)) - x.carrying) - coalesce(pv.cumulative, 0)) ORDER BY x.account_code)
        FROM (SELECT l.account_code, sum(l.debit - l.credit) AS native, sum(l.debit_jpy - l.credit_jpy) AS carrying
                FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id
               WHERE l.currency = 'PHP' AND j.entry_date <= v_end GROUP BY l.account_code) x
        JOIN public.gl_accounts a ON a.code = x.account_code AND a.kind IN ('asset', 'liability')
        LEFT JOIN LATERAL (
          SELECT round(sum(l.debit - l.credit) / public.gl_rate_at(v_prev)) - sum(l.debit_jpy - l.credit_jpy) AS cumulative
            FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id
           WHERE l.currency = 'PHP' AND l.account_code = x.account_code AND j.entry_date <= v_prev) pv ON true), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_fx_revaluation(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_fx_revaluation(date) TO authenticated;
COMMENT ON FUNCTION public.get_fx_revaluation(date) IS
  'Phase 6: per account with peso lines — native ₱ balance, carrying yen, month-end rate, revalued yen and this month''s increment (what fx_revaluation posts). view_ledger.';
