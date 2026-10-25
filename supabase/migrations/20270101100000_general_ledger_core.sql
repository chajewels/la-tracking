-- Finance -> Ledger, Expenses Phase 2b: the general ledger core (owner decisions 2026-10-25,
-- plan claude/expenses-phase2b-ledger-plan-2026-10-25.md, decisions D1-D6 confirmed 21:15 JST).
--
--   * Double-entry journals DERIVED from the Hub's own money events. Nothing in the existing
--     payment / plan / order / store-credit code is changed: gl_post_pending() scans the source
--     tables, builds the "current events" (gl_current_events), and keeps exactly one live
--     journal per (source_type, source_id). A source row that changes (edited amount, void,
--     forfeiture, reactivation) gets a REVERSAL journal and, when it still qualifies, a new one.
--     This covers every write path (RPCs, direct table UPDATEs allowed by RLS, edge functions)
--     and is also the completeness check and the backfill engine.
--   * Books: Cha Jewels Japan only, in yen (owner D2). Every line keeps its native amount and
--     currency and records the ONE PESO RATE used; *_jpy = amount (JPY) or round(amount / rate).
--     ONE Sales account (4100); no JP/PH split, no tax flag.
--   * Sale recognition (owner D1): a layaway plan or cash order is a sale on the day of its first
--     non-void payment (full price -> receivable 1200 / 1210; unpaid part stays receivable).
--     Forfeiture / cancellation reverses the uncollected remainder (4150) and reclassifies the
--     money kept as forfeiture income (4500). Reactivation reverses that again.
--   * Payment methods are free text in payments / cash_payments / expenses: gl_payment_method_map
--     maps each spelling (lower, trimmed) to a bank / cash / clearing / COD / non-cash account.
--     Unknown spellings post to 1190 Unidentified receipts and are listed for the admin to map.
--   * Fiscal year May-April (owner F1): system_settings.fiscal_year_start_month = 5. Periods are
--     calendar months; close_period / reopen_period (admin). An event dated inside a CLOSED
--     period is posted on the first day of the first open period after it, with the original
--     date kept in source_date (owner D6).
--   * ledger_start_date (system_settings) gates everything: while NULL nothing posts (owner F6 -
--     opening balances come from the accountant). Opening balances = a manual journal of kind
--     'opening' dated on the start date.
--   * Journals and lines are immutable: no UPDATE/DELETE/TRUNCATE (triggers + revoked grants);
--     a journal can only move posted -> reversed by its reversal. Automatic journals need no
--     approval (they mirror confirmed source events, owner F3); manual journals need post_journal.
--   * Permission keys: view_ledger, post_journal, close_period. Admin = true; staff, finance,
--     csr, live_agent = false. Nightly pg_cron job gl-post-pending at 15:40 UTC (00:40 JST),
--     after the penalty engine (00:05) and auto-forfeit (00:10).
--
--   New objects + one nullable column on expense_categories. Re-runnable. No comment lines
--   inside any function body (Lovable strips them).

SET lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Chart of accounts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gl_accounts (
  code           text PRIMARY KEY CHECK (code ~ '^[1-6][0-9]{3}$'),
  name           text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  kind           text NOT NULL CHECK (kind IN ('asset', 'liability', 'equity', 'revenue', 'cogs', 'expense')),
  contra         boolean NOT NULL DEFAULT false,
  currency_hint  text NULL CHECK (currency_hint IS NULL OR currency_hint IN ('JPY', 'PHP')),
  active         boolean NOT NULL DEFAULT true,
  sort_order     integer NOT NULL DEFAULT 0,
  system_key     text NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.gl_accounts ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.gl_accounts IS
  'Chart of accounts (Finance -> Ledger, owner 2026-10-25). 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx revenue (contra = sales reversals / discounts), 5xxx cost of sales, 6xxx operating expenses. Seed-only plus upsert_gl_account; never deleted, only deactivated.';

INSERT INTO public.gl_accounts (code, name, kind, contra, currency_hint, sort_order, system_key) VALUES
  ('1010', 'Cash on hand - Japan',                     'asset', false, 'JPY', 10, 'cash_jpy'),
  ('1020', 'Cash on hand - Philippines',               'asset', false, 'PHP', 20, 'cash_php'),
  ('1101', 'SMBC (Sumitomo Mitsui)',                   'asset', false, 'JPY', 30, NULL),
  ('1102', 'Rakuten Bank',                             'asset', false, 'JPY', 40, NULL),
  ('1103', 'Japan Post Bank',                          'asset', false, 'JPY', 50, NULL),
  ('1111', 'BDO',                                      'asset', false, 'PHP', 60, NULL),
  ('1112', 'BPI',                                      'asset', false, 'PHP', 70, NULL),
  ('1113', 'Metrobank',                                'asset', false, 'PHP', 80, NULL),
  ('1121', 'GCash',                                    'asset', false, 'PHP', 90, NULL),
  ('1122', 'PayPay',                                   'asset', false, 'JPY', 100, NULL),
  ('1130', 'Square clearing',                          'asset', false, 'JPY', 110, 'square_clearing'),
  ('1131', 'Paidy clearing',                           'asset', false, 'JPY', 120, 'paidy_clearing'),
  ('1132', 'Stripe clearing',                          'asset', false, 'JPY', 130, 'stripe_clearing'),
  ('1140', 'COD receivable (carrier)',                 'asset', false, 'JPY', 140, 'cod'),
  ('1190', 'Unidentified receipts',                    'asset', false, NULL,  150, 'suspense'),
  ('1200', 'Layaway receivable',                       'asset', false, NULL,  160, 'layaway_receivable'),
  ('1210', 'Cash order receivable',                    'asset', false, NULL,  170, 'order_receivable'),
  ('1300', 'Inventory - pieces',                       'asset', false, 'JPY', 180, NULL),
  ('1310', 'Inventory - trade-ins',                    'asset', false, 'JPY', 190, NULL),
  ('1400', 'Prepaid expenses',                         'asset', false, 'JPY', 200, NULL),
  ('1500', 'Equipment',                                'asset', false, 'JPY', 210, NULL),
  ('2100', 'Accounts payable',                         'liability', false, NULL, 300, NULL),
  ('2210', 'Customer deposits - unconfirmed web orders','liability', false, 'JPY', 310, NULL),
  ('2300', 'Store credit liability',                   'liability', false, NULL, 320, 'store_credit'),
  ('2400', 'Accrued payroll',                          'liability', false, 'PHP', 330, NULL),
  ('2410', 'Accrued commission',                       'liability', false, 'PHP', 340, NULL),
  ('2500', 'Consumption tax payable (memo)',           'liability', false, 'JPY', 350, NULL),
  ('2600', 'Refunds payable',                          'liability', false, NULL, 360, NULL),
  ('3000', 'Share capital',                            'equity', false, 'JPY', 400, NULL),
  ('3100', 'Retained earnings',                        'equity', false, 'JPY', 410, 'retained_earnings'),
  ('3900', 'Owner draws',                              'equity', true,  'JPY', 420, NULL),
  ('4100', 'Sales',                                    'revenue', false, NULL, 500, 'sales'),
  ('4150', 'Sales reversals (forfeited / cancelled / refunded)', 'revenue', true, NULL, 510, 'sales_reversal'),
  ('4160', 'Loyalty points redeemed',                  'revenue', true,  NULL, 520, 'loyalty_redeemed'),
  ('4170', 'Customer credits granted',                 'revenue', true,  NULL, 530, 'credits_granted'),
  ('4200', 'Service income',                           'revenue', false, NULL, 540, NULL),
  ('4300', 'Shipping and COD fees charged',            'revenue', false, NULL, 550, 'shipping_charged'),
  ('4400', 'Penalty income',                           'revenue', false, NULL, 560, 'penalty_income'),
  ('4500', 'Forfeiture income',                        'revenue', false, NULL, 570, 'forfeiture_income'),
  ('4900', 'Other income',                             'revenue', false, NULL, 580, 'other_income'),
  ('4950', 'Foreign-exchange gain',                    'revenue', false, 'JPY', 590, NULL),
  ('5100', 'Cost of pieces sold',                      'cogs', false, 'JPY', 600, NULL),
  ('5200', 'Goldsmith and repair vendors',             'cogs', false, NULL,  610, NULL),
  ('5250', 'Appraisal and certification',              'cogs', false, NULL,  615, NULL),
  ('5300', 'Packaging and certificates',               'cogs', false, NULL,  620, NULL),
  ('5400', 'Carrier cost',                             'cogs', false, NULL,  630, NULL),
  ('5500', 'Trade-in buyback cost',                    'cogs', false, 'JPY', 640, NULL),
  ('5900', 'Inventory write-down',                     'cogs', false, 'JPY', 650, NULL),
  ('5950', 'Receivable write-off',                     'cogs', false, NULL,  660, NULL),
  ('6110', 'Staff payroll',                            'expense', false, 'PHP', 700, 'payroll'),
  ('6120', 'Sales commission',                         'expense', false, 'PHP', 710, 'commission'),
  ('6130', 'Bonuses',                                  'expense', false, 'PHP', 720, 'bonus'),
  ('6200', 'Marketing',                                'expense', false, NULL,  730, NULL),
  ('6300', 'Payment and bank fees',                    'expense', false, NULL,  740, NULL),
  ('6400', 'Shipping insurance and customs',           'expense', false, NULL,  750, NULL),
  ('6500', 'Tech and subscriptions',                   'expense', false, NULL,  760, NULL),
  ('6600', 'Office',                                   'expense', false, 'JPY', 770, NULL),
  ('6700', 'Professional and government',              'expense', false, 'JPY', 780, NULL),
  ('6800', 'Foreign-exchange loss',                    'expense', false, 'JPY', 790, NULL),
  ('6900', 'Other operating expense',                  'expense', false, NULL,  800, 'other_expense')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Payment-method spellings -> accounts (owner D3). Lookup = lower(btrim(method)).
--    'cash' depends on the row currency (JPY -> 1010, PHP -> 1020): kind 'cash'.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gl_payment_method_map (
  spelling      text PRIMARY KEY CHECK (spelling = lower(btrim(spelling)) AND length(spelling) BETWEEN 1 AND 60),
  account_code  text NOT NULL REFERENCES public.gl_accounts(code),
  kind          text NOT NULL CHECK (kind IN ('bank', 'cash', 'clearing', 'cod', 'non_cash', 'suspense')),
  note          text NULL,
  updated_by    uuid NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.gl_payment_method_map ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.gl_payment_method_map IS
  'Maps every spelling found in payments / cash_payments / expenses payment_method to a ledger account. kind cash picks 1010 (JPY row) or 1020 (PHP row). Unknown spellings post to 1190 until mapped (set_payment_method_map).';

INSERT INTO public.gl_payment_method_map (spelling, account_code, kind, note) VALUES
  ('cash',               '1010', 'cash',     'JPY row -> 1010, PHP row -> 1020'),
  ('cash payment',       '1010', 'cash',     'JPY row -> 1010, PHP row -> 1020'),
  ('cash_pickup',        '1020', 'cash',     'Cash pickup in the Philippines'),
  ('genkin_kaketome',    '1010', 'cash',     'Cash by registered mail'),
  ('rakuten',            '1102', 'bank',     NULL),
  ('rakuten bank',       '1102', 'bank',     NULL),
  ('sumitomo',           '1101', 'bank',     NULL),
  ('sumitomo bank',      '1101', 'bank',     NULL),
  ('jp_bank',            '1103', 'bank',     'Japan Post Bank'),
  ('paypay',             '1122', 'bank',     NULL),
  ('bdo',                '1111', 'bank',     NULL),
  ('bpi',                '1112', 'bank',     NULL),
  ('metrobank',          '1113', 'bank',     NULL),
  ('gcash',              '1121', 'bank',     NULL),
  ('square',             '1130', 'clearing', NULL),
  ('credit_card',        '1130', 'clearing', 'Card payments settle through Square'),
  ('paidy',              '1131', 'clearing', NULL),
  ('stripe',             '1132', 'clearing', NULL),
  ('konbini',            '1132', 'clearing', 'Stripe konbini'),
  ('cod',                '1140', 'cod',      'Carrier collects; remits later'),
  ('cash on delivery',   '1140', 'cod',      'Carrier collects; remits later'),
  ('loyalty_redemption', '4160', 'non_cash', 'Points used as payment = sales discount'),
  ('store_credit',       '2300', 'non_cash', 'Store credit used as payment'),
  ('card',               '1190', 'suspense', 'Expense paid by card - set Paid from on the expense'),
  ('auto_debit',         '1190', 'suspense', 'Expense auto-debit - set Paid from on the expense'),
  ('transfer',           '1190', 'suspense', 'Website order bank transfer - bank not named'),
  ('bank transfer',      '1190', 'suspense', 'Bank not named - map when known'),
  ('bank_transfer',      '1190', 'suspense', 'Bank not named - map when known'),
  ('other',              '1190', 'suspense', NULL)
ON CONFLICT (spelling) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Expense category -> account.
-- ---------------------------------------------------------------------------
ALTER TABLE public.expense_categories
  ADD COLUMN IF NOT EXISTS gl_account_code text NULL REFERENCES public.gl_accounts(code);
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS paid_from text NULL REFERENCES public.gl_accounts(code);
COMMENT ON COLUMN public.expenses.paid_from IS
  'Ledger account the expense was paid from (bank / cash / clearing, 1xxx). Set with set_expense_paid_from; NULL posts to 1190 Unidentified receipts (cash methods fall back to 1010 / 1020 by currency).';
UPDATE public.expense_categories c SET gl_account_code = m.code
  FROM (VALUES
    ('people',        'Staff payroll (CSR and Live Admin)',                     '6110'),
    ('people',        'Sales commission',                                       '6120'),
    ('people',        'Bonuses',                                                '6130'),
    ('cost_of_goods', 'Inventory purchases (supplier, gold, preloved buys)',    '5100'),
    ('cost_of_goods', 'Trade-in buybacks',                                      '5500'),
    ('cost_of_goods', 'Goldsmith and repair vendors (service jobs)',            '5200'),
    ('cost_of_goods', 'Appraisal and gem certification',                        '5250'),
    ('cost_of_goods', 'Packaging, boxes and certificates',                      '5300'),
    ('marketing',     'Meta and Google ads',                                    '6200'),
    ('marketing',     'Live-selling equipment and props',                       '6200'),
    ('marketing',     'Giveaways and influencers',                              '6200'),
    ('payment_fees',  'Square fees',                                            '6300'),
    ('payment_fees',  'Paidy fees',                                             '6300'),
    ('payment_fees',  'Stripe konbini fees',                                    '6300'),
    ('payment_fees',  'Bank transfer and Japan to Philippines remittance fees', '6300'),
    ('payment_fees',  'Refund fees',                                            '6300'),
    ('payment_fees',  'Foreign-exchange loss',                                  '6800'),
    ('shipping',      'Carrier cost (Japan Post, LBC, DHL)',                    '5400'),
    ('shipping',      'Shipping insurance',                                     '6400'),
    ('shipping',      'Customs and duties',                                     '6400'),
    ('tech',          'Lovable, Firebase, Vercel, Claude and other dev tools',  '6500'),
    ('tech',          'Page365, Pancake, Metricool, Google Workspace',          '6500'),
    ('tech',          'Email sending and domains',                              '6500'),
    ('tech',          'Photoroom',                                              '6500'),
    ('office',        'Rent, utilities, internet and phone',                    '6600'),
    ('professional',  'Tax accountant and legal fees',                          '6700'),
    ('professional',  'Corporate tax and consumption tax payments',             '6700'),
    ('professional',  'Bank charges',                                           '6300')
  ) AS m(group_key, name, code)
 WHERE c.group_key = m.group_key AND c.name = m.name AND c.gl_account_code IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Settings, periods, posting runs.
-- ---------------------------------------------------------------------------
INSERT INTO public.system_settings (key, value)
VALUES ('fiscal_year_start_month', '"5"'::jsonb)
ON CONFLICT (key) DO NOTHING;
INSERT INTO public.system_settings (key, value)
VALUES ('ledger_start_date', 'null'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.gl_periods (
  period_start  date PRIMARY KEY CHECK (period_start = date_trunc('month', period_start)::date),
  fiscal_year   integer NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at     timestamptz NULL,
  closed_by     uuid NULL,
  note          text NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.gl_periods ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.gl_periods IS
  'Ledger periods = calendar months; fiscal_year = the year the May-April fiscal year ENDS (May 2026-Apr 2027 = 2027). Closed periods refuse new postings: late events move to the first open period (gl_journals.source_date keeps the original date).';

CREATE TABLE IF NOT EXISTS public.gl_posting_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz NULL,
  trigger       text NOT NULL CHECK (trigger IN ('cron', 'manual', 'migration')),
  run_by        uuid NULL,
  posted        integer NOT NULL DEFAULT 0,
  reversed      integer NOT NULL DEFAULT 0,
  moved         integer NOT NULL DEFAULT 0,
  skipped       integer NOT NULL DEFAULT 0,
  failed        integer NOT NULL DEFAULT 0,
  note          text NULL
);
ALTER TABLE public.gl_posting_runs ADD COLUMN IF NOT EXISTS failed integer NOT NULL DEFAULT 0;
ALTER TABLE public.gl_posting_runs ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 5. Journals and lines (immutable).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gl_journals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_no      bigint GENERATED ALWAYS AS IDENTITY,
  entry_date      date NOT NULL,
  period_start    date NOT NULL REFERENCES public.gl_periods(period_start),
  source_date     date NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('auto', 'manual', 'opening', 'reversal')),
  source_type     text NOT NULL,
  source_id       uuid NULL,
  source_version  text NULL,
  description     text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  status          text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  reverses        uuid NULL REFERENCES public.gl_journals(id),
  reversed_by     uuid NULL REFERENCES public.gl_journals(id),
  reason          text NULL,
  posted_by       uuid NULL,
  posted_at       timestamptz NOT NULL DEFAULT now(),
  total_jpy       numeric(15,0) NOT NULL DEFAULT 0,
  CONSTRAINT gl_journals_auto_source CHECK (kind IN ('manual', 'opening') OR source_id IS NOT NULL OR kind = 'reversal'),
  CONSTRAINT gl_journals_reversal_target CHECK (kind <> 'reversal' OR reverses IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS gl_journals_live_source_uq
  ON public.gl_journals (source_type, source_id) WHERE kind = 'auto' AND status = 'posted';
CREATE INDEX IF NOT EXISTS gl_journals_entry_date_idx ON public.gl_journals (entry_date DESC, journal_no DESC);
CREATE INDEX IF NOT EXISTS gl_journals_period_idx ON public.gl_journals (period_start);
CREATE INDEX IF NOT EXISTS gl_journals_source_idx ON public.gl_journals (source_type, source_id);
ALTER TABLE public.gl_journals ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.gl_journals IS
  'General ledger journals (Finance -> Ledger). kind auto = derived by gl_post_pending from a Hub event (one live journal per source_type+source_id, source_version = fingerprint of the event); reversal = undoes one journal (status posted -> reversed on the target); manual / opening = post_manual_journal. Immutable: never updated or deleted.';

CREATE TABLE IF NOT EXISTS public.gl_journal_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id     uuid NOT NULL REFERENCES public.gl_journals(id),
  line_no        integer NOT NULL CHECK (line_no BETWEEN 1 AND 200),
  account_code   text NOT NULL REFERENCES public.gl_accounts(code),
  debit          numeric(15,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit         numeric(15,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  currency       text NOT NULL CHECK (currency IN ('JPY', 'PHP')),
  fx_php_per_jpy numeric(12,6) NULL CHECK (fx_php_per_jpy IS NULL OR fx_php_per_jpy > 0),
  debit_jpy      numeric(15,0) NOT NULL DEFAULT 0 CHECK (debit_jpy >= 0),
  credit_jpy     numeric(15,0) NOT NULL DEFAULT 0 CHECK (credit_jpy >= 0),
  memo           text NULL CHECK (memo IS NULL OR length(memo) <= 300),
  customer_id    uuid NULL,
  account_id     uuid NULL,
  cash_order_id  uuid NULL,
  expense_id     uuid NULL,
  CONSTRAINT gl_lines_one_side CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)),
  CONSTRAINT gl_lines_jpy_side CHECK ((debit > 0 AND credit_jpy = 0) OR (credit > 0 AND debit_jpy = 0)),
  UNIQUE (journal_id, line_no)
);
CREATE INDEX IF NOT EXISTS gl_journal_lines_account_idx ON public.gl_journal_lines (account_code, journal_id);
CREATE INDEX IF NOT EXISTS gl_journal_lines_plan_idx ON public.gl_journal_lines (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gl_journal_lines_order_idx ON public.gl_journal_lines (cash_order_id) WHERE cash_order_id IS NOT NULL;
ALTER TABLE public.gl_journal_lines ENABLE ROW LEVEL SECURITY;

-- Read policies (view_ledger). No write policies anywhere: writes only through the functions.
DO $p$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['gl_accounts', 'gl_payment_method_map', 'gl_periods', 'gl_posting_runs', 'gl_journals', 'gl_journal_lines'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_read ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_read ON public.%I FOR SELECT TO authenticated USING ((SELECT public.has_permission((SELECT auth.uid()), ''view_ledger'')))', t, t);
  END LOOP;
END
$p$;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.gl_accounts, public.gl_payment_method_map, public.gl_periods,
  public.gl_posting_runs, public.gl_journals, public.gl_journal_lines FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.gl_accounts, public.gl_payment_method_map, public.gl_periods,
  public.gl_posting_runs, public.gl_journals, public.gl_journal_lines FROM anon;
GRANT SELECT ON public.gl_accounts, public.gl_payment_method_map, public.gl_periods,
  public.gl_posting_runs, public.gl_journals, public.gl_journal_lines TO authenticated;
GRANT ALL ON public.gl_accounts, public.gl_payment_method_map, public.gl_periods,
  public.gl_posting_runs, public.gl_journals, public.gl_journal_lines TO service_role;

-- Immutability guards (run for every writer, including the owner).
CREATE OR REPLACE FUNCTION public.gl_refuse_change()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger rows are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'gl_journals' THEN
    IF OLD.status = 'posted' AND NEW.status = 'reversed' AND NEW.reversed_by IS NOT NULL
       AND to_jsonb(NEW) - 'status' - 'reversed_by' = to_jsonb(OLD) - 'status' - 'reversed_by' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'journals are immutable (only posted -> reversed by a reversal)' USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'journal lines are immutable' USING ERRCODE = 'check_violation';
END
$fn$;
DROP TRIGGER IF EXISTS gl_journals_guard ON public.gl_journals;
CREATE TRIGGER gl_journals_guard BEFORE UPDATE OR DELETE ON public.gl_journals
  FOR EACH ROW EXECUTE FUNCTION public.gl_refuse_change();
DROP TRIGGER IF EXISTS gl_journal_lines_guard ON public.gl_journal_lines;
CREATE TRIGGER gl_journal_lines_guard BEFORE UPDATE OR DELETE ON public.gl_journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.gl_refuse_change();

CREATE OR REPLACE FUNCTION public.gl_refuse_truncate()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  RAISE EXCEPTION 'ledger tables are never truncated' USING ERRCODE = 'check_violation';
END
$fn$;
DROP TRIGGER IF EXISTS gl_journals_no_truncate ON public.gl_journals;
CREATE TRIGGER gl_journals_no_truncate BEFORE TRUNCATE ON public.gl_journals
  FOR EACH STATEMENT EXECUTE FUNCTION public.gl_refuse_truncate();
DROP TRIGGER IF EXISTS gl_journal_lines_no_truncate ON public.gl_journal_lines;
CREATE TRIGGER gl_journal_lines_no_truncate BEFORE TRUNCATE ON public.gl_journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.gl_refuse_truncate();

-- Balance check at commit: every journal has >= 2 lines and debits = credits in yen.
CREATE OR REPLACE FUNCTION public.gl_journal_balanced()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_lines integer;
  v_dr numeric;
  v_cr numeric;
BEGIN
  SELECT count(*), coalesce(sum(debit_jpy), 0), coalesce(sum(credit_jpy), 0)
    INTO v_lines, v_dr, v_cr
    FROM public.gl_journal_lines WHERE journal_id = NEW.id;
  IF v_lines < 2 OR v_dr <> v_cr OR v_dr <= 0 THEN
    RAISE EXCEPTION 'journal % is not balanced (lines %, debit %, credit %)', NEW.journal_no, v_lines, v_dr, v_cr
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$fn$;
DROP TRIGGER IF EXISTS gl_journals_balanced ON public.gl_journals;
CREATE CONSTRAINT TRIGGER gl_journals_balanced AFTER INSERT ON public.gl_journals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.gl_journal_balanced();

-- ---------------------------------------------------------------------------
-- 6. Helpers: rate, yen, fiscal year, periods, method lookup.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gl_rate()
RETURNS numeric
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  SELECT (value #>> '{}')::numeric FROM public.system_settings WHERE key = 'php_jpy_rate'
$fn$;

CREATE OR REPLACE FUNCTION public.gl_to_jpy(p_amount numeric, p_currency text, p_rate numeric)
RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT CASE WHEN p_currency = 'JPY' THEN round(p_amount, 0)
              WHEN p_rate IS NULL OR p_rate <= 0 THEN NULL
              ELSE round(p_amount / p_rate, 0) END
$fn$;

CREATE OR REPLACE FUNCTION public.gl_fiscal_year(p_date date)
RETURNS integer
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  SELECT CASE WHEN coalesce((SELECT (value #>> '{}')::int FROM public.system_settings WHERE key = 'fiscal_year_start_month'), 5) <= 1
              THEN extract(year FROM p_date)::int
              WHEN extract(month FROM p_date)::int >= coalesce((SELECT (value #>> '{}')::int FROM public.system_settings WHERE key = 'fiscal_year_start_month'), 5)
              THEN extract(year FROM p_date)::int + 1
              ELSE extract(year FROM p_date)::int END
$fn$;

CREATE OR REPLACE FUNCTION public.gl_ledger_start()
RETURNS date
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  SELECT CASE WHEN value = 'null'::jsonb THEN NULL ELSE (value #>> '{}')::date END
    FROM public.system_settings WHERE key = 'ledger_start_date'
$fn$;

CREATE OR REPLACE FUNCTION public.gl_period_for(p_date date)
RETURNS date
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_start date := date_trunc('month', p_date)::date;
BEGIN
  INSERT INTO public.gl_periods (period_start, fiscal_year)
  VALUES (v_start, public.gl_fiscal_year(v_start))
  ON CONFLICT (period_start) DO NOTHING;
  RETURN v_start;
END
$fn$;

CREATE OR REPLACE FUNCTION public.gl_posting_date(p_source_date date)
RETURNS date
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_period date := date_trunc('month', p_source_date)::date;
  v_last_closed date;
BEGIN
  SELECT max(period_start) INTO v_last_closed FROM public.gl_periods WHERE status = 'closed';
  IF v_last_closed IS NULL OR v_period > v_last_closed THEN
    RETURN p_source_date;
  END IF;
  RETURN (v_last_closed + interval '1 month')::date;
END
$fn$;

CREATE OR REPLACE FUNCTION public.gl_method_account(p_method text, p_currency text)
RETURNS text
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  SELECT coalesce(
    (SELECT CASE WHEN m.kind = 'cash' AND p_currency = 'PHP' THEN '1020'
                 WHEN m.kind = 'cash' AND p_currency = 'JPY' AND m.account_code = '1020' THEN '1020'
                 WHEN m.kind = 'cash' THEN m.account_code
                 ELSE m.account_code END
       FROM public.gl_payment_method_map m WHERE m.spelling = lower(btrim(coalesce(p_method, '')))),
    '1190')
$fn$;

-- ---------------------------------------------------------------------------
-- 7. Current events: what the ledger should contain right now, one row per Hub
--    money event, with its lines as jsonb [{a, side, amt, cur, memo}]. The
--    posting engine diffs this against the live auto journals.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gl_current_events(p_until date)
RETURNS TABLE (source_type text, source_id uuid, source_date date, description text, lines jsonb,
               customer_id uuid, account_id uuid, cash_order_id uuid, expense_id uuid)
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  WITH s AS (SELECT public.gl_ledger_start() AS start_date),
  first_pay AS (
    SELECT p.account_id, min(p.date_paid) AS first_date
      FROM public.payments p WHERE p.voided_at IS NULL GROUP BY p.account_id),
  first_cash_pay AS (
    SELECT cp.cash_order_id, min(cp.date_paid) AS first_date
      FROM public.cash_payments cp WHERE cp.voided_at IS NULL GROUP BY cp.cash_order_id),
  pen AS (
    SELECT pa.payment_id, sum(pa.allocated_amount) AS penalty
      FROM public.payment_allocations pa WHERE pa.allocation_type = 'penalty' GROUP BY pa.payment_id),
  credit_from_plan AS (
    SELECT l.source_account_id AS account_id, sum(l.original_amount) AS credit
      FROM public.store_credit_lots l WHERE l.status <> 'voided' AND l.source_account_id IS NOT NULL GROUP BY 1),
  credit_from_order AS (
    SELECT l.source_cash_order_id AS cash_order_id, sum(l.original_amount) AS credit
      FROM public.store_credit_lots l WHERE l.status <> 'voided' AND l.source_cash_order_id IS NOT NULL GROUP BY 1)

  SELECT 'layaway_sale', la.id, fp.first_date,
         'Layaway sale ' || la.invoice_number,
         jsonb_build_array(
           jsonb_build_object('a', '1200', 'side', 'dr', 'amt', la.total_amount, 'cur', la.currency::text, 'memo', la.invoice_number),
           jsonb_build_object('a', '4100', 'side', 'cr', 'amt', la.total_amount - coalesce(la.shipping_fee, 0), 'cur', la.currency::text, 'memo', la.invoice_number))
         || CASE WHEN coalesce(la.shipping_fee, 0) > 0
                 THEN jsonb_build_array(jsonb_build_object('a', '4300', 'side', 'cr', 'amt', la.shipping_fee, 'cur', la.currency::text, 'memo', 'Shipping'))
                 ELSE '[]'::jsonb END,
         la.customer_id, la.id, NULL::uuid, NULL::uuid
    FROM public.layaway_accounts la
    JOIN first_pay fp ON fp.account_id = la.id
    CROSS JOIN s
   WHERE la.is_test = false AND la.total_amount > 0
     AND fp.first_date >= s.start_date AND fp.first_date <= p_until

  UNION ALL
  SELECT 'layaway_close', la.id,
         coalesce((coalesce(la.forfeited_at, la.cancelled_at) AT TIME ZONE 'Asia/Tokyo')::date, (la.updated_at AT TIME ZONE 'Asia/Tokyo')::date),
         CASE WHEN la.status = 'cancelled' THEN 'Layaway cancelled ' ELSE 'Layaway forfeited ' END || la.invoice_number,
         CASE WHEN la.remaining_balance > 0 THEN jsonb_build_array(
                jsonb_build_object('a', '4150', 'side', 'dr', 'amt', la.remaining_balance, 'cur', la.currency::text, 'memo', 'Uncollected remainder'),
                jsonb_build_object('a', '1200', 'side', 'cr', 'amt', la.remaining_balance, 'cur', la.currency::text, 'memo', la.invoice_number))
              ELSE '[]'::jsonb END
         || CASE WHEN la.total_amount - la.remaining_balance - coalesce(cfp.credit, 0) > 0 THEN jsonb_build_array(
                jsonb_build_object('a', '4100', 'side', 'dr', 'amt', la.total_amount - la.remaining_balance - coalesce(cfp.credit, 0), 'cur', la.currency::text, 'memo', 'Money kept reclassified'),
                jsonb_build_object('a', '4500', 'side', 'cr', 'amt', la.total_amount - la.remaining_balance - coalesce(cfp.credit, 0), 'cur', la.currency::text, 'memo', la.invoice_number))
              ELSE '[]'::jsonb END,
         la.customer_id, la.id, NULL::uuid, NULL::uuid
    FROM public.layaway_accounts la
    JOIN first_pay fp ON fp.account_id = la.id
    LEFT JOIN credit_from_plan cfp ON cfp.account_id = la.id
    CROSS JOIN s
   WHERE la.is_test = false
     AND la.status IN ('forfeited', 'final_forfeited', 'cancelled')
     AND coalesce((coalesce(la.forfeited_at, la.cancelled_at) AT TIME ZONE 'Asia/Tokyo')::date, (la.updated_at AT TIME ZONE 'Asia/Tokyo')::date) BETWEEN s.start_date AND p_until
     AND (la.remaining_balance > 0 OR la.total_amount - la.remaining_balance - coalesce(cfp.credit, 0) > 0)

  UNION ALL
  SELECT 'payment', p.id, p.date_paid,
         'Payment ' || la.invoice_number || coalesce(' (' || p.payment_method || ')', ''),
         jsonb_build_array(
           jsonb_build_object('a', public.gl_method_account(p.payment_method, p.currency::text), 'side', 'dr', 'amt', p.amount_paid, 'cur', p.currency::text, 'memo', coalesce(p.reference_number, p.payment_method)))
         || CASE WHEN least(coalesce(pen.penalty, 0), p.amount_paid) > 0
                 THEN jsonb_build_array(jsonb_build_object('a', '4400', 'side', 'cr', 'amt', least(pen.penalty, p.amount_paid), 'cur', p.currency::text, 'memo', 'Penalty'))
                 ELSE '[]'::jsonb END
         || CASE WHEN p.amount_paid - least(coalesce(pen.penalty, 0), p.amount_paid) > 0
                 THEN jsonb_build_array(jsonb_build_object('a', '1200', 'side', 'cr', 'amt', p.amount_paid - least(coalesce(pen.penalty, 0), p.amount_paid), 'cur', p.currency::text, 'memo', la.invoice_number))
                 ELSE '[]'::jsonb END,
         la.customer_id, la.id, NULL::uuid, NULL::uuid
    FROM public.payments p
    JOIN public.layaway_accounts la ON la.id = p.account_id
    LEFT JOIN pen ON pen.payment_id = p.id
    CROSS JOIN s
   WHERE p.voided_at IS NULL AND la.is_test = false AND p.amount_paid > 0
     AND p.date_paid >= s.start_date AND p.date_paid <= p_until

  UNION ALL
  SELECT 'cash_order_sale', co.id, fcp.first_date,
         'Cash order ' || co.invoice_number,
         jsonb_build_array(
           jsonb_build_object('a', '1210', 'side', 'dr', 'amt', co.total_amount, 'cur', co.currency::text, 'memo', co.invoice_number),
           jsonb_build_object('a', '4100', 'side', 'cr', 'amt', co.total_amount - coalesce(co.shipping_fee, 0) - coalesce(co.cod_fee, 0), 'cur', co.currency::text, 'memo', co.invoice_number))
         || CASE WHEN coalesce(co.shipping_fee, 0) + coalesce(co.cod_fee, 0) > 0
                 THEN jsonb_build_array(jsonb_build_object('a', '4300', 'side', 'cr', 'amt', coalesce(co.shipping_fee, 0) + coalesce(co.cod_fee, 0), 'cur', co.currency::text, 'memo', 'Shipping / COD fee'))
                 ELSE '[]'::jsonb END,
         co.customer_id, NULL::uuid, co.id, NULL::uuid
    FROM public.cash_orders co
    JOIN first_cash_pay fcp ON fcp.cash_order_id = co.id
    CROSS JOIN s
   WHERE co.is_test = false AND co.total_amount > 0
     AND fcp.first_date >= s.start_date AND fcp.first_date <= p_until

  UNION ALL
  SELECT 'cash_order_close', co.id,
         coalesce((coalesce(co.cancelled_at, co.expired_at) AT TIME ZONE 'Asia/Tokyo')::date, (co.updated_at AT TIME ZONE 'Asia/Tokyo')::date),
         CASE WHEN co.status = 'cancelled' THEN 'Cash order cancelled ' ELSE 'Cash order expired ' END || co.invoice_number,
         CASE WHEN co.remaining_balance > 0 THEN jsonb_build_array(
                jsonb_build_object('a', '4150', 'side', 'dr', 'amt', co.remaining_balance, 'cur', co.currency::text, 'memo', 'Uncollected remainder'),
                jsonb_build_object('a', '1210', 'side', 'cr', 'amt', co.remaining_balance, 'cur', co.currency::text, 'memo', co.invoice_number))
              ELSE '[]'::jsonb END
         || CASE WHEN co.total_amount - co.remaining_balance - coalesce(cfo.credit, 0) > 0 THEN jsonb_build_array(
                jsonb_build_object('a', '4100', 'side', 'dr', 'amt', co.total_amount - co.remaining_balance - coalesce(cfo.credit, 0), 'cur', co.currency::text, 'memo', 'Money kept reclassified'),
                jsonb_build_object('a', '4500', 'side', 'cr', 'amt', co.total_amount - co.remaining_balance - coalesce(cfo.credit, 0), 'cur', co.currency::text, 'memo', co.invoice_number))
              ELSE '[]'::jsonb END,
         co.customer_id, NULL::uuid, co.id, NULL::uuid
    FROM public.cash_orders co
    JOIN first_cash_pay fcp ON fcp.cash_order_id = co.id
    LEFT JOIN credit_from_order cfo ON cfo.cash_order_id = co.id
    CROSS JOIN s
   WHERE co.is_test = false AND co.status IN ('cancelled', 'expired')
     AND coalesce((coalesce(co.cancelled_at, co.expired_at) AT TIME ZONE 'Asia/Tokyo')::date, (co.updated_at AT TIME ZONE 'Asia/Tokyo')::date) BETWEEN s.start_date AND p_until
     AND (co.remaining_balance > 0 OR co.total_amount - co.remaining_balance - coalesce(cfo.credit, 0) > 0)

  UNION ALL
  SELECT 'cash_payment', cp.id, cp.date_paid,
         'Cash order payment ' || co.invoice_number || coalesce(' (' || cp.payment_method || ')', ''),
         jsonb_build_array(
           jsonb_build_object('a', public.gl_method_account(cp.payment_method, cp.currency::text), 'side', 'dr', 'amt', cp.amount_paid, 'cur', cp.currency::text, 'memo', coalesce(cp.reference_number, cp.payment_method)),
           jsonb_build_object('a', '1210', 'side', 'cr', 'amt', cp.amount_paid, 'cur', cp.currency::text, 'memo', co.invoice_number)),
         co.customer_id, NULL::uuid, co.id, NULL::uuid
    FROM public.cash_payments cp
    JOIN public.cash_orders co ON co.id = cp.cash_order_id
    CROSS JOIN s
   WHERE cp.voided_at IS NULL AND co.is_test = false AND cp.amount_paid > 0
     AND cp.date_paid >= s.start_date AND cp.date_paid <= p_until

  UNION ALL
  SELECT 'store_credit_issue', l.id, (l.issued_at AT TIME ZONE 'Asia/Tokyo')::date,
         'Store credit issued (' || l.source_type || ')',
         jsonb_build_array(
           jsonb_build_object('a', CASE WHEN l.source_type LIKE 'cancelled%' OR l.source_type LIKE 'forfeit%' OR l.source_type LIKE 'refund%' THEN '4150' ELSE '4170' END,
                              'side', 'dr', 'amt', l.original_amount, 'cur', l.currency::text, 'memo', coalesce(l.notes, l.source_type)),
           jsonb_build_object('a', '2300', 'side', 'cr', 'amt', l.original_amount, 'cur', l.currency::text, 'memo', 'Store credit')),
         l.customer_id, l.source_account_id, l.source_cash_order_id, NULL::uuid
    FROM public.store_credit_lots l
    CROSS JOIN s
   WHERE l.status <> 'voided' AND l.original_amount > 0
     AND (l.issued_at AT TIME ZONE 'Asia/Tokyo')::date >= s.start_date
     AND (l.issued_at AT TIME ZONE 'Asia/Tokyo')::date <= p_until

  UNION ALL
  SELECT 'store_credit_use', t.id, (t.created_at AT TIME ZONE 'Asia/Tokyo')::date,
         CASE t.txn_type::text WHEN 'redeemed' THEN 'Store credit redeemed' ELSE 'Store credit expired' END,
         jsonb_build_array(
           jsonb_build_object('a', '2300', 'side', 'dr', 'amt', abs(t.amount), 'cur', t.currency::text, 'memo', coalesce(t.notes, t.txn_type::text)),
           jsonb_build_object('a', CASE WHEN t.txn_type::text = 'expired' THEN '4900'
                                        WHEN t.account_id IS NOT NULL THEN '1200'
                                        WHEN t.cash_order_id IS NOT NULL THEN '1210'
                                        ELSE '4100' END,
                              'side', 'cr', 'amt', abs(t.amount), 'cur', t.currency::text,
                              'memo', CASE WHEN t.txn_type::text = 'expired' THEN 'Expired credit'
                                           WHEN t.account_id IS NULL AND t.cash_order_id IS NULL THEN 'Redeemed outside the Hub'
                                           ELSE 'Applied to balance' END)),
         t.customer_id, t.account_id, t.cash_order_id, NULL::uuid
    FROM public.store_credit_transactions t
    CROSS JOIN s
   WHERE t.amount <> 0
     AND (t.txn_type::text = 'expired'
          OR (t.txn_type::text = 'redeemed' AND t.account_id IS NULL AND t.cash_order_id IS NULL))
     AND (t.created_at AT TIME ZONE 'Asia/Tokyo')::date >= s.start_date
     AND (t.created_at AT TIME ZONE 'Asia/Tokyo')::date <= p_until

  UNION ALL
  SELECT 'expense', e.id, e.expense_date,
         'Expense: ' || e.description,
         jsonb_build_array(
           jsonb_build_object('a', coalesce(c.gl_account_code, '6900'), 'side', 'dr', 'amt', e.amount, 'cur', e.currency, 'memo', c.name),
           jsonb_build_object('a', coalesce(e.paid_from, public.gl_method_account(e.payment_method, e.currency)), 'side', 'cr', 'amt', e.amount, 'cur', e.currency, 'memo', e.payment_method)),
         NULL::uuid, NULL::uuid, NULL::uuid, e.id
    FROM public.expenses e
    JOIN public.expense_categories c ON c.id = e.category_id
    CROSS JOIN s
   WHERE e.status = 'approved' AND e.amount > 0
     AND e.expense_date >= s.start_date AND e.expense_date <= p_until

  UNION ALL
  SELECT 'square_refund', r.id, (coalesce(r.provider_created_at, r.created_at) AT TIME ZONE 'Asia/Tokyo')::date,
         'Square refund ' || coalesce(co.invoice_number, r.square_refund_id),
         jsonb_build_array(
           jsonb_build_object('a', '4150', 'side', 'dr', 'amt', r.amount_jpy, 'cur', 'JPY', 'memo', coalesce(r.reason, 'Refund')),
           jsonb_build_object('a', '1130', 'side', 'cr', 'amt', r.amount_jpy, 'cur', 'JPY', 'memo', r.square_refund_id)),
         co.customer_id, NULL::uuid, r.cash_order_id, NULL::uuid
    FROM public.square_refunds r
    LEFT JOIN public.square_payments sp ON sp.id = r.square_payment_row
    LEFT JOIN public.cash_orders co ON co.id = r.cash_order_id
    CROSS JOIN s
   WHERE r.status = 'COMPLETED' AND r.amount_jpy > 0
     AND coalesce(sp.environment, 'production') = 'production' AND coalesce(sp.test, false) = false
     AND coalesce(co.is_test, false) = false
     AND (coalesce(r.provider_created_at, r.created_at) AT TIME ZONE 'Asia/Tokyo')::date >= s.start_date
     AND (coalesce(r.provider_created_at, r.created_at) AT TIME ZONE 'Asia/Tokyo')::date <= p_until

  UNION ALL
  SELECT 'paidy_refund', r.id, (coalesce(r.refunded_at, r.created_at) AT TIME ZONE 'Asia/Tokyo')::date,
         'Paidy refund ' || coalesce(co.invoice_number, r.refund_id),
         jsonb_build_array(
           jsonb_build_object('a', '4150', 'side', 'dr', 'amt', r.amount_jpy, 'cur', 'JPY', 'memo', 'Refund'),
           jsonb_build_object('a', '1131', 'side', 'cr', 'amt', r.amount_jpy, 'cur', 'JPY', 'memo', r.refund_id)),
         co.customer_id, NULL::uuid, r.cash_order_id, NULL::uuid
    FROM public.paidy_refunds r
    LEFT JOIN public.paidy_payments pp ON pp.id = r.paidy_payment_row
    LEFT JOIN public.cash_orders co ON co.id = r.cash_order_id
    CROSS JOIN s
   WHERE r.amount_jpy > 0 AND coalesce(pp.test, false) = false AND coalesce(co.is_test, false) = false
     AND (coalesce(r.refunded_at, r.created_at) AT TIME ZONE 'Asia/Tokyo')::date >= s.start_date
     AND (coalesce(r.refunded_at, r.created_at) AT TIME ZONE 'Asia/Tokyo')::date <= p_until

  UNION ALL
  SELECT 'web_refund', co.id, (co.refund_decided_at AT TIME ZONE 'Asia/Tokyo')::date,
         'Refund issued ' || co.invoice_number,
         jsonb_build_array(
           jsonb_build_object('a', '4150', 'side', 'dr', 'amt', co.total_paid, 'cur', co.currency::text, 'memo', coalesce(co.refund_note, 'Refund issued')),
           jsonb_build_object('a', public.gl_method_account(co.payment_method, co.currency::text), 'side', 'cr', 'amt', co.total_paid, 'cur', co.currency::text, 'memo', coalesce(co.payment_method, 'method not recorded'))),
         co.customer_id, NULL::uuid, co.id, NULL::uuid
    FROM public.cash_orders co
    CROSS JOIN s
   WHERE co.is_test = false AND co.refund_status = 'refund_issued' AND co.refund_decided_at IS NOT NULL AND co.total_paid > 0
     AND (co.refund_decided_at AT TIME ZONE 'Asia/Tokyo')::date >= s.start_date
     AND (co.refund_decided_at AT TIME ZONE 'Asia/Tokyo')::date <= p_until
     AND NOT EXISTS (SELECT 1 FROM public.square_refunds sr WHERE sr.cash_order_id = co.id AND sr.status = 'COMPLETED')
     AND NOT EXISTS (SELECT 1 FROM public.paidy_refunds pr WHERE pr.cash_order_id = co.id)
$fn$;
REVOKE ALL ON FUNCTION public.gl_current_events(date) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.gl_current_events(date) IS
  'Internal: every Hub money event the ledger should hold up to p_until (from ledger_start_date), with its lines as jsonb. gl_post_pending diffs this against the live auto journals.';

-- ---------------------------------------------------------------------------
-- 8. Writing one journal (internal).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gl_write_journal(
  p_kind text, p_source_type text, p_source_id uuid, p_source_version text, p_source_date date,
  p_description text, p_lines jsonb, p_posted_by uuid, p_reverses uuid, p_reason text,
  p_customer_id uuid, p_account_id uuid, p_cash_order_id uuid, p_expense_id uuid)
RETURNS uuid
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_id uuid := gen_random_uuid();
  v_rate numeric := public.gl_rate();
  v_entry date := public.gl_posting_date(p_source_date);
  v_period date := public.gl_period_for(v_entry);
  v_lines jsonb;
  v_line jsonb;
  v_n integer := 0;
  v_dr numeric;
  v_cr numeric;
  v_diff numeric;
  v_last integer;
BEGIN
  SELECT jsonb_agg(l || jsonb_build_object('amt', round((l->>'amt')::numeric, 2),
                                           'jpy', coalesce((l->>'jpy')::numeric, public.gl_to_jpy(round((l->>'amt')::numeric, 2), l->>'cur', v_rate))))
    INTO v_lines
    FROM jsonb_array_elements(p_lines) l;
  IF v_lines IS NULL OR jsonb_array_length(v_lines) < 2 THEN
    RAISE EXCEPTION 'journal needs at least two lines' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) l WHERE l->>'jpy' IS NULL) THEN
    RAISE EXCEPTION 'rate_not_set' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(CASE WHEN l->>'side' = 'dr' THEN (l->>'jpy')::numeric ELSE 0 END), 0),
         coalesce(sum(CASE WHEN l->>'side' = 'cr' THEN (l->>'jpy')::numeric ELSE 0 END), 0)
    INTO v_dr, v_cr
    FROM jsonb_array_elements(v_lines) l;
  v_diff := v_dr - v_cr;
  IF v_diff <> 0 AND abs(v_diff) <= jsonb_array_length(v_lines) THEN
    SELECT i INTO v_last FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS x(l, i)
     WHERE x.l->>'side' = 'cr' ORDER BY (x.l->>'jpy')::numeric DESC, i LIMIT 1;
    IF ((v_lines->(v_last - 1))->>'jpy')::numeric + v_diff >= 0 THEN
      v_lines := jsonb_set(v_lines, ARRAY[(v_last - 1)::text, 'jpy'],
                           to_jsonb(((v_lines->(v_last - 1))->>'jpy')::numeric + v_diff));
      v_cr := v_cr + v_diff;
    END IF;
  END IF;
  IF v_dr <= 0 OR v_dr <> v_cr THEN
    RAISE EXCEPTION 'journal not balanced in yen (debit %, credit %)', v_dr, v_cr USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.gl_journals (id, entry_date, period_start, source_date, kind, source_type, source_id, source_version,
                                  description, reverses, reason, posted_by, total_jpy)
  VALUES (v_id, v_entry, v_period, p_source_date, p_kind, p_source_type, p_source_id, p_source_version,
          left(p_description, 500), p_reverses, p_reason, p_posted_by, v_dr);
  FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines) LOOP
    v_n := v_n + 1;
    INSERT INTO public.gl_journal_lines (journal_id, line_no, account_code, debit, credit, currency, fx_php_per_jpy,
                                         debit_jpy, credit_jpy, memo, customer_id, account_id, cash_order_id, expense_id)
    VALUES (v_id, v_n, v_line->>'a',
            CASE WHEN v_line->>'side' = 'dr' THEN (v_line->>'amt')::numeric ELSE 0 END,
            CASE WHEN v_line->>'side' = 'cr' THEN (v_line->>'amt')::numeric ELSE 0 END,
            v_line->>'cur',
            CASE WHEN v_line->>'cur' = 'PHP' THEN v_rate ELSE NULL END,
            CASE WHEN v_line->>'side' = 'dr' THEN (v_line->>'jpy')::numeric ELSE 0 END,
            CASE WHEN v_line->>'side' = 'cr' THEN (v_line->>'jpy')::numeric ELSE 0 END,
            left(v_line->>'memo', 300), p_customer_id, p_account_id, p_cash_order_id, p_expense_id);
  END LOOP;
  RETURN v_id;
END
$fn$;
REVOKE ALL ON FUNCTION public.gl_write_journal(text, text, uuid, text, date, text, jsonb, uuid, uuid, text, uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. Posting engine: diff the current events against the live auto journals.
--    p_dry = true only counts. Called by pg_cron (no caller) and by gl_post_now().
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gl_post_pending(p_dry boolean DEFAULT false, p_trigger text DEFAULT 'cron', p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_start date := public.gl_ledger_start();
  v_today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_run uuid;
  v_posted integer := 0;
  v_reversed integer := 0;
  v_moved integer := 0;
  v_skipped integer := 0;
  r record;
  v_version text;
  v_rev_lines jsonb;
  v_cust uuid;
  v_acc uuid;
  v_co uuid;
  v_exp uuid;
  v_no bigint;
  v_new uuid;
  v_failed integer := 0;
  v_note text := '';
  v_rev uuid;
BEGIN
  IF v_start IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'started', false, 'reason', 'ledger_start_not_set',
                              'posted', 0, 'reversed', 0, 'moved', 0, 'skipped', 0, 'pending', 0);
  END IF;
  IF public.gl_rate() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_not_set');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('gl_post_pending'));
  IF to_regclass('pg_temp.gl_events_tmp') IS NOT NULL THEN DROP TABLE gl_events_tmp; END IF;
  CREATE TEMP TABLE gl_events_tmp ON COMMIT DROP AS
    SELECT e.*,
           md5(CASE WHEN e.source_type IN ('layaway_close', 'cash_order_close') THEN '' ELSE e.source_date::text END || '|' ||
               (SELECT coalesce(string_agg((l->>'a') || ':' || (l->>'side') || ':' || (l->>'amt') || ':' || (l->>'cur'), ';' ORDER BY o), '')
                  FROM jsonb_array_elements(e.lines) WITH ORDINALITY AS x(l, o))) AS version
      FROM public.gl_current_events(v_today) e;
  IF NOT p_dry THEN
    INSERT INTO public.gl_posting_runs (trigger, run_by) VALUES (p_trigger, p_user_id) RETURNING id INTO v_run;
  END IF;

  FOR r IN SELECT j.id, j.source_type, j.source_id, j.source_version, j.description
             FROM public.gl_journals j
            WHERE j.kind = 'auto' AND j.status = 'posted'
              AND NOT EXISTS (SELECT 1 FROM gl_events_tmp t
                               WHERE t.source_type = j.source_type AND t.source_id = j.source_id AND t.version = j.source_version)
  LOOP
    IF p_dry THEN
      v_reversed := v_reversed + 1;
      CONTINUE;
    END IF;
    BEGIN
      SELECT jsonb_agg(jsonb_build_object('a', l.account_code, 'side', CASE WHEN l.debit > 0 THEN 'cr' ELSE 'dr' END,
                                          'amt', CASE WHEN l.debit > 0 THEN l.debit ELSE l.credit END, 'cur', l.currency, 'memo', l.memo,
                                          'jpy', CASE WHEN l.debit > 0 THEN l.debit_jpy ELSE l.credit_jpy END)
                       ORDER BY l.line_no),
             max(l.customer_id::text)::uuid, max(l.account_id::text)::uuid, max(l.cash_order_id::text)::uuid, max(l.expense_id::text)::uuid
        INTO v_rev_lines, v_cust, v_acc, v_co, v_exp
        FROM public.gl_journal_lines l WHERE l.journal_id = r.id;
      SELECT journal_no INTO v_no FROM public.gl_journals WHERE id = r.id;
      v_rev := public.gl_write_journal('reversal', r.source_type, r.source_id, NULL, v_today,
                 'Reversal of #' || v_no || ': ' || r.description, v_rev_lines, p_user_id, r.id,
                 'Source changed or no longer qualifies', v_cust, v_acc, v_co, v_exp);
      UPDATE public.gl_journals SET status = 'reversed', reversed_by = v_rev WHERE id = r.id;
      v_reversed := v_reversed + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_note := left(v_note || 'reversal ' || r.source_type || ' ' || r.source_id || ': ' || SQLERRM || E'\n', 4000);
    END;
  END LOOP;

  FOR r IN SELECT t.* FROM gl_events_tmp t
            WHERE NOT EXISTS (SELECT 1 FROM public.gl_journals j
                               WHERE j.kind = 'auto' AND j.status = 'posted'
                                 AND j.source_type = t.source_type AND j.source_id = t.source_id AND j.source_version = t.version)
            ORDER BY t.source_date, t.source_type, t.source_id
  LOOP
    IF jsonb_array_length(r.lines) < 2 THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    IF p_dry THEN
      v_posted := v_posted + 1;
      IF public.gl_posting_date(r.source_date) <> r.source_date THEN v_moved := v_moved + 1; END IF;
      CONTINUE;
    END IF;
    BEGIN
      v_new := public.gl_write_journal('auto', r.source_type, r.source_id, r.version, r.source_date, r.description, r.lines,
                                       NULL, NULL, NULL, r.customer_id, r.account_id, r.cash_order_id, r.expense_id);
      v_posted := v_posted + 1;
      IF public.gl_posting_date(r.source_date) <> r.source_date THEN v_moved := v_moved + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      v_note := left(v_note || 'post ' || r.source_type || ' ' || r.source_id || ': ' || SQLERRM || E'\n', 4000);
    END;
  END LOOP;

  IF NOT p_dry THEN
    UPDATE public.gl_posting_runs SET finished_at = now(), posted = v_posted, reversed = v_reversed, moved = v_moved,
           skipped = v_skipped, failed = v_failed, note = nullif(v_note, '')
     WHERE id = v_run;
  END IF;
  RETURN jsonb_build_object('ok', true, 'started', true, 'dry', p_dry, 'posted', v_posted, 'reversed', v_reversed,
                            'moved', v_moved, 'skipped', v_skipped, 'failed', v_failed, 'pending', v_posted + v_reversed);
END
$fn$;
REVOKE ALL ON FUNCTION public.gl_post_pending(boolean, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gl_post_pending(boolean, text, uuid) TO service_role;
COMMENT ON FUNCTION public.gl_post_pending(boolean, text, uuid) IS
  'Internal posting engine (pg_cron nightly, gl_post_now on demand). Reverses live auto journals whose source event changed or vanished, then posts one journal per current event without one. Nothing posts while ledger_start_date is NULL.';

-- ---------------------------------------------------------------------------
-- 10. Client RPCs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gl_post_now()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'post_journal') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  RETURN public.gl_post_pending(false, 'manual', v_uid);
END
$fn$;
REVOKE ALL ON FUNCTION public.gl_post_now() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gl_post_now() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_ledger_status(p_check_pending boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_start date := public.gl_ledger_start();
  v_pending jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'view_ledger') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  v_pending := CASE WHEN v_start IS NULL OR NOT p_check_pending THEN NULL
                    ELSE public.gl_post_pending(true, 'manual', v_uid) END;
  RETURN jsonb_build_object(
    'ledger_start_date', v_start,
    'fiscal_year_start_month', coalesce((SELECT (value #>> '{}')::int FROM public.system_settings WHERE key = 'fiscal_year_start_month'), 5),
    'php_jpy_rate', public.gl_rate(),
    'can_post', public.has_permission(v_uid, 'post_journal'),
    'can_close', public.has_permission(v_uid, 'close_period'),
    'can_admin', public.has_permission(v_uid, 'admin_settings'),
    'pending', v_pending,
    'last_run', (SELECT to_jsonb(r) FROM public.gl_posting_runs r ORDER BY r.started_at DESC LIMIT 1),
    'journal_count', (SELECT count(*) FROM public.gl_journals),
    'moved_count', (SELECT count(*) FROM public.gl_journals WHERE entry_date <> source_date AND status = 'posted'),
    'unmapped_methods', coalesce((
      SELECT jsonb_agg(jsonb_build_object('spelling', x.m, 'rows', x.n, 'first_seen', x.d) ORDER BY x.n DESC)
        FROM (
          SELECT lower(btrim(m)) AS m, count(*) AS n, min(d) AS d FROM (
            SELECT p.payment_method AS m, p.date_paid AS d FROM public.payments p WHERE p.voided_at IS NULL AND (v_start IS NULL OR p.date_paid >= v_start)
            UNION ALL
            SELECT cp.payment_method, cp.date_paid FROM public.cash_payments cp WHERE cp.voided_at IS NULL AND (v_start IS NULL OR cp.date_paid >= v_start)
            UNION ALL
            SELECT co.payment_method, (co.refund_decided_at AT TIME ZONE 'Asia/Tokyo')::date FROM public.cash_orders co
             WHERE co.refund_status = 'refund_issued' AND co.refund_decided_at IS NOT NULL
               AND (v_start IS NULL OR (co.refund_decided_at AT TIME ZONE 'Asia/Tokyo')::date >= v_start)
          ) u
          WHERE lower(btrim(coalesce(m, ''))) <> ''
            AND NOT EXISTS (SELECT 1 FROM public.gl_payment_method_map mm WHERE mm.spelling = lower(btrim(u.m)) AND mm.kind <> 'suspense')
          GROUP BY 1) x), '[]'::jsonb),
    'expenses_without_paid_from', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', e.id, 'expense_date', e.expense_date, 'description', e.description, 'amount', e.amount,
                                          'currency', e.currency, 'payment_method', e.payment_method, 'source', e.source) ORDER BY e.expense_date DESC)
        FROM public.expenses e
       WHERE e.status = 'approved' AND e.paid_from IS NULL
         AND NOT EXISTS (SELECT 1 FROM public.gl_payment_method_map mm WHERE mm.spelling = lower(btrim(e.payment_method)) AND mm.kind = 'cash')
         AND (v_start IS NULL OR e.expense_date >= v_start)), '[]'::jsonb),
    'periods', coalesce((
      SELECT jsonb_agg(to_jsonb(p) ORDER BY p.period_start DESC) FROM public.gl_periods p), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_ledger_status(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ledger_status(boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_chart_of_accounts(p_as_of date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'view_ledger') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  RETURN jsonb_build_object(
    'as_of', coalesce(p_as_of, (now() AT TIME ZONE 'Asia/Tokyo')::date),
    'accounts', coalesce((
      SELECT jsonb_agg(to_jsonb(a) || jsonb_build_object(
               'debit_jpy', coalesce(b.dr, 0), 'credit_jpy', coalesce(b.cr, 0),
               'balance_jpy', CASE WHEN a.kind IN ('asset', 'cogs', 'expense') THEN coalesce(b.dr, 0) - coalesce(b.cr, 0)
                                   ELSE coalesce(b.cr, 0) - coalesce(b.dr, 0) END)
             ORDER BY a.code)
        FROM public.gl_accounts a
        LEFT JOIN (
          SELECT l.account_code, sum(l.debit_jpy) AS dr, sum(l.credit_jpy) AS cr
            FROM public.gl_journal_lines l
            JOIN public.gl_journals j ON j.id = l.journal_id
           WHERE p_as_of IS NULL OR j.entry_date <= p_as_of
           GROUP BY l.account_code) b ON b.account_code = a.code), '[]'::jsonb),
    'method_map', coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.spelling) FROM public.gl_payment_method_map m), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_chart_of_accounts(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_chart_of_accounts(date) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_ledger(p_from date, p_to date, p_account text DEFAULT NULL, p_source_type text DEFAULT NULL,
                                             p_kind text DEFAULT NULL, p_search text DEFAULT NULL,
                                             p_limit integer DEFAULT 200, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(replace(replace(replace(lower(btrim(coalesce(p_search, ''))), '\', '\\'), '%', '\%'), '_', '\_'), '');
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'view_ledger') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RETURN jsonb_build_object('error', 'invalid_range'); END IF;
  RETURN (
    WITH j AS (
      SELECT j.*
        FROM public.gl_journals j
       WHERE j.entry_date BETWEEN p_from AND p_to
         AND (p_source_type IS NULL OR j.source_type = p_source_type)
         AND (p_kind IS NULL OR j.kind = p_kind)
         AND (p_account IS NULL OR EXISTS (SELECT 1 FROM public.gl_journal_lines l WHERE l.journal_id = j.id AND l.account_code = p_account))
         AND (v_search IS NULL OR lower(j.description) LIKE '%' || v_search || '%' OR j.journal_no::text = v_search
              OR EXISTS (SELECT 1 FROM public.gl_journal_lines l WHERE l.journal_id = j.id AND lower(coalesce(l.memo, '')) LIKE '%' || v_search || '%')))
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM j),
      'sum_jpy', (SELECT coalesce(sum(total_jpy), 0) FROM j WHERE status = 'posted' AND kind <> 'reversal'),
      'journals', coalesce((
        SELECT jsonb_agg(to_jsonb(x) || jsonb_build_object('lines', (
                 SELECT jsonb_agg(to_jsonb(l) || jsonb_build_object('account_name', a.name) ORDER BY l.line_no)
                   FROM public.gl_journal_lines l JOIN public.gl_accounts a ON a.code = l.account_code
                  WHERE l.journal_id = x.id)) ORDER BY x.entry_date DESC, x.journal_no DESC)
          FROM (SELECT * FROM j ORDER BY entry_date DESC, journal_no DESC LIMIT v_limit OFFSET v_offset) x), '[]'::jsonb)));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_ledger(date, date, text, text, text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ledger(date, date, text, text, text, text, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_trial_balance(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'view_ledger') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RETURN jsonb_build_object('error', 'invalid_range'); END IF;
  RETURN jsonb_build_object(
    'from', p_from, 'to', p_to,
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'code', a.code, 'name', a.name, 'kind', a.kind, 'contra', a.contra,
               'opening_jpy', coalesce(o.bal, 0), 'debit_jpy', coalesce(m.dr, 0), 'credit_jpy', coalesce(m.cr, 0),
               'closing_jpy', coalesce(o.bal, 0) + coalesce(m.dr, 0) - coalesce(m.cr, 0))
             ORDER BY a.code)
        FROM public.gl_accounts a
        LEFT JOIN (SELECT l.account_code, sum(l.debit_jpy) - sum(l.credit_jpy) AS bal
                     FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id
                    WHERE j.entry_date < p_from GROUP BY 1) o ON o.account_code = a.code
        LEFT JOIN (SELECT l.account_code, sum(l.debit_jpy) AS dr, sum(l.credit_jpy) AS cr
                     FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id
                    WHERE j.entry_date BETWEEN p_from AND p_to GROUP BY 1) m ON m.account_code = a.code
       WHERE coalesce(o.bal, 0) <> 0 OR coalesce(m.dr, 0) <> 0 OR coalesce(m.cr, 0) <> 0 OR a.active), '[]'::jsonb),
    'journal_count', (SELECT count(*) FROM public.gl_journals j WHERE j.entry_date BETWEEN p_from AND p_to));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_trial_balance(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trial_balance(date, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.post_manual_journal(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_kind text := coalesce(p->>'kind', 'manual');
  v_date date;
  v_desc text := btrim(coalesce(p->>'description', ''));
  v_lines jsonb := p->'lines';
  v_start date := public.gl_ledger_start();
  v_rate numeric := public.gl_rate();
  v_dr numeric := 0;
  v_cr numeric := 0;
  v_id uuid;
  l jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'post_journal') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF v_kind NOT IN ('manual', 'opening') THEN RETURN jsonb_build_object('error', 'invalid_kind'); END IF;
  IF v_start IS NULL THEN RETURN jsonb_build_object('error', 'ledger_start_not_set'); END IF;
  IF v_rate IS NULL THEN RETURN jsonb_build_object('error', 'rate_not_set'); END IF;
  BEGIN
    v_date := (p->>'entry_date')::date;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('error', 'invalid_date');
  END;
  IF v_date IS NULL OR v_date < v_start OR v_date > (now() AT TIME ZONE 'Asia/Tokyo')::date THEN
    RETURN jsonb_build_object('error', 'invalid_date');
  END IF;
  IF v_kind = 'opening' AND v_date <> v_start THEN RETURN jsonb_build_object('error', 'opening_must_be_start_date'); END IF;
  IF length(v_desc) < 3 OR length(v_desc) > 500 THEN RETURN jsonb_build_object('error', 'invalid_description'); END IF;
  IF v_lines IS NULL OR jsonb_typeof(v_lines) <> 'array' OR jsonb_array_length(v_lines) < 2 OR jsonb_array_length(v_lines) > 50 THEN
    RETURN jsonb_build_object('error', 'invalid_lines');
  END IF;
  IF EXISTS (SELECT 1 FROM public.gl_periods gp WHERE gp.period_start = date_trunc('month', v_date)::date AND gp.status = 'closed') THEN
    RETURN jsonb_build_object('error', 'period_closed');
  END IF;
  FOR l IN SELECT * FROM jsonb_array_elements(v_lines) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.gl_accounts a WHERE a.code = l->>'a' AND a.active) THEN
      RETURN jsonb_build_object('error', 'invalid_lines', 'detail', 'unknown account ' || coalesce(l->>'a', '?'));
    END IF;
    IF coalesce(l->>'side', '') NOT IN ('dr', 'cr') OR coalesce(l->>'cur', '') NOT IN ('JPY', 'PHP')
       OR coalesce(l->>'amt', '') !~ '^[0-9]+(\.[0-9]{1,2})?$' OR (l->>'amt')::numeric <= 0 OR (l->>'amt')::numeric > 10000000000 THEN
      RETURN jsonb_build_object('error', 'invalid_lines');
    END IF;
    IF l->>'side' = 'dr' THEN v_dr := v_dr + public.gl_to_jpy((l->>'amt')::numeric, l->>'cur', v_rate);
    ELSE v_cr := v_cr + public.gl_to_jpy((l->>'amt')::numeric, l->>'cur', v_rate); END IF;
  END LOOP;
  IF v_dr <> v_cr THEN RETURN jsonb_build_object('error', 'unbalanced', 'debit_jpy', v_dr, 'credit_jpy', v_cr); END IF;
  v_id := public.gl_write_journal(v_kind, v_kind, NULL, NULL, v_date, v_desc,
            (SELECT jsonb_agg(jsonb_build_object('a', x->>'a', 'side', x->>'side', 'amt', x->>'amt', 'cur', x->>'cur', 'memo', left(x->>'memo', 300)))
               FROM jsonb_array_elements(v_lines) x),
            v_uid, NULL, nullif(btrim(coalesce(p->>'reason', '')), ''), NULL, NULL, NULL, NULL);
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('gl_journal', v_id, 'post_manual_journal', (SELECT to_jsonb(j) FROM public.gl_journals j WHERE j.id = v_id), v_uid, now());
  RETURN jsonb_build_object('ok', true, 'journal', (SELECT to_jsonb(j) FROM public.gl_journals j WHERE j.id = v_id));
END
$fn$;
REVOKE ALL ON FUNCTION public.post_manual_journal(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_manual_journal(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.reverse_journal(p_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_j public.gl_journals;
  v_lines jsonb;
  v_rev uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'post_journal') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF length(v_reason) < 3 THEN RETURN jsonb_build_object('error', 'reason_required'); END IF;
  SELECT * INTO v_j FROM public.gl_journals WHERE id = p_id FOR UPDATE;
  IF v_j.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_j.status <> 'posted' THEN RETURN jsonb_build_object('error', 'already_reversed'); END IF;
  IF v_j.kind = 'auto' THEN RETURN jsonb_build_object('error', 'auto_journal_follows_source'); END IF;
  IF v_j.kind = 'reversal' THEN RETURN jsonb_build_object('error', 'cannot_reverse_reversal'); END IF;
  SELECT jsonb_agg(jsonb_build_object('a', l.account_code, 'side', CASE WHEN l.debit > 0 THEN 'cr' ELSE 'dr' END,
                                      'amt', CASE WHEN l.debit > 0 THEN l.debit ELSE l.credit END, 'cur', l.currency, 'memo', l.memo,
                                      'jpy', CASE WHEN l.debit > 0 THEN l.debit_jpy ELSE l.credit_jpy END) ORDER BY l.line_no)
    INTO v_lines FROM public.gl_journal_lines l WHERE l.journal_id = p_id;
  v_rev := public.gl_write_journal('reversal', v_j.source_type, v_j.source_id, NULL, (now() AT TIME ZONE 'Asia/Tokyo')::date,
             'Reversal of #' || v_j.journal_no || ': ' || v_j.description, v_lines, v_uid, p_id, v_reason, NULL, NULL, NULL, NULL);
  UPDATE public.gl_journals SET status = 'reversed', reversed_by = v_rev WHERE id = p_id;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('gl_journal', p_id, 'reverse_journal', to_jsonb(v_j), jsonb_build_object('reversal_id', v_rev, 'reason', v_reason), v_uid, now());
  RETURN jsonb_build_object('ok', true, 'reversal_id', v_rev);
END
$fn$;
REVOKE ALL ON FUNCTION public.reverse_journal(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_journal(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.close_period(p_period_start date, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_start date := public.gl_ledger_start();
  v_period date;
  v_today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_open_before date;
  v_run jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'close_period') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF v_start IS NULL THEN RETURN jsonb_build_object('error', 'ledger_start_not_set'); END IF;
  IF p_period_start IS NULL OR p_period_start <> date_trunc('month', p_period_start)::date THEN RETURN jsonb_build_object('error', 'invalid_period'); END IF;
  IF p_period_start >= date_trunc('month', v_today)::date THEN RETURN jsonb_build_object('error', 'period_not_ended'); END IF;
  IF p_period_start < date_trunc('month', v_start)::date THEN RETURN jsonb_build_object('error', 'before_ledger_start'); END IF;
  SELECT min(m)::date INTO v_open_before
    FROM generate_series(date_trunc('month', v_start)::date, p_period_start - 1, interval '1 month') m
   WHERE NOT EXISTS (SELECT 1 FROM public.gl_periods gp WHERE gp.period_start = m::date AND gp.status = 'closed');
  IF v_open_before IS NOT NULL THEN RETURN jsonb_build_object('error', 'earlier_period_open', 'period', v_open_before); END IF;
  v_period := public.gl_period_for(p_period_start);
  IF EXISTS (SELECT 1 FROM public.gl_periods gp WHERE gp.period_start = v_period AND gp.status = 'closed') THEN
    RETURN jsonb_build_object('error', 'already_closed');
  END IF;
  v_run := public.gl_post_pending(false, 'manual', v_uid);
  IF coalesce((v_run->>'failed')::int, 0) > 0 THEN
    RETURN jsonb_build_object('error', 'posting_failed', 'run', v_run);
  END IF;
  UPDATE public.gl_periods SET status = 'closed', closed_at = now(), closed_by = v_uid, note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now()
   WHERE period_start = v_period;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('gl_period', gen_random_uuid(), 'close_period', jsonb_build_object('period_start', v_period, 'note', p_note), v_uid, now());
  RETURN jsonb_build_object('ok', true, 'period', (SELECT to_jsonb(gp) FROM public.gl_periods gp WHERE gp.period_start = v_period));
END
$fn$;
REVOKE ALL ON FUNCTION public.close_period(date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_period(date, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reopen_period(p_period_start date, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'close_period') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF length(v_reason) < 3 THEN RETURN jsonb_build_object('error', 'reason_required'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gl_periods gp WHERE gp.period_start = p_period_start AND gp.status = 'closed') THEN
    RETURN jsonb_build_object('error', 'not_closed');
  END IF;
  IF EXISTS (SELECT 1 FROM public.gl_periods gp WHERE gp.period_start > p_period_start AND gp.status = 'closed') THEN
    RETURN jsonb_build_object('error', 'later_period_closed');
  END IF;
  UPDATE public.gl_periods SET status = 'open', closed_at = NULL, closed_by = NULL, note = v_reason, updated_at = now()
   WHERE period_start = p_period_start;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('gl_period', gen_random_uuid(), 'reopen_period', jsonb_build_object('period_start', p_period_start, 'reason', v_reason), v_uid, now());
  RETURN jsonb_build_object('ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.reopen_period(date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reopen_period(date, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_ledger_start(p_date date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_old date := public.gl_ledger_start();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'close_period') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_date IS NULL OR p_date <> date_trunc('month', p_date)::date OR p_date < '2020-01-01' OR p_date > (now() AT TIME ZONE 'Asia/Tokyo')::date THEN
    RETURN jsonb_build_object('error', 'invalid_date');
  END IF;
  IF EXISTS (SELECT 1 FROM public.gl_journals) THEN RETURN jsonb_build_object('error', 'ledger_has_journals'); END IF;
  INSERT INTO public.system_settings (key, value) VALUES ('ledger_start_date', to_jsonb(p_date::text))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('gl_setting', gen_random_uuid(), 'set_ledger_start', jsonb_build_object('ledger_start_date', v_old), jsonb_build_object('ledger_start_date', p_date), v_uid, now());
  RETURN jsonb_build_object('ok', true, 'ledger_start_date', p_date);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_ledger_start(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_ledger_start(date) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_payment_method_map(p_spelling text, p_account_code text, p_kind text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_spelling text := lower(btrim(coalesce(p_spelling, '')));
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'post_journal') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF length(v_spelling) NOT BETWEEN 1 AND 60 THEN RETURN jsonb_build_object('error', 'invalid_spelling'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gl_accounts a WHERE a.code = p_account_code AND a.active) THEN RETURN jsonb_build_object('error', 'invalid_account'); END IF;
  IF coalesce(p_kind, '') NOT IN ('bank', 'cash', 'clearing', 'cod', 'non_cash', 'suspense') THEN RETURN jsonb_build_object('error', 'invalid_kind'); END IF;
  INSERT INTO public.gl_payment_method_map (spelling, account_code, kind, updated_by, updated_at)
  VALUES (v_spelling, p_account_code, p_kind, v_uid, now())
  ON CONFLICT (spelling) DO UPDATE SET account_code = EXCLUDED.account_code, kind = EXCLUDED.kind, updated_by = v_uid, updated_at = now();
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('gl_method_map', gen_random_uuid(), 'set_payment_method_map', jsonb_build_object('spelling', v_spelling, 'account_code', p_account_code, 'kind', p_kind), v_uid, now());
  RETURN jsonb_build_object('ok', true, 'spelling', v_spelling, 'account_code', p_account_code,
                            'repost', public.gl_post_pending(false, 'manual', v_uid));
END
$fn$;
REVOKE ALL ON FUNCTION public.set_payment_method_map(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_payment_method_map(text, text, text) TO authenticated;

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
  v_old public.gl_accounts;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'admin_settings') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF v_code !~ '^[1-6][0-9]{3}$' THEN RETURN jsonb_build_object('error', 'invalid_code'); END IF;
  IF length(v_name) NOT BETWEEN 1 AND 120 THEN RETURN jsonb_build_object('error', 'invalid_name'); END IF;
  SELECT * INTO v_old FROM public.gl_accounts WHERE code = v_code;
  IF v_old.code IS NULL THEN
    IF coalesce(v_kind, '') NOT IN ('asset', 'liability', 'equity', 'revenue', 'cogs', 'expense') THEN RETURN jsonb_build_object('error', 'invalid_kind'); END IF;
    INSERT INTO public.gl_accounts (code, name, kind, contra, currency_hint, active, sort_order)
    VALUES (v_code, v_name, v_kind, coalesce((p->>'contra')::boolean, false), nullif(p->>'currency_hint', ''), v_active,
            coalesce((p->>'sort_order')::int, (left(v_code, 1)::int * 100) + 900));
  ELSE
    IF NOT v_active AND v_old.system_key IS NOT NULL THEN RETURN jsonb_build_object('error', 'system_account'); END IF;
    UPDATE public.gl_accounts SET name = v_name, active = v_active, updated_at = now() WHERE code = v_code;
  END IF;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('gl_account', gen_random_uuid(), 'upsert_gl_account', CASE WHEN v_old.code IS NULL THEN NULL ELSE to_jsonb(v_old) END,
          (SELECT to_jsonb(a) FROM public.gl_accounts a WHERE a.code = v_code), v_uid, now());
  RETURN jsonb_build_object('ok', true, 'account', (SELECT to_jsonb(a) FROM public.gl_accounts a WHERE a.code = v_code));
END
$fn$;
REVOKE ALL ON FUNCTION public.upsert_gl_account(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_gl_account(jsonb) TO authenticated;

-- Phase 1 trigger, re-stated with ONE extra allowance: an approved expense may change
-- paid_from (which account paid it) and nothing else. Everything else is unchanged.
CREATE OR REPLACE FUNCTION public.expenses_before_write()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_rate numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'expenses are never deleted; void the expense instead' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'an expense starts as a draft' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'an expense''s id and creation record cannot be changed' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'void' THEN
      RAISE EXCEPTION 'a void expense cannot be changed' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'approved' THEN
      IF NEW.status = 'approved' AND NEW.paid_from IS DISTINCT FROM OLD.paid_from
         AND to_jsonb(NEW) - 'paid_from' - 'updated_at' = to_jsonb(OLD) - 'paid_from' - 'updated_at' THEN
        NEW.updated_at := now();
        RETURN NEW;
      END IF;
      IF NEW.status <> 'void'
         OR NEW.expense_date IS DISTINCT FROM OLD.expense_date
         OR NEW.category_id IS DISTINCT FROM OLD.category_id
         OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
         OR NEW.description IS DISTINCT FROM OLD.description
         OR NEW.currency IS DISTINCT FROM OLD.currency
         OR NEW.amount IS DISTINCT FROM OLD.amount
         OR NEW.fx_php_per_jpy IS DISTINCT FROM OLD.fx_php_per_jpy
         OR NEW.amount_jpy IS DISTINCT FROM OLD.amount_jpy
         OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
         OR NEW.receipt_path IS DISTINCT FROM OLD.receipt_path
         OR NEW.source IS DISTINCT FROM OLD.source
         OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
         OR NEW.notes IS DISTINCT FROM OLD.notes
         OR NEW.details IS DISTINCT FROM OLD.details
         OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
         OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
        RAISE EXCEPTION 'an approved expense is locked; it can only be voided' USING ERRCODE = 'check_violation';
      END IF;
      NEW.updated_at := now();
      RETURN NEW;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR (OLD.status = 'draft' AND NEW.status IN ('draft', 'approved')) THEN
    IF NEW.currency = 'JPY' THEN
      NEW.fx_php_per_jpy := NULL;
      NEW.amount_jpy := round(NEW.amount);
    ELSE
      SELECT (value #>> '{}')::numeric INTO v_rate FROM public.system_settings WHERE key = 'php_jpy_rate';
      IF v_rate IS NULL OR v_rate <= 0 THEN
        RAISE EXCEPTION 'php_jpy_rate is not set' USING ERRCODE = 'check_violation';
      END IF;
      NEW.fx_php_per_jpy := v_rate;
      NEW.amount_jpy := round(NEW.amount / v_rate);
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END
$fn$;
COMMENT ON FUNCTION public.expenses_before_write() IS
  'BEFORE INSERT/UPDATE/DELETE on expenses. Insert must be a draft. Insert, and a draft row staying draft or being approved: amount_jpy = round(amount) for JPY, round(amount / php_jpy_rate) for PHP, rate stored in fx_php_per_jpy (draft -> void keeps the figures). Approved rows: locked except the transition to void and a paid_from-only change (Phase 2b). Void rows: locked. id / created_by / created_at never change. DELETE: always refused.';

CREATE OR REPLACE FUNCTION public.get_paid_from_accounts()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT (public.has_permission(v_uid, 'manage_expenses') OR public.has_permission(v_uid, 'approve_expenses') OR public.has_permission(v_uid, 'view_ledger')) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  RETURN jsonb_build_object('accounts', coalesce((
    SELECT jsonb_agg(jsonb_build_object('code', a.code, 'name', a.name, 'currency_hint', a.currency_hint) ORDER BY a.sort_order, a.code)
      FROM public.gl_accounts a
     WHERE a.active AND a.kind = 'asset' AND a.code < '1200'), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_paid_from_accounts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_paid_from_accounts() TO authenticated;

CREATE OR REPLACE FUNCTION public.set_expense_paid_from(p_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_old public.expenses;
  v_code text := nullif(btrim(coalesce(p_code, '')), '');
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  SELECT * INTO v_old FROM public.expenses WHERE id = p_id FOR UPDATE;
  IF v_old.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_old.status = 'void' THEN RETURN jsonb_build_object('error', 'not_draft', 'status', 'void'); END IF;
  IF v_old.status = 'draft' THEN
    IF NOT (public.has_permission(v_uid, 'manage_expenses') OR public.has_permission(v_uid, 'approve_expenses')) THEN
      RETURN jsonb_build_object('error', 'permission_denied');
    END IF;
  ELSIF NOT public.has_permission(v_uid, 'approve_expenses') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF v_code IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.gl_accounts a WHERE a.code = v_code AND a.active AND a.kind = 'asset' AND a.code < '1200') THEN
    RETURN jsonb_build_object('error', 'invalid_account');
  END IF;
  IF v_old.paid_from IS NOT DISTINCT FROM v_code THEN RETURN jsonb_build_object('ok', true, 'expense', to_jsonb(v_old)); END IF;
  UPDATE public.expenses SET paid_from = v_code WHERE id = p_id;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('expense', p_id, 'set_expense_paid_from', jsonb_build_object('paid_from', v_old.paid_from), jsonb_build_object('paid_from', v_code), v_uid, now());
  RETURN jsonb_build_object('ok', true, 'expense', (SELECT to_jsonb(e) FROM public.expenses e WHERE e.id = p_id));
END
$fn$;
REVOKE ALL ON FUNCTION public.set_expense_paid_from(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_expense_paid_from(uuid, text) TO authenticated;
COMMENT ON FUNCTION public.set_expense_paid_from(uuid, text) IS
  'Sets which bank / cash / clearing account paid an expense (drafts: manage or approve; approved rows: approve_expenses). The ledger reposts the expense journal on the next posting run. Audited.';

-- ---------------------------------------------------------------------------
-- 11. Permissions (admin true, everyone else false, explicit rows).
-- ---------------------------------------------------------------------------
INSERT INTO public.role_permissions (role, permission_key, is_allowed) VALUES
  ('admin'::app_role,      'view_ledger',  true),
  ('staff'::app_role,      'view_ledger',  false),
  ('finance'::app_role,    'view_ledger',  false),
  ('csr'::app_role,        'view_ledger',  false),
  ('live_agent'::app_role, 'view_ledger',  false),
  ('admin'::app_role,      'post_journal', true),
  ('staff'::app_role,      'post_journal', false),
  ('finance'::app_role,    'post_journal', false),
  ('csr'::app_role,        'post_journal', false),
  ('live_agent'::app_role, 'post_journal', false),
  ('admin'::app_role,      'close_period', true),
  ('staff'::app_role,      'close_period', false),
  ('finance'::app_role,    'close_period', false),
  ('csr'::app_role,        'close_period', false),
  ('live_agent'::app_role, 'close_period', false)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 12. Nightly posting (00:40 JST). Skipped where pg_cron is absent (local harness).
-- ---------------------------------------------------------------------------
DO $c$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'gl-post-pending') THEN
      PERFORM cron.unschedule('gl-post-pending');
    END IF;
    PERFORM cron.schedule('gl-post-pending', '40 15 * * *', $job$ SELECT public.gl_post_pending(false, 'cron', NULL); $job$);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'gl-post-pending cron schedule skipped: %', SQLERRM;
END
$c$;
