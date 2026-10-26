-- ============================================================================
-- Expenses Phase 7 — statements and the 税理士 pack (owner 2026-10-26; plan
-- claude/expenses-phase7-statements-plan-2026-10-26.md, D1–D6 as recommended).
--
-- Adds, on top of Phases 1–6:
--   * gl_accounts.name_ja — the 勘定科目 name the accountant uses, seeded for every account; upsert_gl_account
--     re-stated so admins can edit it (D4).
--   * statement_flag_pct / statement_flag_jpy (system_settings, 15 % / ¥100,000) + set_statement_flags (D5).
--   * get_receivable_ageing(as_of) — open layaway schedule lines by days past due, cash-order receivables by
--     order age, and the 90-day collections forecast (used alone and inside the statements).
--   * get_statements(from, to) — income statement in the 試算表 layout (営業収益 / 売上原価 / 売上総利益 /
--     販管費 / 営業利益 / 営業外 / 経常利益 / 当期純利益) with prior-period and prior-year columns, Δ and flags;
--     balance sheet at `to` and at the day before `from`; indirect cash flow tied out to the actual change in
--     cash; domestic / export split of sales by the sale's currency (D3); currency-vs-country checks (D3);
--     the fixed "booked outside the Hub" note (D2).
--   * get_journal_export(from, to, offset) — flat journal lines (≤ 20,000 per call) with name_ja and a
--     domestic / export tax flag on sales lines, for the CSV the 税理士 receives.
--
-- Nothing here writes to the books: every statement is derived from gl_journals / gl_journal_lines as they
-- stand. Rules kept: re-runnable; RLS as scalar sub-selects; REVOKE from PUBLIC/anon on every RPC (internal
-- helpers also from authenticated); no "--" comment lines inside any function body (Lovable strips them).
-- ============================================================================

SET lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Japanese account names (D4).
-- ---------------------------------------------------------------------------
ALTER TABLE public.gl_accounts ADD COLUMN IF NOT EXISTS name_ja text NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gl_accounts_name_ja_len') THEN
    ALTER TABLE public.gl_accounts ADD CONSTRAINT gl_accounts_name_ja_len CHECK (name_ja IS NULL OR length(btrim(name_ja)) BETWEEN 1 AND 60);
  END IF;
END $$;
COMMENT ON COLUMN public.gl_accounts.name_ja IS
  'Phase 7: the 勘定科目 name the accountant uses for this account. Printed beside the English name on statements, the 税理士 pack and the journal CSV. Seeded once; editable by admins through upsert_gl_account.';

-- Seed only where no name exists yet so an admin's edit is never overwritten by a re-run.
UPDATE public.gl_accounts a SET name_ja = v.ja, updated_at = now()
  FROM (VALUES
    ('1010', '現金（日本）'),            ('1020', '現金（フィリピン）'),
    ('1101', '普通預金 三井住友'),        ('1102', '普通預金 楽天'),           ('1103', '普通預金 ゆうちょ'),
    ('1104', '普通預金 亀有信金'),        ('1111', '普通預金 BDO'),            ('1112', '普通預金 BPI'),
    ('1113', '普通預金 Metrobank'),       ('1121', '電子マネー GCash'),        ('1122', '電子マネー PayPay'),
    ('1130', '未収入金 Square'),          ('1131', '未収入金 Paidy'),          ('1132', '未収入金 Stripe'),
    ('1140', '未収入金 代引き'),          ('1190', '不明入金'),                ('1195', '仮払金'),
    ('1200', '売掛金（分割払い）'),       ('1210', '売掛金（一括注文）'),      ('1300', '商品'),
    ('1310', '商品（買取品）'),           ('1400', '前払費用'),                ('1500', '工具器具備品'),
    ('2100', '未払金'),                   ('2210', '前受金'),                  ('2300', 'ストアクレジット（商品券）'),
    ('2400', '未払給与'),                 ('2410', '未払販売手数料'),          ('2500', '仮受消費税'),
    ('2600', '未払金（返金）'),           ('2700', '短期借入金'),              ('2750', '長期借入金'),
    ('2800', '預り金'),                   ('2900', '仮受金'),
    ('3000', '資本金'),                   ('3100', '繰越利益剰余金'),          ('3900', '役員貸付金'),
    ('4100', '売上高'),                   ('4150', '売上値引戻り高'),          ('4160', '売上値引（ポイント）'),
    ('4170', '売上値引（クレジット）'),   ('4200', '役務収益'),                ('4300', '荷造運賃収入'),
    ('4400', '遅延損害金収入'),           ('4500', '解約違約金収入'),          ('4900', '雑収入'),
    ('4950', '為替差益'),
    ('5100', '仕入高'),                   ('5200', '外注加工費'),              ('5250', '鑑定・鑑別費'),
    ('5300', '荷造包装費'),               ('5400', '荷造運賃'),                ('5500', '買取仕入高'),
    ('5900', '商品評価損'),               ('5950', '貸倒損失'),
    ('6110', '給料手当'),                 ('6120', '販売手数料'),              ('6130', '賞与'),
    ('6200', '広告宣伝費'),               ('6300', '支払手数料'),              ('6400', '運送保険料・関税'),
    ('6500', '通信費'),                   ('6600', '事務所費'),                ('6700', '租税公課・支払報酬'),
    ('6800', '為替差損'),                 ('6900', '雑費'),                    ('6950', '支払利息')
  ) AS v(code, ja)
 WHERE a.code = v.code AND a.name_ja IS NULL;

-- upsert_gl_account re-stated: learns name_ja (optional on insert and update). Everything else unchanged.
CREATE OR REPLACE FUNCTION public.upsert_gl_account(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_code text := btrim(coalesce(p->>'code', ''));
  v_name text := btrim(coalesce(p->>'name', ''));
  v_kind text := p->>'kind';
  v_active boolean := coalesce((p->>'active')::boolean, true);
  v_has_ja boolean := p ? 'name_ja';
  v_ja text := nullif(btrim(coalesce(p->>'name_ja', '')), '');
  v_old public.gl_accounts;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'admin_settings') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF v_code !~ '^[1-6][0-9]{3}$' THEN RETURN jsonb_build_object('error', 'invalid_code'); END IF;
  IF length(v_name) NOT BETWEEN 1 AND 120 THEN RETURN jsonb_build_object('error', 'invalid_name'); END IF;
  IF v_ja IS NOT NULL AND length(v_ja) > 60 THEN RETURN jsonb_build_object('error', 'invalid_name_ja'); END IF;
  SELECT * INTO v_old FROM public.gl_accounts WHERE code = v_code;
  IF v_old.code IS NULL THEN
    IF coalesce(v_kind, '') NOT IN ('asset', 'liability', 'equity', 'revenue', 'cogs', 'expense') THEN RETURN jsonb_build_object('error', 'invalid_kind'); END IF;
    INSERT INTO public.gl_accounts (code, name, name_ja, kind, contra, currency_hint, active, sort_order)
    VALUES (v_code, v_name, v_ja, v_kind, coalesce((p->>'contra')::boolean, false), nullif(p->>'currency_hint', ''), v_active,
            coalesce((p->>'sort_order')::int, (left(v_code, 1)::int * 100) + 900));
  ELSE
    IF NOT v_active AND v_old.system_key IS NOT NULL THEN RETURN jsonb_build_object('error', 'system_account'); END IF;
    UPDATE public.gl_accounts
       SET name = v_name, active = v_active, updated_at = now(),
           name_ja = CASE WHEN v_has_ja THEN v_ja ELSE name_ja END
     WHERE code = v_code;
  END IF;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('gl_account', gen_random_uuid(), 'upsert_gl_account', CASE WHEN v_old.code IS NULL THEN NULL ELSE to_jsonb(v_old) END,
          (SELECT to_jsonb(a) FROM public.gl_accounts a WHERE a.code = v_code), v_uid, now());
  RETURN jsonb_build_object('ok', true, 'account', (SELECT to_jsonb(a) FROM public.gl_accounts a WHERE a.code = v_code));
END
$fn$;
REVOKE ALL ON FUNCTION public.upsert_gl_account(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_gl_account(jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Variance flags (D5): two settings the owner edits on the Statements tab.
-- ---------------------------------------------------------------------------
INSERT INTO public.system_settings (key, value) VALUES ('statement_flag_pct', '"15"'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO public.system_settings (key, value) VALUES ('statement_flag_jpy', '"100000"'::jsonb) ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.gl_statement_flags()
RETURNS TABLE (pct numeric, jpy numeric)
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  SELECT coalesce((SELECT nullif(value #>> '{}', '')::numeric FROM public.system_settings WHERE key = 'statement_flag_pct'), 15),
         coalesce((SELECT nullif(value #>> '{}', '')::numeric FROM public.system_settings WHERE key = 'statement_flag_jpy'), 100000)
$fn$;
REVOKE ALL ON FUNCTION public.gl_statement_flags() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_statement_flags(p_pct numeric, p_jpy numeric)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_old record;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'admin_settings') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_pct IS NULL OR p_pct < 0 OR p_pct > 1000 OR p_pct <> round(p_pct, 1) THEN RETURN jsonb_build_object('error', 'invalid_pct'); END IF;
  IF p_jpy IS NULL OR p_jpy < 0 OR p_jpy > 1000000000 OR p_jpy <> round(p_jpy) THEN RETURN jsonb_build_object('error', 'invalid_amount'); END IF;
  SELECT * INTO v_old FROM public.gl_statement_flags();
  INSERT INTO public.system_settings (key, value) VALUES ('statement_flag_pct', to_jsonb(p_pct::text))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  INSERT INTO public.system_settings (key, value) VALUES ('statement_flag_jpy', to_jsonb(p_jpy::text))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('gl_setting', gen_random_uuid(), 'set_statement_flags', jsonb_build_object('pct', v_old.pct, 'jpy', v_old.jpy),
          jsonb_build_object('pct', p_pct, 'jpy', p_jpy), v_uid, now());
  RETURN jsonb_build_object('ok', true, 'pct', p_pct, 'jpy', p_jpy);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_statement_flags(numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_statement_flags(numeric, numeric) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Receivable ageing and the 90-day collections forecast.
--    Current open schedule lines bucketed by days past due at p_as_of (the schedule keeps no history, so a
--    past p_as_of ages today's open lines as they would have stood on that day — stated in `basis`).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_receivable_ageing(p_as_of date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_as_of date := coalesce(p_as_of, (now() AT TIME ZONE 'Asia/Tokyo')::date);
  v_rate numeric := public.gl_rate();
  v_buckets jsonb;
  v_orders jsonb;
  v_forecast jsonb;
  v_ledger jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'view_ledger') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;

  WITH open_lines AS (
    SELECT s.account_id, s.currency::text AS cur, s.total_due_amount - s.paid_amount AS due, s.due_date,
           CASE WHEN s.due_date > v_as_of THEN 'not_due'
                WHEN v_as_of - s.due_date <= 30 THEN 'd1_30'
                WHEN v_as_of - s.due_date <= 60 THEN 'd31_60'
                WHEN v_as_of - s.due_date <= 90 THEN 'd61_90'
                ELSE 'd90p' END AS bucket
      FROM public.layaway_schedule s
      JOIN public.layaway_accounts la ON la.id = s.account_id
     WHERE s.status IN ('pending', 'partially_paid', 'overdue')
       AND s.total_due_amount - s.paid_amount > 0
       AND la.is_test = false
       AND la.status NOT IN ('cancelled', 'completed', 'forfeited', 'final_forfeited')
  ), b AS (
    SELECT bucket, count(DISTINCT account_id) AS plans, count(*) AS lines,
           sum(CASE WHEN cur = 'PHP' THEN due ELSE 0 END) AS php,
           sum(CASE WHEN cur = 'JPY' THEN due ELSE 0 END) AS jpy,
           sum(public.gl_to_jpy(due, cur, v_rate)) AS total_jpy
      FROM open_lines GROUP BY bucket
  )
  SELECT jsonb_object_agg(k, coalesce((SELECT jsonb_build_object('plans', b.plans, 'lines', b.lines, 'php', b.php, 'jpy', b.jpy, 'total_jpy', b.total_jpy) FROM b WHERE b.bucket = k),
                                       jsonb_build_object('plans', 0, 'lines', 0, 'php', 0, 'jpy', 0, 'total_jpy', 0)))
    INTO v_buckets
    FROM unnest(ARRAY['not_due', 'd1_30', 'd31_60', 'd61_90', 'd90p']) k;

  WITH open_orders AS (
    SELECT co.remaining_balance AS due, co.currency::text AS cur,
           CASE WHEN v_as_of - co.order_date <= 30 THEN 'd0_30'
                WHEN v_as_of - co.order_date <= 60 THEN 'd31_60'
                WHEN v_as_of - co.order_date <= 90 THEN 'd61_90'
                ELSE 'd90p' END AS bucket
      FROM public.cash_orders co
     WHERE co.status = 'pending' AND co.remaining_balance > 0 AND co.is_test = false AND co.order_date <= v_as_of
  ), b AS (
    SELECT bucket, count(*) AS orders,
           sum(CASE WHEN cur = 'PHP' THEN due ELSE 0 END) AS php,
           sum(CASE WHEN cur = 'JPY' THEN due ELSE 0 END) AS jpy,
           sum(public.gl_to_jpy(due, cur, v_rate)) AS total_jpy
      FROM open_orders GROUP BY bucket
  )
  SELECT jsonb_object_agg(k, coalesce((SELECT jsonb_build_object('orders', b.orders, 'php', b.php, 'jpy', b.jpy, 'total_jpy', b.total_jpy) FROM b WHERE b.bucket = k),
                                       jsonb_build_object('orders', 0, 'php', 0, 'jpy', 0, 'total_jpy', 0)))
    INTO v_orders
    FROM unnest(ARRAY['d0_30', 'd31_60', 'd61_90', 'd90p']) k;

  WITH due_lines AS (
    SELECT s.currency::text AS cur, s.total_due_amount - s.paid_amount AS due,
           CASE WHEN s.due_date <= v_as_of + 30 THEN 'next_30'
                WHEN s.due_date <= v_as_of + 60 THEN 'next_60'
                WHEN s.due_date <= v_as_of + 90 THEN 'next_90' END AS bucket
      FROM public.layaway_schedule s
      JOIN public.layaway_accounts la ON la.id = s.account_id
     WHERE s.status IN ('pending', 'partially_paid', 'overdue')
       AND s.total_due_amount - s.paid_amount > 0
       AND la.is_test = false
       AND la.status NOT IN ('cancelled', 'completed', 'forfeited', 'final_forfeited')
       AND s.due_date > v_as_of AND s.due_date <= v_as_of + 90
  ), b AS (
    SELECT bucket, count(*) AS lines,
           sum(CASE WHEN cur = 'PHP' THEN due ELSE 0 END) AS php,
           sum(CASE WHEN cur = 'JPY' THEN due ELSE 0 END) AS jpy,
           sum(public.gl_to_jpy(due, cur, v_rate)) AS total_jpy
      FROM due_lines GROUP BY bucket
  )
  SELECT jsonb_object_agg(k, coalesce((SELECT jsonb_build_object('lines', b.lines, 'php', b.php, 'jpy', b.jpy, 'total_jpy', b.total_jpy) FROM b WHERE b.bucket = k),
                                       jsonb_build_object('lines', 0, 'php', 0, 'jpy', 0, 'total_jpy', 0)))
    INTO v_forecast
    FROM unnest(ARRAY['next_30', 'next_60', 'next_90']) k;

  SELECT jsonb_build_object(
           'layaway_jpy', coalesce(sum(CASE WHEN l.account_code = '1200' THEN l.debit_jpy - l.credit_jpy END), 0),
           'orders_jpy',  coalesce(sum(CASE WHEN l.account_code = '1210' THEN l.debit_jpy - l.credit_jpy END), 0))
    INTO v_ledger
    FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id
   WHERE l.account_code IN ('1200', '1210') AND j.entry_date <= v_as_of;

  RETURN jsonb_build_object(
    'as_of', v_as_of, 'rate', v_rate,
    'basis', CASE WHEN v_as_of >= (now() AT TIME ZONE 'Asia/Tokyo')::date THEN 'current' ELSE 'current_open_lines_aged_at_date' END,
    'layaway', v_buckets, 'cash_orders', v_orders, 'forecast', v_forecast, 'ledger', v_ledger);
END
$fn$;
REVOKE ALL ON FUNCTION public.get_receivable_ageing(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_receivable_ageing(date) TO authenticated;
COMMENT ON FUNCTION public.get_receivable_ageing(date) IS
  'Phase 7: open layaway schedule lines by days past due (not due / 1–30 / 31–60 / 61–90 / 90+), pending cash-order balances by order age, the next 30 / 60 / 90 days of scheduled collections, and the ledger receivable balances for comparison. Native amounts plus yen at the Hub rate. view_ledger.';

-- ---------------------------------------------------------------------------
-- 4. Statements.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gl_stmt_pick(p jsonb, p_codes text[], p_field text)
RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT coalesce(sum((p->c->>p_field)::numeric), 0) FROM unnest(p_codes) c
$fn$;
REVOKE ALL ON FUNCTION public.gl_stmt_pick(jsonb, text[], text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.gl_stmt_kind_sum(p jsonb, p_kinds text[], p_field text, p_exclude text[])
RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT coalesce(sum((e.value->>p_field)::numeric), 0)
    FROM jsonb_each(p) e
   WHERE (e.value->>'k') = ANY (p_kinds) AND NOT (e.key = ANY (p_exclude))
$fn$;
REVOKE ALL ON FUNCTION public.gl_stmt_kind_sum(jsonb, text[], text, text[]) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.gl_stmt_line(p_key text, p_section text, p_label text, p_label_ja text, p_level int,
                                               p_cur numeric, p_prior numeric, p_py numeric, p_pct numeric, p_jpy numeric)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT jsonb_build_object(
    'key', p_key, 'section', p_section, 'label', p_label, 'label_ja', p_label_ja, 'level', p_level,
    'cur', round(p_cur), 'prior', CASE WHEN p_prior IS NULL THEN NULL ELSE round(p_prior) END,
    'prior_year', CASE WHEN p_py IS NULL THEN NULL ELSE round(p_py) END,
    'delta', CASE WHEN p_prior IS NULL THEN NULL ELSE round(p_cur - p_prior) END,
    'delta_pct', CASE WHEN p_prior IS NULL OR p_prior = 0 THEN NULL ELSE round((p_cur - p_prior) / abs(p_prior) * 100, 1) END,
    'flag', CASE WHEN p_prior IS NULL THEN false
                 ELSE abs(p_cur - p_prior) >= p_jpy OR (p_prior <> 0 AND abs(p_cur - p_prior) / abs(p_prior) * 100 >= p_pct) END)
$fn$;
REVOKE ALL ON FUNCTION public.gl_stmt_line(text, text, text, text, int, numeric, numeric, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_statements(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_start date := public.gl_ledger_start();
  v_today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_fy_month int := coalesce((SELECT nullif(value #>> '{}', '')::int FROM public.system_settings WHERE key = 'fiscal_year_start_month'), 4);
  v_fy_start date;
  v_aligned boolean;
  v_months int;
  v_pf date; v_pt date; v_yf date; v_yt date;
  v_p_ok boolean; v_y_ok boolean;
  v_pct numeric; v_jpy numeric;
  v_acc jsonb;
  v_pl jsonb := '[]'::jsonb;
  v_bs jsonb := '[]'::jsonb;
  v_cf jsonb := '[]'::jsonb;
  v_prev date := p_from - 1;
  e record;
  rev_codes text[] := ARRAY['4100', '4150', '4160', '4170', '4200', '4300', '4400', '4500', '4900', '4950'];
  cogs_codes text[] := ARRAY['5100', '5500', '5200', '5250', '5300', '5400', '5900', '5950'];
  sga_codes text[] := ARRAY['6110', '6120', '6130', '6200', '6300', '6400', '6500', '6600', '6700', '6900', '6800', '6950'];
  c numeric; p numeric; y numeric;
  cur_sales numeric; p_sales numeric; y_sales numeric;
  cur_rev numeric; p_rev numeric; y_rev numeric;
  cur_cogs numeric; p_cogs numeric; y_cogs numeric;
  cur_sga numeric; p_sga numeric; y_sga numeric;
  cur_nonop numeric; p_nonop numeric; y_nonop numeric;
  v_pl_to_date numeric; v_pl_before_fy numeric; v_pl_at_prev numeric; v_pl_before_fy_prev date; v_pl_before_fy_prev_amt numeric;
  v_assets numeric; v_liab numeric; v_equity numeric; v_assets_prev numeric; v_liab_prev numeric; v_equity_prev numeric;
  v_cash_open numeric; v_cash_close numeric; v_cf_sum numeric := 0; v_cash_fx numeric;
  v_net_profit numeric;
  v_checks jsonb;
  v_check_count int;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'view_ledger') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 1100 THEN RETURN jsonb_build_object('error', 'invalid_range'); END IF;
  SELECT f.pct, f.jpy INTO v_pct, v_jpy FROM public.gl_statement_flags() f;

  v_aligned := p_from = date_trunc('month', p_from)::date AND p_to = (date_trunc('month', p_to) + interval '1 month' - interval '1 day')::date;
  IF v_aligned THEN
    v_months := (extract(year FROM p_to)::int - extract(year FROM p_from)::int) * 12 + extract(month FROM p_to)::int - extract(month FROM p_from)::int + 1;
    v_pf := (p_from - make_interval(months => v_months))::date;
    v_pt := p_from - 1;
    v_yf := (p_from - interval '1 year')::date;
    v_yt := (date_trunc('month', p_to - interval '1 year') + interval '1 month' - interval '1 day')::date;
  ELSE
    v_pt := p_from - 1;
    v_pf := v_pt - (p_to - p_from);
    v_yf := (p_from - interval '1 year')::date;
    v_yt := (p_to - interval '1 year')::date;
  END IF;
  v_p_ok := v_start IS NOT NULL AND v_pf >= v_start;
  v_y_ok := v_start IS NOT NULL AND v_yf >= v_start;
  v_fy_start := make_date(CASE WHEN extract(month FROM p_to)::int >= v_fy_month THEN extract(year FROM p_to)::int ELSE extract(year FROM p_to)::int - 1 END, v_fy_month, 1);
  v_pl_before_fy_prev := make_date(CASE WHEN extract(month FROM v_prev)::int >= v_fy_month THEN extract(year FROM v_prev)::int ELSE extract(year FROM v_prev)::int - 1 END, v_fy_month, 1);

  SELECT jsonb_object_agg(a.code, jsonb_build_object(
           'k', a.kind, 'contra', a.contra, 'name', a.name, 'ja', a.name_ja, 'sort', a.sort_order,
           'c', coalesce(m.c, 0), 'p', coalesce(m.p, 0), 'y', coalesce(m.y, 0),
           'cx', coalesce(m.cx, 0), 'px', coalesce(m.px, 0), 'yx', coalesce(m.yx, 0),
           'b', coalesce(m.b, 0), 'pb', coalesce(m.pb, 0), 'f0', coalesce(m.f0, 0), 'f0p', coalesce(m.f0p, 0), 'fxc', coalesce(m.fxc, 0)))
    INTO v_acc
    FROM public.gl_accounts a
    LEFT JOIN (
      SELECT l.account_code,
             sum(CASE WHEN j.entry_date BETWEEN p_from AND p_to THEN l.debit_jpy - l.credit_jpy ELSE 0 END) AS c,
             sum(CASE WHEN j.entry_date BETWEEN v_pf AND v_pt THEN l.debit_jpy - l.credit_jpy ELSE 0 END) AS p,
             sum(CASE WHEN j.entry_date BETWEEN v_yf AND v_yt THEN l.debit_jpy - l.credit_jpy ELSE 0 END) AS y,
             sum(CASE WHEN l.currency = 'PHP' AND j.entry_date BETWEEN p_from AND p_to THEN l.debit_jpy - l.credit_jpy ELSE 0 END) AS cx,
             sum(CASE WHEN l.currency = 'PHP' AND j.entry_date BETWEEN v_pf AND v_pt THEN l.debit_jpy - l.credit_jpy ELSE 0 END) AS px,
             sum(CASE WHEN l.currency = 'PHP' AND j.entry_date BETWEEN v_yf AND v_yt THEN l.debit_jpy - l.credit_jpy ELSE 0 END) AS yx,
             sum(CASE WHEN j.entry_date <= p_to THEN l.debit_jpy - l.credit_jpy ELSE 0 END) AS b,
             sum(CASE WHEN j.entry_date <= v_prev THEN l.debit_jpy - l.credit_jpy ELSE 0 END) AS pb,
             sum(CASE WHEN j.entry_date < v_fy_start THEN l.debit_jpy - l.credit_jpy ELSE 0 END) AS f0,
             sum(CASE WHEN j.entry_date < v_pl_before_fy_prev THEN l.debit_jpy - l.credit_jpy ELSE 0 END) AS f0p,
             sum(CASE WHEN j.source_type = 'fx_revaluation' AND j.entry_date BETWEEN p_from AND p_to THEN l.debit_jpy - l.credit_jpy ELSE 0 END) AS fxc
        FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id
       GROUP BY l.account_code) m ON m.account_code = a.code;
  v_acc := coalesce(v_acc, '{}'::jsonb);

  /* ---- income statement: revenue positive when credit, costs positive when debit ---- */
  cur_sales := -public.gl_stmt_pick(v_acc, ARRAY['4100', '4150', '4160', '4170'], 'c');
  p_sales := CASE WHEN v_p_ok THEN -public.gl_stmt_pick(v_acc, ARRAY['4100', '4150', '4160', '4170'], 'p') END;
  y_sales := CASE WHEN v_y_ok THEN -public.gl_stmt_pick(v_acc, ARRAY['4100', '4150', '4160', '4170'], 'y') END;
  v_pl := v_pl || public.gl_stmt_line('sales', 'revenue', 'Sales (net of reversals, points and credits)', '売上高', 1, cur_sales, p_sales, y_sales, v_pct, v_jpy);
  c := -public.gl_stmt_pick(v_acc, ARRAY['4100', '4150', '4160', '4170'], 'cx');
  p := CASE WHEN v_p_ok THEN -public.gl_stmt_pick(v_acc, ARRAY['4100', '4150', '4160', '4170'], 'px') END;
  y := CASE WHEN v_y_ok THEN -public.gl_stmt_pick(v_acc, ARRAY['4100', '4150', '4160', '4170'], 'yx') END;
  v_pl := v_pl || public.gl_stmt_line('sales_domestic', 'revenue', 'of which domestic (yen sales)', '国内売上高', 2, cur_sales - c, p_sales - p, y_sales - y, v_pct, v_jpy);
  v_pl := v_pl || public.gl_stmt_line('sales_export', 'revenue', 'of which export (peso sales)', '輸出売上高', 2, c, p, y, v_pct, v_jpy);
  FOR e IN SELECT * FROM (VALUES
      ('service_income', ARRAY['4200'], 'Service income', '役務収益'),
      ('shipping_charged', ARRAY['4300'], 'Shipping and COD fees charged', '荷造運賃収入'),
      ('penalty_income', ARRAY['4400'], 'Penalty income', '遅延損害金収入'),
      ('forfeiture_income', ARRAY['4500'], 'Forfeiture income', '解約違約金収入')) AS t(key, codes, label, label_ja)
  LOOP
    v_pl := v_pl || public.gl_stmt_line(e.key, 'revenue', e.label, e.label_ja, 1,
              -public.gl_stmt_pick(v_acc, e.codes, 'c'),
              CASE WHEN v_p_ok THEN -public.gl_stmt_pick(v_acc, e.codes, 'p') END,
              CASE WHEN v_y_ok THEN -public.gl_stmt_pick(v_acc, e.codes, 'y') END, v_pct, v_jpy);
  END LOOP;
  c := -public.gl_stmt_kind_sum(v_acc, ARRAY['revenue'], 'c', rev_codes);
  p := CASE WHEN v_p_ok THEN -public.gl_stmt_kind_sum(v_acc, ARRAY['revenue'], 'p', rev_codes) END;
  y := CASE WHEN v_y_ok THEN -public.gl_stmt_kind_sum(v_acc, ARRAY['revenue'], 'y', rev_codes) END;
  IF c <> 0 OR coalesce(p, 0) <> 0 OR coalesce(y, 0) <> 0 THEN
    v_pl := v_pl || public.gl_stmt_line('revenue_other', 'revenue', 'Other operating revenue accounts', 'その他営業収益', 1, c, p, y, v_pct, v_jpy);
  END IF;
  cur_rev := -public.gl_stmt_kind_sum(v_acc, ARRAY['revenue'], 'c', ARRAY['4900', '4950']);
  p_rev := CASE WHEN v_p_ok THEN -public.gl_stmt_kind_sum(v_acc, ARRAY['revenue'], 'p', ARRAY['4900', '4950']) END;
  y_rev := CASE WHEN v_y_ok THEN -public.gl_stmt_kind_sum(v_acc, ARRAY['revenue'], 'y', ARRAY['4900', '4950']) END;
  v_pl := v_pl || public.gl_stmt_line('revenue_total', 'revenue', 'Operating revenue', '営業収益', 0, cur_rev, p_rev, y_rev, v_pct, v_jpy);

  FOR e IN SELECT * FROM (VALUES
      ('cogs_pieces', ARRAY['5100', '5500'], 'Cost of pieces sold (incl. trade-in buybacks)', '仕入高（売上原価）'),
      ('cogs_other', ARRAY['5200', '5250', '5300', '5400'], 'Vendors, appraisal, packaging, carrier', '外注加工費・鑑定費・荷造運賃'),
      ('cogs_writedown', ARRAY['5900'], 'Inventory write-down', '商品評価損'),
      ('cogs_writeoff', ARRAY['5950'], 'Receivable write-off', '貸倒損失')) AS t(key, codes, label, label_ja)
  LOOP
    v_pl := v_pl || public.gl_stmt_line(e.key, 'cogs', e.label, e.label_ja, 1,
              public.gl_stmt_pick(v_acc, e.codes, 'c'),
              CASE WHEN v_p_ok THEN public.gl_stmt_pick(v_acc, e.codes, 'p') END,
              CASE WHEN v_y_ok THEN public.gl_stmt_pick(v_acc, e.codes, 'y') END, v_pct, v_jpy);
  END LOOP;
  c := public.gl_stmt_kind_sum(v_acc, ARRAY['cogs'], 'c', cogs_codes);
  p := CASE WHEN v_p_ok THEN public.gl_stmt_kind_sum(v_acc, ARRAY['cogs'], 'p', cogs_codes) END;
  y := CASE WHEN v_y_ok THEN public.gl_stmt_kind_sum(v_acc, ARRAY['cogs'], 'y', cogs_codes) END;
  IF c <> 0 OR coalesce(p, 0) <> 0 OR coalesce(y, 0) <> 0 THEN
    v_pl := v_pl || public.gl_stmt_line('cogs_misc', 'cogs', 'Other cost of sales accounts', 'その他売上原価', 1, c, p, y, v_pct, v_jpy);
  END IF;
  cur_cogs := public.gl_stmt_kind_sum(v_acc, ARRAY['cogs'], 'c', ARRAY[]::text[]);
  p_cogs := CASE WHEN v_p_ok THEN public.gl_stmt_kind_sum(v_acc, ARRAY['cogs'], 'p', ARRAY[]::text[]) END;
  y_cogs := CASE WHEN v_y_ok THEN public.gl_stmt_kind_sum(v_acc, ARRAY['cogs'], 'y', ARRAY[]::text[]) END;
  v_pl := v_pl || public.gl_stmt_line('cogs_total', 'cogs', 'Cost of sales', '売上原価', 0, cur_cogs, p_cogs, y_cogs, v_pct, v_jpy);
  v_pl := v_pl || public.gl_stmt_line('gross_profit', 'cogs', 'Gross profit', '売上総利益', 0, cur_rev - cur_cogs, p_rev - p_cogs, y_rev - y_cogs, v_pct, v_jpy);

  FOR e IN SELECT * FROM (VALUES
      ('sga_people', ARRAY['6110', '6120', '6130'], 'People (payroll, commission, bonuses)', '給料手当・販売手数料・賞与'),
      ('sga_marketing', ARRAY['6200'], 'Marketing', '広告宣伝費'),
      ('sga_fees', ARRAY['6300'], 'Payment and bank fees', '支払手数料'),
      ('sga_shipping', ARRAY['6400'], 'Shipping insurance and customs', '運送保険料・関税'),
      ('sga_tech', ARRAY['6500'], 'Tech and subscriptions', '通信費'),
      ('sga_office', ARRAY['6600'], 'Office', '事務所費'),
      ('sga_professional', ARRAY['6700'], 'Professional and government', '租税公課・支払報酬'),
      ('sga_other', ARRAY['6900'], 'Other operating expense', '雑費')) AS t(key, codes, label, label_ja)
  LOOP
    v_pl := v_pl || public.gl_stmt_line(e.key, 'sga', e.label, e.label_ja, 1,
              public.gl_stmt_pick(v_acc, e.codes, 'c'),
              CASE WHEN v_p_ok THEN public.gl_stmt_pick(v_acc, e.codes, 'p') END,
              CASE WHEN v_y_ok THEN public.gl_stmt_pick(v_acc, e.codes, 'y') END, v_pct, v_jpy);
  END LOOP;
  c := public.gl_stmt_kind_sum(v_acc, ARRAY['expense'], 'c', sga_codes);
  p := CASE WHEN v_p_ok THEN public.gl_stmt_kind_sum(v_acc, ARRAY['expense'], 'p', sga_codes) END;
  y := CASE WHEN v_y_ok THEN public.gl_stmt_kind_sum(v_acc, ARRAY['expense'], 'y', sga_codes) END;
  IF c <> 0 OR coalesce(p, 0) <> 0 OR coalesce(y, 0) <> 0 THEN
    v_pl := v_pl || public.gl_stmt_line('sga_misc', 'sga', 'Other expense accounts', 'その他販管費', 1, c, p, y, v_pct, v_jpy);
  END IF;
  cur_sga := public.gl_stmt_kind_sum(v_acc, ARRAY['expense'], 'c', ARRAY['6800', '6950']);
  p_sga := CASE WHEN v_p_ok THEN public.gl_stmt_kind_sum(v_acc, ARRAY['expense'], 'p', ARRAY['6800', '6950']) END;
  y_sga := CASE WHEN v_y_ok THEN public.gl_stmt_kind_sum(v_acc, ARRAY['expense'], 'y', ARRAY['6800', '6950']) END;
  v_pl := v_pl || public.gl_stmt_line('sga_total', 'sga', 'Selling, general and administrative', '販売費及び一般管理費', 0, cur_sga, p_sga, y_sga, v_pct, v_jpy);
  v_pl := v_pl || public.gl_stmt_line('operating_profit', 'sga', 'Operating profit', '営業利益', 0, cur_rev - cur_cogs - cur_sga, p_rev - p_cogs - p_sga, y_rev - y_cogs - y_sga, v_pct, v_jpy);

  FOR e IN SELECT * FROM (VALUES
      ('other_income', ARRAY['4900'], -1, 'Other income', '雑収入'),
      ('fx_gain', ARRAY['4950'], -1, 'Foreign-exchange gain', '為替差益'),
      ('fx_loss', ARRAY['6800'], 1, 'Foreign-exchange loss', '為替差損'),
      ('interest', ARRAY['6950'], 1, 'Interest paid', '支払利息')) AS t(key, codes, sign, label, label_ja)
  LOOP
    v_pl := v_pl || public.gl_stmt_line(e.key, 'nonop', e.label, e.label_ja, 1,
              e.sign * public.gl_stmt_pick(v_acc, e.codes, 'c'),
              CASE WHEN v_p_ok THEN e.sign * public.gl_stmt_pick(v_acc, e.codes, 'p') END,
              CASE WHEN v_y_ok THEN e.sign * public.gl_stmt_pick(v_acc, e.codes, 'y') END, v_pct, v_jpy);
  END LOOP;
  cur_nonop := -public.gl_stmt_pick(v_acc, ARRAY['4900', '4950', '6800', '6950'], 'c');
  p_nonop := CASE WHEN v_p_ok THEN -public.gl_stmt_pick(v_acc, ARRAY['4900', '4950', '6800', '6950'], 'p') END;
  y_nonop := CASE WHEN v_y_ok THEN -public.gl_stmt_pick(v_acc, ARRAY['4900', '4950', '6800', '6950'], 'y') END;
  v_pl := v_pl || public.gl_stmt_line('nonop_total', 'nonop', 'Non-operating income less expenses', '営業外収益−営業外費用', 0, cur_nonop, p_nonop, y_nonop, v_pct, v_jpy);
  v_net_profit := cur_rev - cur_cogs - cur_sga + cur_nonop;
  v_pl := v_pl || public.gl_stmt_line('ordinary_profit', 'nonop', 'Ordinary profit', '経常利益', 0, v_net_profit, p_rev - p_cogs - p_sga + p_nonop, y_rev - y_cogs - y_sga + y_nonop, v_pct, v_jpy);
  v_pl := v_pl || public.gl_stmt_line('net_profit', 'nonop', 'Net profit for the period', '当期純利益', 0, v_net_profit, p_rev - p_cogs - p_sga + p_nonop, y_rev - y_cogs - y_sga + y_nonop, v_pct, v_jpy);

  /* ---- balance sheet at p_to (and at the day before p_from) ---- */
  FOR e IN
    SELECT k.key AS code, k.value AS a FROM jsonb_each(v_acc) k
     WHERE (k.value->>'k') IN ('asset', 'liability', 'equity')
       AND ((k.value->>'b')::numeric <> 0 OR (k.value->>'pb')::numeric <> 0)
     ORDER BY (k.value->>'sort')::int, k.key
  LOOP
    v_bs := v_bs || jsonb_build_object(
      'key', e.code, 'code', e.code, 'label', e.a->>'name', 'label_ja', e.a->>'ja', 'kind', e.a->>'k', 'contra', (e.a->>'contra')::boolean,
      'section', CASE WHEN e.a->>'k' = 'asset' AND e.code < '1500' THEN 'current_assets'
                      WHEN e.a->>'k' = 'asset' THEN 'fixed_assets'
                      WHEN e.a->>'k' = 'liability' AND e.code < '2750' THEN 'current_liabilities'
                      WHEN e.a->>'k' = 'liability' THEN 'fixed_liabilities'
                      ELSE 'equity' END,
      'group', CASE WHEN e.a->>'k' = 'asset' AND e.code < '1130' THEN 'cash'
                    WHEN e.a->>'k' = 'asset' AND e.code < '1190' THEN 'clearing'
                    WHEN e.code IN ('1200', '1210') THEN 'receivables'
                    WHEN e.code IN ('1300', '1310') THEN 'inventory'
                    WHEN e.a->>'k' = 'asset' AND e.code < '1500' THEN 'other_current_assets'
                    WHEN e.a->>'k' = 'asset' THEN 'fixed_assets'
                    WHEN e.a->>'k' = 'liability' AND e.code < '2750' THEN 'current_liabilities'
                    WHEN e.a->>'k' = 'liability' THEN 'fixed_liabilities'
                    ELSE 'equity' END,
      'cur', CASE WHEN e.a->>'k' = 'asset' THEN (e.a->>'b')::numeric ELSE -(e.a->>'b')::numeric END,
      'prior', CASE WHEN e.a->>'k' = 'asset' THEN (e.a->>'pb')::numeric ELSE -(e.a->>'pb')::numeric END);
  END LOOP;
  v_pl_to_date := -public.gl_stmt_kind_sum(v_acc, ARRAY['revenue', 'cogs', 'expense'], 'b', ARRAY[]::text[]);
  v_pl_before_fy := -public.gl_stmt_kind_sum(v_acc, ARRAY['revenue', 'cogs', 'expense'], 'f0', ARRAY[]::text[]);
  v_pl_at_prev := -public.gl_stmt_kind_sum(v_acc, ARRAY['revenue', 'cogs', 'expense'], 'pb', ARRAY[]::text[]);
  v_pl_before_fy_prev_amt := -public.gl_stmt_kind_sum(v_acc, ARRAY['revenue', 'cogs', 'expense'], 'f0p', ARRAY[]::text[]);
  v_bs := v_bs || jsonb_build_object('key', 'retained_prior_years', 'code', NULL, 'label', 'Profit of earlier fiscal years (since the ledger start)', 'label_ja', '繰越利益剰余金（前期以前の当期純利益）',
            'kind', 'equity', 'contra', false, 'section', 'equity', 'group', 'equity', 'cur', v_pl_before_fy, 'prior', v_pl_before_fy_prev_amt);
  v_bs := v_bs || jsonb_build_object('key', 'current_fy_profit', 'code', NULL, 'label', 'Profit of the current fiscal year to date', 'label_ja', '当期純利益（期首から）',
            'kind', 'equity', 'contra', false, 'section', 'equity', 'group', 'equity', 'cur', v_pl_to_date - v_pl_before_fy, 'prior', v_pl_at_prev - v_pl_before_fy_prev_amt);
  v_assets := public.gl_stmt_kind_sum(v_acc, ARRAY['asset'], 'b', ARRAY[]::text[]);
  v_liab := -public.gl_stmt_kind_sum(v_acc, ARRAY['liability'], 'b', ARRAY[]::text[]);
  v_equity := -public.gl_stmt_kind_sum(v_acc, ARRAY['equity'], 'b', ARRAY[]::text[]) + v_pl_to_date;
  v_assets_prev := public.gl_stmt_kind_sum(v_acc, ARRAY['asset'], 'pb', ARRAY[]::text[]);
  v_liab_prev := -public.gl_stmt_kind_sum(v_acc, ARRAY['liability'], 'pb', ARRAY[]::text[]);
  v_equity_prev := -public.gl_stmt_kind_sum(v_acc, ARRAY['equity'], 'pb', ARRAY[]::text[]) + v_pl_at_prev;

  /* ---- cash flow (indirect): every non-cash balance-sheet movement explains the change in cash ---- */
  v_cash_open := 0; v_cash_close := 0;
  FOR e IN SELECT k.key AS code, k.value AS a FROM jsonb_each(v_acc) k WHERE (k.value->>'k') = 'asset' AND k.key < '1130'
  LOOP
    v_cash_open := v_cash_open + (e.a->>'pb')::numeric;
    v_cash_close := v_cash_close + (e.a->>'b')::numeric;
  END LOOP;
  v_cf := v_cf || jsonb_build_object('key', 'net_profit', 'section', 'operating', 'label', 'Net profit for the period', 'label_ja', '当期純利益', 'amount', round(v_net_profit));
  v_cf_sum := v_net_profit;
  FOR e IN SELECT * FROM (VALUES
      ('operating', 'd_receivables', ARRAY['1200', '1210', '1140'], 'Change in receivables (layaway, orders, COD)', '売掛金・未収入金の増減'),
      ('operating', 'd_clearing', ARRAY['1130', '1131', '1132'], 'Change in provider clearing (Square, Paidy, Stripe)', '決済代行未収入金の増減'),
      ('operating', 'd_suspense', ARRAY['1190', '1195'], 'Change in unidentified receipts and suspense payments', '不明入金・仮払金の増減'),
      ('operating', 'd_inventory', ARRAY['1300', '1310'], 'Change in inventory', '商品の増減'),
      ('operating', 'd_prepaid', ARRAY['1400'], 'Change in prepaid expenses', '前払費用の増減'),
      ('operating', 'd_payables', ARRAY['2100'], 'Change in accounts payable', '未払金の増減'),
      ('operating', 'd_deposits', ARRAY['2210'], 'Change in customer deposits', '前受金の増減'),
      ('operating', 'd_store_credit', ARRAY['2300'], 'Change in store credit liability', 'ストアクレジットの増減'),
      ('operating', 'd_accrued_pay', ARRAY['2400', '2410'], 'Change in accrued payroll and commission', '未払給与・未払手数料の増減'),
      ('operating', 'd_tax_refunds', ARRAY['2500', '2600'], 'Change in consumption-tax memo and refunds payable', '仮受消費税・未払金（返金）の増減'),
      ('operating', 'd_other_liab', ARRAY['2800', '2900'], 'Change in deposits received and suspense receipts', '預り金・仮受金の増減'),
      ('investing', 'd_equipment', ARRAY['1500'], 'Equipment bought (−) / disposed (+)', '工具器具備品の取得・処分'),
      ('financing', 'd_loans', ARRAY['2700', '2750'], 'Loans drawn (+) / repaid (−)', '借入金の増減'),
      ('financing', 'd_capital', ARRAY['3000', '3100'], 'Capital and retained-earnings entries', '資本金・利益剰余金の増減'),
      ('financing', 'd_draws', ARRAY['3900'], 'Owner draws', '役員貸付金の増減')) AS t(section, key, codes, label, label_ja)
  LOOP
    c := -(public.gl_stmt_pick(v_acc, e.codes, 'b') - public.gl_stmt_pick(v_acc, e.codes, 'pb'));
    v_cf := v_cf || jsonb_build_object('key', e.key, 'section', e.section, 'label', e.label, 'label_ja', e.label_ja, 'amount', round(c));
    v_cf_sum := v_cf_sum + c;
  END LOOP;
  c := 0;
  FOR e IN SELECT k.key AS code, k.value AS a FROM jsonb_each(v_acc) k
            WHERE (k.value->>'k') IN ('asset', 'liability', 'equity')
              AND NOT ((k.value->>'k') = 'asset' AND k.key < '1130')
              AND NOT (k.key = ANY (ARRAY['1130', '1131', '1132', '1140', '1190', '1195', '1200', '1210', '1300', '1310', '1400', '1500',
                                          '2100', '2210', '2300', '2400', '2410', '2500', '2600', '2700', '2750', '2800', '2900', '3000', '3100', '3900']))
  LOOP
    c := c - ((e.a->>'b')::numeric - (e.a->>'pb')::numeric);
  END LOOP;
  IF c <> 0 THEN
    v_cf := v_cf || jsonb_build_object('key', 'd_other_accounts', 'section', 'operating', 'label', 'Change in other accounts added later', 'label_ja', 'その他の増減', 'amount', round(c));
    v_cf_sum := v_cf_sum + c;
  END IF;
  v_cash_fx := 0;
  FOR e IN SELECT k.key AS code, k.value AS a FROM jsonb_each(v_acc) k WHERE (k.value->>'k') = 'asset' AND k.key < '1130'
  LOOP
    v_cash_fx := v_cash_fx + (e.a->>'fxc')::numeric;
  END LOOP;

  /* ---- D3 checks: plans / orders whose currency disagrees with the customer's country ---- */
  SELECT count(*), coalesce(jsonb_agg(x ORDER BY x->>'order_date' DESC) FILTER (WHERE rn <= 50), '[]'::jsonb)
    INTO v_check_count, v_checks
    FROM (
      SELECT row_number() OVER (ORDER BY t.order_date DESC) AS rn,
             jsonb_build_object('kind', t.kind, 'id', t.id, 'invoice_number', t.invoice_number, 'order_date', t.order_date, 'currency', t.currency, 'country', t.country, 'amount', t.total_amount) AS x
        FROM (
          SELECT 'layaway' AS kind, la.id, la.invoice_number, la.order_date, la.currency::text AS currency, cu.country, la.total_amount
            FROM public.layaway_accounts la JOIN public.customers cu ON cu.id = la.customer_id
           WHERE la.is_test = false AND la.order_date BETWEEN p_from AND p_to
             AND ((la.currency = 'PHP' AND cu.country ILIKE 'japan') OR (la.currency = 'JPY' AND cu.country ILIKE 'philippines'))
          UNION ALL
          SELECT 'cash_order', co.id, co.invoice_number, co.order_date, co.currency::text, cu.country, co.total_amount
            FROM public.cash_orders co JOIN public.customers cu ON cu.id = co.customer_id
           WHERE co.is_test = false AND co.order_date BETWEEN p_from AND p_to
             AND ((co.currency = 'PHP' AND cu.country ILIKE 'japan') OR (co.currency = 'JPY' AND cu.country ILIKE 'philippines'))) t) s;

  RETURN jsonb_build_object(
    'from', p_from, 'to', p_to, 'ledger_start', v_start, 'today', v_today,
    'fiscal_year_start_month', v_fy_month, 'fiscal_year_start', v_fy_start,
    'journal_count', (SELECT count(*) FROM public.gl_journals j WHERE j.entry_date BETWEEN p_from AND p_to),
    'rate', public.gl_rate(),
    'flags', jsonb_build_object('pct', v_pct, 'jpy', v_jpy),
    'comparisons', jsonb_build_object(
      'prior', jsonb_build_object('from', v_pf, 'to', v_pt, 'available', v_p_ok),
      'prior_year', jsonb_build_object('from', v_yf, 'to', v_yt, 'available', v_y_ok)),
    'income_statement', jsonb_build_object('lines', v_pl,
      'gross_margin_pct', CASE WHEN cur_rev = 0 THEN NULL ELSE round((cur_rev - cur_cogs) / cur_rev * 100, 1) END,
      'operating_margin_pct', CASE WHEN cur_rev = 0 THEN NULL ELSE round((cur_rev - cur_cogs - cur_sga) / cur_rev * 100, 1) END),
    'balance_sheet', jsonb_build_object('as_of', p_to, 'prior_as_of', v_prev, 'lines', v_bs,
      'totals', jsonb_build_object('assets', round(v_assets), 'liabilities', round(v_liab), 'equity', round(v_equity), 'check', round(v_assets - v_liab - v_equity),
                                   'prior_assets', round(v_assets_prev), 'prior_liabilities', round(v_liab_prev), 'prior_equity', round(v_equity_prev),
                                   'prior_check', round(v_assets_prev - v_liab_prev - v_equity_prev))),
    'cash_flow', jsonb_build_object('lines', v_cf, 'net_change', round(v_cf_sum),
      'cash_open', round(v_cash_open), 'cash_close', round(v_cash_close), 'actual_change', round(v_cash_close - v_cash_open),
      'difference', round(v_cf_sum - (v_cash_close - v_cash_open)), 'unrealised_fx_on_cash', round(v_cash_fx)),
    'ageing', public.get_receivable_ageing(p_to),
    'currency_checks', jsonb_build_object('count', v_check_count, 'rows', v_checks),
    'outside_hub', jsonb_build_array(
      jsonb_build_object('label', 'Officer compensation', 'label_ja', '役員報酬'),
      jsonb_build_object('label', 'Statutory welfare (social insurance employer share)', 'label_ja', '法定福利費')));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_statements(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_statements(date, date) TO authenticated;
COMMENT ON FUNCTION public.get_statements(date, date) IS
  'Phase 7: income statement (試算表 layout; domestic / export sub-lines by sale currency; prior period and prior year columns, Δ and flags), balance sheet at `to` and the day before `from`, indirect cash flow tied to the actual change in cash & deposits, receivable ageing, currency-vs-country checks and the booked-outside-the-Hub note. Derived read-only from the ledger. view_ledger.';

-- ---------------------------------------------------------------------------
-- 5. Journal export (flat lines for the 税理士 CSV).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_journal_export(p_from date, p_to date, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_total bigint;
  v_rows jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'view_ledger') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RETURN jsonb_build_object('error', 'invalid_range'); END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN RETURN jsonb_build_object('error', 'invalid_offset'); END IF;
  SELECT count(*) INTO v_total
    FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id
   WHERE j.entry_date BETWEEN p_from AND p_to;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'entry_date', j.entry_date, 'journal_no', j.journal_no, 'line_no', l.line_no, 'kind', j.kind, 'status', j.status,
           'source_type', j.source_type, 'source_date', j.source_date, 'description', j.description,
           'account_code', l.account_code, 'account_name', a.name, 'account_name_ja', a.name_ja,
           'debit_jpy', l.debit_jpy, 'credit_jpy', l.credit_jpy,
           'native_amount', CASE WHEN l.debit > 0 THEN l.debit ELSE l.credit END, 'currency', l.currency, 'rate', l.fx_php_per_jpy,
           'memo', l.memo,
           'tax_flag', CASE WHEN l.account_code IN ('4100', '4150', '4500') THEN CASE WHEN l.currency = 'PHP' THEN 'export' ELSE 'domestic' END ELSE '' END,
           'reversed', j.status = 'reversed' OR j.kind = 'reversal') ORDER BY j.journal_no, l.line_no), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT l.* FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id
           WHERE j.entry_date BETWEEN p_from AND p_to
           ORDER BY j.journal_no, l.line_no OFFSET p_offset LIMIT 20000) l
    JOIN public.gl_journals j ON j.id = l.journal_id
    JOIN public.gl_accounts a ON a.code = l.account_code;
  RETURN jsonb_build_object('from', p_from, 'to', p_to, 'offset', p_offset, 'total_rows', v_total,
                            'returned', jsonb_array_length(v_rows), 'truncated', p_offset + jsonb_array_length(v_rows) < v_total, 'rows', v_rows);
END
$fn$;
REVOKE ALL ON FUNCTION public.get_journal_export(date, date, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_journal_export(date, date, integer) TO authenticated;
COMMENT ON FUNCTION public.get_journal_export(date, date, integer) IS
  'Phase 7: every journal line in the range as a flat row (date, journal no., kind, source, account code / name / 勘定科目, Dr / Cr yen, native amount, currency, rate, memo, domestic / export tax flag on sales lines, reversed) for the 税理士 CSV; 20,000 rows per call, paged by offset. view_ledger.';
