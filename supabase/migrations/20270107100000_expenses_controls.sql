-- ============================================================================
-- Expenses Phase 8 — controls (owner 2026-10-26; plan claude/expenses-phase8-controls-plan-2026-10-26.md,
-- D1–D6 as recommended).
--
-- Adds, on top of Phases 1–7:
--   * Period lock completed (D2): an expense created, edited or approved with a date inside a CLOSED month is
--     refused (period_closed); voiding stays allowed, a paid_from-only correction stays allowed, and drafts the
--     system makes (email / recurring / payroll / commission) are moved to the first open day with a note.
--   * Close readiness (D1): get_close_readiness(month) lists what is still open; close_period refuses when the
--     book has ERRORS (unbalanced / duplicate journals, unposted events) and records the warning counts.
--   * Nightly completeness check (D5): gl_check_runs + gl_run_completeness_check (11 checks), cron
--     gl-completeness-check at 16:10 UTC (01:10 JST, after the posting run), run_ledger_check() on demand
--     (post_journal), one staff bell (type ledger_check, no amounts) when there are errors or new warnings.
--   * Bank reconciliation (D3, D4, D6): bank_import_profiles (column map per account), bank_statement_imports,
--     bank_statement_lines (signed native amounts, matched to one journal line), bank_reconciliations (per
--     account per month; cash accounts hold the counted cash); RPCs import_bank_statement, void_bank_import,
--     auto_match_bank_lines (same amount, ±3 days, one candidate on each side), match / unmatch / ignore,
--     get_bank_reconciliation, sign_off_reconciliation / reopen_reconciliation.
--   * get_ledger_status re-stated with the last check run and the reconciliation counts per month.
--
-- Rules kept: re-runnable; RLS as scalar sub-selects; REVOKE from PUBLIC/anon on every RPC (internal helpers
-- also from authenticated); no "--" comment lines inside any function body (Lovable strips them); no deletes.
-- ============================================================================

SET lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Period lock on expenses (D2).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gl_period_is_closed(p_date date)
RETURNS boolean
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.gl_periods gp WHERE gp.period_start = date_trunc('month', p_date)::date AND gp.status = 'closed')
$fn$;
REVOKE ALL ON FUNCTION public.gl_period_is_closed(date) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.expenses_before_period_lock()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_old_date date;
BEGIN
  IF NOT public.gl_period_is_closed(NEW.expense_date) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF coalesce(NEW.source, 'manual') <> 'manual' THEN
      v_old_date := NEW.expense_date;
      NEW.expense_date := public.gl_posting_date(NEW.expense_date);
      NEW.notes := left(coalesce(NEW.notes || E'\n', '') || 'Dated ' || v_old_date::text || ' (month already closed); booked on the first open day.', 2000);
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'period_closed: % is in a closed month', NEW.expense_date USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'void' THEN RETURN NEW; END IF;
  IF to_jsonb(NEW) - 'updated_at' = to_jsonb(OLD) - 'updated_at' THEN RETURN NEW; END IF;
  IF OLD.status = 'approved' AND NEW.status = 'approved'
     AND to_jsonb(NEW) - 'paid_from' - 'updated_at' = to_jsonb(OLD) - 'paid_from' - 'updated_at' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'period_closed: % is in a closed month', NEW.expense_date USING ERRCODE = 'check_violation';
END
$fn$;
COMMENT ON FUNCTION public.expenses_before_period_lock() IS
  'Phase 8 (D2). BEFORE INSERT OR UPDATE on expenses, fires before expenses_before_write (alphabetical). A manual expense dated in a closed month is refused (period_closed) on insert, on any edit and on approval; voiding and a paid_from-only correction stay allowed; drafts made by the system (email / recurring / payroll / commission) move to the first open day with a note.';
DROP TRIGGER IF EXISTS expenses_before_period_lock ON public.expenses;
CREATE TRIGGER expenses_before_period_lock BEFORE INSERT OR UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.expenses_before_period_lock();

-- ---------------------------------------------------------------------------
-- 2. Bank reconciliation tables (D3, D4, D6).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bank_import_profiles (
  account_code    text PRIMARY KEY REFERENCES public.gl_accounts(code),
  delimiter       text NOT NULL DEFAULT ',' CHECK (delimiter IN (',', ';', E'\t')),
  header_rows     integer NOT NULL DEFAULT 1 CHECK (header_rows BETWEEN 0 AND 20),
  date_col        integer NOT NULL CHECK (date_col >= 0),
  date_format     text NOT NULL DEFAULT 'ymd' CHECK (date_format IN ('ymd', 'dmy', 'mdy')),
  description_col integer NULL CHECK (description_col IS NULL OR description_col >= 0),
  in_col          integer NULL CHECK (in_col IS NULL OR in_col >= 0),
  out_col         integer NULL CHECK (out_col IS NULL OR out_col >= 0),
  signed_col      integer NULL CHECK (signed_col IS NULL OR signed_col >= 0),
  balance_col     integer NULL CHECK (balance_col IS NULL OR balance_col >= 0),
  encoding        text NOT NULL DEFAULT 'utf-8' CHECK (encoding IN ('utf-8', 'shift_jis')),
  updated_by      uuid NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_import_profiles_amount CHECK (signed_col IS NOT NULL OR in_col IS NOT NULL OR out_col IS NOT NULL)
);
ALTER TABLE public.bank_import_profiles ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.bank_import_profiles IS
  'Phase 8: how each bank''s CSV maps to statement lines (0-based column numbers), saved once per account by whoever imports (post_journal). The browser parses the file with this map; the server stores lines, not files.';
DROP POLICY IF EXISTS bank_import_profiles_read ON public.bank_import_profiles;
CREATE POLICY bank_import_profiles_read ON public.bank_import_profiles FOR SELECT TO authenticated
  USING ((SELECT public.has_permission((SELECT auth.uid()), 'view_ledger')));
REVOKE ALL ON public.bank_import_profiles FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.bank_import_profiles FROM authenticated;
GRANT SELECT ON public.bank_import_profiles TO authenticated;

CREATE TABLE IF NOT EXISTS public.bank_statement_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_code  text NOT NULL REFERENCES public.gl_accounts(code),
  file_name     text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  file_sha256   text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  encoding      text NOT NULL,
  rows_in_file  integer NOT NULL CHECK (rows_in_file >= 0),
  inserted      integer NOT NULL DEFAULT 0,
  skipped       integer NOT NULL DEFAULT 0,
  period_from   date NULL,
  period_to     date NULL,
  imported_by   uuid NULL,
  imported_at   timestamptz NOT NULL DEFAULT now(),
  voided_at     timestamptz NULL,
  voided_by     uuid NULL,
  void_reason   text NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_statement_imports_file_uq ON public.bank_statement_imports (account_code, file_sha256) WHERE voided_at IS NULL;
ALTER TABLE public.bank_statement_imports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_statement_imports_read ON public.bank_statement_imports;
CREATE POLICY bank_statement_imports_read ON public.bank_statement_imports FOR SELECT TO authenticated
  USING ((SELECT public.has_permission((SELECT auth.uid()), 'view_ledger')));
REVOKE ALL ON public.bank_statement_imports FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.bank_statement_imports FROM authenticated;
GRANT SELECT ON public.bank_statement_imports TO authenticated;

CREATE TABLE IF NOT EXISTS public.bank_statement_lines (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id               uuid NOT NULL REFERENCES public.bank_statement_imports(id),
  account_code            text NOT NULL REFERENCES public.gl_accounts(code),
  line_no                 integer NOT NULL CHECK (line_no >= 1),
  booked_on               date NOT NULL,
  description             text NOT NULL DEFAULT '',
  amount                  numeric(15,2) NOT NULL CHECK (amount <> 0),
  balance_after           numeric(15,2) NULL,
  raw                     jsonb NOT NULL DEFAULT '[]'::jsonb,
  matched_journal_line_id uuid NULL REFERENCES public.gl_journal_lines(id),
  match_kind              text NULL CHECK (match_kind IN ('auto', 'manual', 'ignored')),
  matched_by              uuid NULL,
  matched_at              timestamptz NULL,
  ignore_reason           text NULL,
  CONSTRAINT bank_statement_lines_match CHECK (
    (match_kind IS NULL AND matched_journal_line_id IS NULL AND ignore_reason IS NULL)
    OR (match_kind IN ('auto', 'manual') AND matched_journal_line_id IS NOT NULL)
    OR (match_kind = 'ignored' AND matched_journal_line_id IS NULL AND ignore_reason IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_statement_lines_journal_uq ON public.bank_statement_lines (matched_journal_line_id) WHERE matched_journal_line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bank_statement_lines_account_idx ON public.bank_statement_lines (account_code, booked_on);
CREATE INDEX IF NOT EXISTS bank_statement_lines_import_idx ON public.bank_statement_lines (import_id);
ALTER TABLE public.bank_statement_lines ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.bank_statement_lines IS
  'Phase 8: one bank statement line (amount signed in the account''s currency: + money in, − money out). Matched to at most one journal line on the same account; "ignored" = the bank''s own interest / fee line the owner books separately (reason kept). Lines of a voided import are left out of every read.';
DROP POLICY IF EXISTS bank_statement_lines_read ON public.bank_statement_lines;
CREATE POLICY bank_statement_lines_read ON public.bank_statement_lines FOR SELECT TO authenticated
  USING ((SELECT public.has_permission((SELECT auth.uid()), 'view_ledger')));
REVOKE ALL ON public.bank_statement_lines FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.bank_statement_lines FROM authenticated;
GRANT SELECT ON public.bank_statement_lines TO authenticated;

CREATE TABLE IF NOT EXISTS public.bank_reconciliations (
  account_code          text NOT NULL REFERENCES public.gl_accounts(code),
  month_start           date NOT NULL CHECK (month_start = date_trunc('month', month_start)::date),
  statement_closing     numeric(15,2) NULL,
  ledger_closing_native numeric(15,2) NULL,
  ledger_closing_jpy    numeric(15,0) NULL,
  difference            numeric(15,2) NULL,
  unmatched_statement   integer NOT NULL DEFAULT 0,
  unmatched_ledger      integer NOT NULL DEFAULT 0,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reconciled')),
  note                  text NULL,
  reconciled_by         uuid NULL,
  reconciled_at         timestamptz NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_code, month_start)
);
ALTER TABLE public.bank_reconciliations ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.bank_reconciliations IS
  'Phase 8: one row per money account per month once someone types the statement closing balance (for cash accounts: the counted cash) or signs off. reconciled = difference 0, nothing unmatched; the counts at sign-off are kept.';
DROP POLICY IF EXISTS bank_reconciliations_read ON public.bank_reconciliations;
CREATE POLICY bank_reconciliations_read ON public.bank_reconciliations FOR SELECT TO authenticated
  USING ((SELECT public.has_permission((SELECT auth.uid()), 'view_ledger')));
REVOKE ALL ON public.bank_reconciliations FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.bank_reconciliations FROM authenticated;
GRANT SELECT ON public.bank_reconciliations TO authenticated;

-- Money accounts the reconciliation knows: active asset accounts below the clearing range (bank / e-money / cash).
CREATE OR REPLACE FUNCTION public.gl_is_money_account(p_code text)
RETURNS boolean
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.gl_accounts a WHERE a.code = p_code AND a.kind = 'asset' AND a.active AND a.code < '1130')
$fn$;
REVOKE ALL ON FUNCTION public.gl_is_money_account(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.gl_account_currency(p_code text)
RETURNS text
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  SELECT coalesce(a.currency_hint, 'JPY') FROM public.gl_accounts a WHERE a.code = p_code
$fn$;
REVOKE ALL ON FUNCTION public.gl_account_currency(text) FROM PUBLIC, anon, authenticated;

-- Journal lines a statement line may match: live journals only (a reversed journal and its reversal cancel out).
CREATE OR REPLACE VIEW public.gl_live_money_lines AS
  SELECT l.id, l.journal_id, l.account_code, l.currency, j.entry_date, j.journal_no, j.kind, j.source_type, j.description, l.memo,
         l.customer_id, l.account_id, l.cash_order_id, l.expense_id,
         CASE WHEN l.debit > 0 THEN l.debit ELSE -l.credit END AS signed_amount,
         CASE WHEN l.debit > 0 THEN l.debit_jpy ELSE -l.credit_jpy END AS signed_jpy
    FROM public.gl_journal_lines l
    JOIN public.gl_journals j ON j.id = l.journal_id
   WHERE j.status = 'posted' AND j.kind <> 'reversal';
REVOKE ALL ON public.gl_live_money_lines FROM PUBLIC, anon, authenticated;
COMMENT ON VIEW public.gl_live_money_lines IS 'Phase 8 (internal): posted, non-reversal journal lines with a signed native amount (+ debit / − credit). The reconciliation reads the ledger through this view, so a correction reversed after month end is already out of the month-end balance (the bank never saw it); the trial balance keeps the as-the-books-stood figure. Opening-balance lines count in the balance but are never matched to a statement line.';

-- ---------------------------------------------------------------------------
-- 3. Bank reconciliation RPCs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.import_bank_statement(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_account text := btrim(coalesce(p->>'account_code', ''));
  v_sha text := lower(btrim(coalesce(p->>'file_sha256', '')));
  v_lines jsonb := p->'lines';
  v_profile jsonb := p->'profile';
  v_import uuid;
  v_inserted int := 0;
  v_skipped int := 0;
  v_no int := 0;
  v_min date; v_max date;
  l jsonb;
  v_date date; v_amount numeric; v_desc text; v_bal numeric;
  v_months date[];
  m date;
  v_matched int := 0;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'post_journal') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF NOT public.gl_is_money_account(v_account) THEN RETURN jsonb_build_object('error', 'invalid_account'); END IF;
  IF v_sha !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('error', 'invalid_file'); END IF;
  IF jsonb_typeof(v_lines) <> 'array' OR jsonb_array_length(v_lines) = 0 THEN RETURN jsonb_build_object('error', 'no_lines'); END IF;
  IF jsonb_array_length(v_lines) > 5000 THEN RETURN jsonb_build_object('error', 'too_many_lines'); END IF;
  IF EXISTS (SELECT 1 FROM public.bank_statement_imports i WHERE i.account_code = v_account AND i.file_sha256 = v_sha AND i.voided_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'duplicate_file');
  END IF;
  IF jsonb_typeof(v_profile) = 'object' THEN
    BEGIN
      INSERT INTO public.bank_import_profiles (account_code, delimiter, header_rows, date_col, date_format, description_col, in_col, out_col, signed_col, balance_col, encoding, updated_by, updated_at)
      VALUES (v_account, coalesce(v_profile->>'delimiter', ','), coalesce((v_profile->>'header_rows')::int, 1), (v_profile->>'date_col')::int,
              coalesce(v_profile->>'date_format', 'ymd'), (v_profile->>'description_col')::int, (v_profile->>'in_col')::int, (v_profile->>'out_col')::int,
              (v_profile->>'signed_col')::int, (v_profile->>'balance_col')::int, coalesce(v_profile->>'encoding', 'utf-8'), v_uid, now())
      ON CONFLICT (account_code) DO UPDATE SET delimiter = EXCLUDED.delimiter, header_rows = EXCLUDED.header_rows, date_col = EXCLUDED.date_col,
              date_format = EXCLUDED.date_format, description_col = EXCLUDED.description_col, in_col = EXCLUDED.in_col, out_col = EXCLUDED.out_col,
              signed_col = EXCLUDED.signed_col, balance_col = EXCLUDED.balance_col, encoding = EXCLUDED.encoding, updated_by = v_uid, updated_at = now();
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('error', 'invalid_profile');
    END;
  END IF;
  INSERT INTO public.bank_statement_imports (account_code, file_name, file_sha256, encoding, rows_in_file, imported_by)
  VALUES (v_account, left(coalesce(nullif(btrim(p->>'file_name'), ''), 'statement.csv'), 200), v_sha, coalesce(v_profile->>'encoding', p->>'encoding', 'utf-8'),
          jsonb_array_length(v_lines), v_uid)
  RETURNING id INTO v_import;
  FOR l IN SELECT x FROM jsonb_array_elements(v_lines) x
  LOOP
    v_no := v_no + 1;
    BEGIN
      v_date := (l->>'booked_on')::date;
      v_amount := round((l->>'amount')::numeric, 2);
      v_bal := CASE WHEN nullif(l->>'balance_after', '') IS NULL THEN NULL ELSE round((l->>'balance_after')::numeric, 2) END;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('error', 'invalid_line', 'line_no', v_no);
    END;
    v_desc := left(btrim(coalesce(l->>'description', '')), 300);
    IF v_date IS NULL OR v_amount IS NULL OR v_amount = 0 THEN
      RETURN jsonb_build_object('error', 'invalid_line', 'line_no', v_no);
    END IF;
    IF EXISTS (SELECT 1 FROM public.bank_statement_lines s JOIN public.bank_statement_imports i ON i.id = s.import_id
                WHERE s.account_code = v_account AND i.voided_at IS NULL AND s.booked_on = v_date AND s.amount = v_amount AND s.description = v_desc) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    INSERT INTO public.bank_statement_lines (import_id, account_code, line_no, booked_on, description, amount, balance_after, raw)
    VALUES (v_import, v_account, v_no, v_date, v_desc, v_amount, v_bal, coalesce(l->'raw', '[]'::jsonb));
    v_inserted := v_inserted + 1;
    v_min := least(v_min, v_date); v_max := greatest(v_max, v_date);
  END LOOP;
  UPDATE public.bank_statement_imports SET inserted = v_inserted, skipped = v_skipped, period_from = v_min, period_to = v_max WHERE id = v_import;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('bank_import', v_import, 'import_bank_statement', jsonb_build_object('account', v_account, 'inserted', v_inserted, 'skipped', v_skipped, 'file', p->>'file_name'), v_uid, now());
  IF v_inserted > 0 THEN
    SELECT array_agg(DISTINCT date_trunc('month', s.booked_on)::date) INTO v_months FROM public.bank_statement_lines s WHERE s.import_id = v_import;
    FOREACH m IN ARRAY v_months LOOP
      v_matched := v_matched + coalesce((public.gl_auto_match(v_account, m, v_uid)->>'matched')::int, 0);
    END LOOP;
  END IF;
  RETURN jsonb_build_object('ok', true, 'import', (SELECT to_jsonb(i) FROM public.bank_statement_imports i WHERE i.id = v_import),
                            'inserted', v_inserted, 'skipped', v_skipped, 'auto_matched', v_matched);
END
$fn$;
REVOKE ALL ON FUNCTION public.import_bank_statement(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_bank_statement(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.void_bank_import(p_import uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.bank_statement_imports;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'post_journal') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN RETURN jsonb_build_object('error', 'reason_required'); END IF;
  SELECT * INTO v_row FROM public.bank_statement_imports WHERE id = p_import;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_row.voided_at IS NOT NULL THEN RETURN jsonb_build_object('error', 'already_voided'); END IF;
  IF EXISTS (SELECT 1 FROM public.bank_statement_lines s JOIN public.bank_reconciliations r ON r.account_code = s.account_code AND r.month_start = date_trunc('month', s.booked_on)::date
              WHERE s.import_id = p_import AND r.status = 'reconciled') THEN
    RETURN jsonb_build_object('error', 'month_reconciled');
  END IF;
  UPDATE public.bank_statement_lines SET matched_journal_line_id = NULL, match_kind = NULL, matched_by = NULL, matched_at = NULL, ignore_reason = NULL WHERE import_id = p_import;
  UPDATE public.bank_statement_imports SET voided_at = now(), voided_by = v_uid, void_reason = btrim(p_reason) WHERE id = p_import;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('bank_import', p_import, 'void_bank_import', to_jsonb(v_row), jsonb_build_object('reason', btrim(p_reason)), v_uid, now());
  RETURN jsonb_build_object('ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.void_bank_import(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_bank_import(uuid, text) TO authenticated;

-- Candidates for a statement line: same account, same signed native amount, entry date within 3 days, not matched yet.
CREATE OR REPLACE FUNCTION public.gl_auto_match(p_account text, p_month date, p_uid uuid)
RETURNS jsonb
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_n int := 0;
BEGIN
  WITH open_lines AS (
    SELECT s.id, s.booked_on, s.amount
      FROM public.bank_statement_lines s JOIN public.bank_statement_imports i ON i.id = s.import_id
     WHERE s.account_code = p_account AND i.voided_at IS NULL AND s.match_kind IS NULL
       AND date_trunc('month', s.booked_on)::date = p_month
  ), pairs AS (
    SELECT o.id AS line_id, j.id AS journal_line_id
      FROM open_lines o
      JOIN public.gl_live_money_lines j ON j.account_code = p_account AND j.signed_amount = o.amount AND j.kind <> 'opening'
       AND abs(j.entry_date - o.booked_on) <= 3
       AND NOT EXISTS (SELECT 1 FROM public.bank_statement_lines m WHERE m.matched_journal_line_id = j.id)
  ), one_each AS (
    SELECT p.line_id, p.journal_line_id FROM pairs p
     WHERE (SELECT count(*) FROM pairs q WHERE q.line_id = p.line_id) = 1
       AND (SELECT count(*) FROM pairs q WHERE q.journal_line_id = p.journal_line_id) = 1
  ), upd AS (
    UPDATE public.bank_statement_lines s SET matched_journal_line_id = o.journal_line_id, match_kind = 'auto', matched_by = p_uid, matched_at = now()
      FROM one_each o WHERE s.id = o.line_id RETURNING 1
  )
  SELECT count(*) INTO v_n FROM upd;
  RETURN jsonb_build_object('matched', v_n);
END
$fn$;
REVOKE ALL ON FUNCTION public.gl_auto_match(text, date, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.auto_match_bank_lines(p_account text, p_month date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'post_journal') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF NOT public.gl_is_money_account(p_account) THEN RETURN jsonb_build_object('error', 'invalid_account'); END IF;
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN RETURN jsonb_build_object('error', 'invalid_period'); END IF;
  RETURN jsonb_build_object('ok', true) || public.gl_auto_match(p_account, p_month, v_uid);
END
$fn$;
REVOKE ALL ON FUNCTION public.auto_match_bank_lines(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auto_match_bank_lines(text, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.match_bank_line(p_line uuid, p_journal_line uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  s public.bank_statement_lines;
  j record;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'post_journal') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  SELECT * INTO s FROM public.bank_statement_lines WHERE id = p_line;
  IF s.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF s.match_kind IS NOT NULL THEN RETURN jsonb_build_object('error', 'already_matched'); END IF;
  IF EXISTS (SELECT 1 FROM public.bank_reconciliations r WHERE r.account_code = s.account_code AND r.month_start = date_trunc('month', s.booked_on)::date AND r.status = 'reconciled') THEN
    RETURN jsonb_build_object('error', 'month_reconciled');
  END IF;
  SELECT * INTO j FROM public.gl_live_money_lines m WHERE m.id = p_journal_line;
  IF j.id IS NULL OR j.account_code <> s.account_code OR j.kind = 'opening' THEN RETURN jsonb_build_object('error', 'invalid_line_match'); END IF;
  IF j.signed_amount <> s.amount THEN RETURN jsonb_build_object('error', 'amount_differs'); END IF;
  IF abs(j.entry_date - s.booked_on) > 31 THEN RETURN jsonb_build_object('error', 'date_too_far'); END IF;
  IF EXISTS (SELECT 1 FROM public.bank_statement_lines m WHERE m.matched_journal_line_id = p_journal_line) THEN RETURN jsonb_build_object('error', 'already_matched'); END IF;
  UPDATE public.bank_statement_lines SET matched_journal_line_id = p_journal_line, match_kind = 'manual', matched_by = v_uid, matched_at = now() WHERE id = p_line;
  RETURN jsonb_build_object('ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.match_bank_line(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_bank_line(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.unmatch_bank_line(p_line uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  s public.bank_statement_lines;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'post_journal') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  SELECT * INTO s FROM public.bank_statement_lines WHERE id = p_line;
  IF s.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF s.match_kind IS NULL THEN RETURN jsonb_build_object('error', 'not_matched'); END IF;
  IF EXISTS (SELECT 1 FROM public.bank_reconciliations r WHERE r.account_code = s.account_code AND r.month_start = date_trunc('month', s.booked_on)::date AND r.status = 'reconciled') THEN
    RETURN jsonb_build_object('error', 'month_reconciled');
  END IF;
  UPDATE public.bank_statement_lines SET matched_journal_line_id = NULL, match_kind = NULL, matched_by = NULL, matched_at = NULL, ignore_reason = NULL WHERE id = p_line;
  RETURN jsonb_build_object('ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.unmatch_bank_line(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unmatch_bank_line(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.ignore_bank_line(p_line uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  s public.bank_statement_lines;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'post_journal') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN RETURN jsonb_build_object('error', 'reason_required'); END IF;
  SELECT * INTO s FROM public.bank_statement_lines WHERE id = p_line;
  IF s.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF s.match_kind IS NOT NULL THEN RETURN jsonb_build_object('error', 'already_matched'); END IF;
  IF EXISTS (SELECT 1 FROM public.bank_reconciliations r WHERE r.account_code = s.account_code AND r.month_start = date_trunc('month', s.booked_on)::date AND r.status = 'reconciled') THEN
    RETURN jsonb_build_object('error', 'month_reconciled');
  END IF;
  UPDATE public.bank_statement_lines SET match_kind = 'ignored', ignore_reason = left(btrim(p_reason), 200), matched_by = v_uid, matched_at = now() WHERE id = p_line;
  RETURN jsonb_build_object('ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.ignore_bank_line(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ignore_bank_line(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_bank_reconciliation(p_account text, p_month date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_end date;
  v_cur text;
  v_native numeric;
  v_jpy numeric;
  v_rec public.bank_reconciliations;
  v_last_balance numeric;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'view_ledger') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF NOT public.gl_is_money_account(p_account) THEN RETURN jsonb_build_object('error', 'invalid_account'); END IF;
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN RETURN jsonb_build_object('error', 'invalid_period'); END IF;
  v_end := (p_month + interval '1 month' - interval '1 day')::date;
  v_cur := public.gl_account_currency(p_account);
  SELECT coalesce(sum(m.signed_amount), 0), coalesce(sum(m.signed_jpy), 0) INTO v_native, v_jpy
    FROM public.gl_live_money_lines m WHERE m.account_code = p_account AND m.entry_date <= v_end;
  SELECT * INTO v_rec FROM public.bank_reconciliations WHERE account_code = p_account AND month_start = p_month;
  SELECT s.balance_after INTO v_last_balance
    FROM public.bank_statement_lines s JOIN public.bank_statement_imports i ON i.id = s.import_id
   WHERE s.account_code = p_account AND i.voided_at IS NULL AND s.booked_on <= v_end AND s.balance_after IS NOT NULL
   ORDER BY s.booked_on DESC, s.line_no DESC LIMIT 1;
  RETURN jsonb_build_object(
    'account', p_account, 'name', (SELECT a.name FROM public.gl_accounts a WHERE a.code = p_account), 'name_ja', (SELECT a.name_ja FROM public.gl_accounts a WHERE a.code = p_account),
    'currency', v_cur, 'is_cash', coalesce((SELECT a.system_key IN ('cash_jpy', 'cash_php') FROM public.gl_accounts a WHERE a.code = p_account), false),
    'month', p_month, 'month_end', v_end,
    'ledger_closing_native', v_native, 'ledger_closing_jpy', v_jpy,
    'statement_closing', coalesce(v_rec.statement_closing, v_last_balance),
    'statement_closing_source', CASE WHEN v_rec.statement_closing IS NOT NULL THEN 'typed' WHEN v_last_balance IS NOT NULL THEN 'statement' ELSE NULL END,
    'reconciliation', CASE WHEN v_rec.account_code IS NULL THEN NULL ELSE to_jsonb(v_rec) END,
    'can_post', public.has_permission(v_uid, 'post_journal'),
    'profile', (SELECT to_jsonb(pr) FROM public.bank_import_profiles pr WHERE pr.account_code = p_account),
    'imports', coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.imported_at DESC) FROM public.bank_statement_imports i
                          WHERE i.account_code = p_account AND (i.period_to >= p_month - 31 OR i.period_to IS NULL) AND (i.period_from <= v_end + 31 OR i.period_from IS NULL)), '[]'::jsonb),
    'matched_count', (SELECT count(*) FROM public.bank_statement_lines s JOIN public.bank_statement_imports i ON i.id = s.import_id
                       WHERE s.account_code = p_account AND i.voided_at IS NULL AND date_trunc('month', s.booked_on)::date = p_month AND s.match_kind IN ('auto', 'manual')),
    'ignored', coalesce((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'booked_on', s.booked_on, 'description', s.description, 'amount', s.amount, 'reason', s.ignore_reason) ORDER BY s.booked_on, s.line_no)
                          FROM public.bank_statement_lines s JOIN public.bank_statement_imports i ON i.id = s.import_id
                         WHERE s.account_code = p_account AND i.voided_at IS NULL AND date_trunc('month', s.booked_on)::date = p_month AND s.match_kind = 'ignored'), '[]'::jsonb),
    'unmatched_statement', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'booked_on', s.booked_on, 'description', s.description, 'amount', s.amount, 'balance_after', s.balance_after,
               'candidates', coalesce((
                 SELECT jsonb_agg(jsonb_build_object('journal_line_id', m.id, 'journal_no', m.journal_no, 'entry_date', m.entry_date, 'source_type', m.source_type,
                                                     'description', m.description, 'memo', m.memo, 'signed_amount', m.signed_amount) ORDER BY abs(m.entry_date - s.booked_on), m.journal_no)
                   FROM public.gl_live_money_lines m
                  WHERE m.account_code = p_account AND m.signed_amount = s.amount AND m.kind <> 'opening' AND abs(m.entry_date - s.booked_on) <= 31
                    AND NOT EXISTS (SELECT 1 FROM public.bank_statement_lines x WHERE x.matched_journal_line_id = m.id)), '[]'::jsonb)) ORDER BY s.booked_on, s.line_no)
        FROM public.bank_statement_lines s JOIN public.bank_statement_imports i ON i.id = s.import_id
       WHERE s.account_code = p_account AND i.voided_at IS NULL AND date_trunc('month', s.booked_on)::date = p_month AND s.match_kind IS NULL), '[]'::jsonb),
    'unmatched_ledger', coalesce((
      SELECT jsonb_agg(jsonb_build_object('journal_line_id', m.id, 'journal_no', m.journal_no, 'entry_date', m.entry_date, 'source_type', m.source_type,
                                          'description', m.description, 'memo', m.memo, 'signed_amount', m.signed_amount, 'signed_jpy', m.signed_jpy,
                                          'customer_id', m.customer_id, 'account_id', m.account_id, 'cash_order_id', m.cash_order_id, 'expense_id', m.expense_id) ORDER BY m.entry_date, m.journal_no)
        FROM public.gl_live_money_lines m
       WHERE m.account_code = p_account AND m.entry_date BETWEEN p_month AND v_end AND m.kind <> 'opening'
         AND NOT EXISTS (SELECT 1 FROM public.bank_statement_lines x WHERE x.matched_journal_line_id = m.id)), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_bank_reconciliation(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_bank_reconciliation(text, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.sign_off_reconciliation(p_account text, p_month date, p_statement_closing numeric, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_end date;
  v_today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_native numeric; v_jpy numeric;
  v_diff numeric;
  v_unm_stmt int; v_unm_ledger int; v_unm_ledger_old int;
  v_is_cash boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'post_journal') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF NOT public.gl_is_money_account(p_account) THEN RETURN jsonb_build_object('error', 'invalid_account'); END IF;
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN RETURN jsonb_build_object('error', 'invalid_period'); END IF;
  v_end := (p_month + interval '1 month' - interval '1 day')::date;
  IF v_end >= v_today THEN RETURN jsonb_build_object('error', 'period_not_ended'); END IF;
  IF p_statement_closing IS NULL THEN RETURN jsonb_build_object('error', 'invalid_amount'); END IF;
  IF EXISTS (SELECT 1 FROM public.bank_reconciliations r WHERE r.account_code = p_account AND r.month_start = p_month AND r.status = 'reconciled') THEN
    RETURN jsonb_build_object('error', 'already_reconciled');
  END IF;
  v_is_cash := coalesce((SELECT a.system_key IN ('cash_jpy', 'cash_php') FROM public.gl_accounts a WHERE a.code = p_account), false);
  SELECT coalesce(sum(m.signed_amount), 0), coalesce(sum(m.signed_jpy), 0) INTO v_native, v_jpy
    FROM public.gl_live_money_lines m WHERE m.account_code = p_account AND m.entry_date <= v_end;
  v_diff := round(p_statement_closing, 2) - round(v_native, 2);
  SELECT count(*) INTO v_unm_stmt FROM public.bank_statement_lines s JOIN public.bank_statement_imports i ON i.id = s.import_id
   WHERE s.account_code = p_account AND i.voided_at IS NULL AND date_trunc('month', s.booked_on)::date = p_month AND s.match_kind IS NULL;
  SELECT count(*), count(*) FILTER (WHERE m.entry_date <= v_end - 5) INTO v_unm_ledger, v_unm_ledger_old FROM public.gl_live_money_lines m
   WHERE m.account_code = p_account AND m.entry_date BETWEEN p_month AND v_end AND m.kind <> 'opening'
     AND NOT EXISTS (SELECT 1 FROM public.bank_statement_lines x WHERE x.matched_journal_line_id = m.id);
  INSERT INTO public.bank_reconciliations (account_code, month_start, statement_closing, ledger_closing_native, ledger_closing_jpy, difference, unmatched_statement, unmatched_ledger, status, note, updated_at)
  VALUES (p_account, p_month, round(p_statement_closing, 2), v_native, v_jpy, v_diff, v_unm_stmt, v_unm_ledger, 'open', nullif(btrim(coalesce(p_note, '')), ''), now())
  ON CONFLICT (account_code, month_start) DO UPDATE SET statement_closing = EXCLUDED.statement_closing, ledger_closing_native = EXCLUDED.ledger_closing_native,
     ledger_closing_jpy = EXCLUDED.ledger_closing_jpy, difference = EXCLUDED.difference, unmatched_statement = EXCLUDED.unmatched_statement,
     unmatched_ledger = EXCLUDED.unmatched_ledger, note = coalesce(EXCLUDED.note, public.bank_reconciliations.note), updated_at = now();
  IF v_diff <> 0 THEN
    RETURN jsonb_build_object('error', 'difference_remains', 'difference', v_diff, 'ledger_closing_native', v_native, 'statement_closing', round(p_statement_closing, 2));
  END IF;
  IF NOT v_is_cash AND v_unm_stmt > 0 THEN
    RETURN jsonb_build_object('error', 'unmatched_statement_lines', 'count', v_unm_stmt);
  END IF;
  IF NOT v_is_cash AND v_unm_ledger_old > 0 THEN
    RETURN jsonb_build_object('error', 'unmatched_ledger_lines', 'count', v_unm_ledger_old);
  END IF;
  UPDATE public.bank_reconciliations SET status = 'reconciled', reconciled_by = v_uid, reconciled_at = now(), updated_at = now()
   WHERE account_code = p_account AND month_start = p_month;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('bank_reconciliation', gen_random_uuid(), 'sign_off_reconciliation',
          jsonb_build_object('account', p_account, 'month', p_month, 'statement_closing', round(p_statement_closing, 2), 'ledger_closing_native', v_native,
                             'unmatched_statement', v_unm_stmt, 'unmatched_ledger', v_unm_ledger), v_uid, now());
  RETURN jsonb_build_object('ok', true, 'reconciliation', (SELECT to_jsonb(r) FROM public.bank_reconciliations r WHERE r.account_code = p_account AND r.month_start = p_month));
END
$fn$;
REVOKE ALL ON FUNCTION public.sign_off_reconciliation(text, date, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sign_off_reconciliation(text, date, numeric, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reopen_reconciliation(p_account text, p_month date, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'post_journal') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN RETURN jsonb_build_object('error', 'reason_required'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bank_reconciliations r WHERE r.account_code = p_account AND r.month_start = p_month AND r.status = 'reconciled') THEN
    RETURN jsonb_build_object('error', 'not_reconciled');
  END IF;
  IF public.gl_period_is_closed(p_month) THEN RETURN jsonb_build_object('error', 'period_closed'); END IF;
  UPDATE public.bank_reconciliations SET status = 'open', reconciled_by = NULL, reconciled_at = NULL, note = left(btrim(p_reason), 500), updated_at = now()
   WHERE account_code = p_account AND month_start = p_month;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('bank_reconciliation', gen_random_uuid(), 'reopen_reconciliation', jsonb_build_object('account', p_account, 'month', p_month, 'reason', btrim(p_reason)), v_uid, now());
  RETURN jsonb_build_object('ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.reopen_reconciliation(text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reopen_reconciliation(text, date, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Shared helpers for the status strip, the readiness report and the nightly check.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gl_unmapped_methods(p_start date)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  SELECT coalesce((
    SELECT jsonb_agg(jsonb_build_object('spelling', x.m, 'rows', x.n, 'first_seen', x.d) ORDER BY x.n DESC)
      FROM (
        SELECT lower(btrim(m)) AS m, count(*) AS n, min(d) AS d FROM (
          SELECT p.payment_method AS m, p.date_paid AS d FROM public.payments p WHERE p.voided_at IS NULL AND (p_start IS NULL OR p.date_paid >= p_start)
          UNION ALL
          SELECT cp.payment_method, cp.date_paid FROM public.cash_payments cp WHERE cp.voided_at IS NULL AND (p_start IS NULL OR cp.date_paid >= p_start)
          UNION ALL
          SELECT co.payment_method, (co.refund_decided_at AT TIME ZONE 'Asia/Tokyo')::date FROM public.cash_orders co
           WHERE co.refund_status = 'refund_issued' AND co.refund_decided_at IS NOT NULL
             AND (p_start IS NULL OR (co.refund_decided_at AT TIME ZONE 'Asia/Tokyo')::date >= p_start)
        ) u
        WHERE lower(btrim(coalesce(m, ''))) <> ''
          AND NOT EXISTS (SELECT 1 FROM public.gl_payment_method_map mm WHERE mm.spelling = lower(btrim(u.m)) AND mm.kind <> 'suspense')
        GROUP BY 1) x), '[]'::jsonb)
$fn$;
REVOKE ALL ON FUNCTION public.gl_unmapped_methods(date) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.gl_expenses_without_paid_from(p_start date)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  SELECT coalesce((
    SELECT jsonb_agg(jsonb_build_object('id', e.id, 'expense_date', e.expense_date, 'description', e.description, 'amount', e.amount,
                                        'currency', e.currency, 'payment_method', e.payment_method, 'source', e.source, 'approved_at', e.approved_at) ORDER BY e.expense_date DESC)
      FROM public.expenses e
     WHERE e.status = 'approved' AND e.paid_from IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.gl_payment_method_map mm WHERE mm.spelling = lower(btrim(e.payment_method)) AND mm.kind = 'cash')
       AND (p_start IS NULL OR e.expense_date >= p_start)), '[]'::jsonb)
$fn$;
REVOKE ALL ON FUNCTION public.gl_expenses_without_paid_from(date) FROM PUBLIC, anon, authenticated;

-- Money accounts with movements in a month that have no reconciliation signed off.
CREATE OR REPLACE FUNCTION public.gl_unreconciled_accounts(p_month date)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  SELECT coalesce((
    SELECT jsonb_agg(jsonb_build_object('code', a.code, 'name', a.name, 'name_ja', a.name_ja, 'lines', x.n,
                                        'status', coalesce((SELECT r.status FROM public.bank_reconciliations r WHERE r.account_code = a.code AND r.month_start = p_month), 'none')) ORDER BY a.code)
      FROM public.gl_accounts a
      JOIN (SELECT l.account_code, count(*) AS n FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id
             WHERE j.entry_date BETWEEN p_month AND (p_month + interval '1 month' - interval '1 day')::date GROUP BY 1) x ON x.account_code = a.code
     WHERE a.kind = 'asset' AND a.active AND a.code < '1130'
       AND NOT EXISTS (SELECT 1 FROM public.bank_reconciliations r WHERE r.account_code = a.code AND r.month_start = p_month AND r.status = 'reconciled')), '[]'::jsonb)
$fn$;
REVOKE ALL ON FUNCTION public.gl_unreconciled_accounts(date) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Close readiness (D1) and close_period re-stated.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gl_close_readiness(p_period_start date, p_dry_run boolean)
RETURNS jsonb
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_start date := public.gl_ledger_start();
  v_end date := (p_period_start + interval '1 month' - interval '1 day')::date;
  v_dry jsonb;
  v_unbalanced int; v_duplicates int;
  v_drafts int;
  v_suspense numeric;
  v_unmapped jsonb; v_no_paid_from jsonb; v_unrec jsonb;
  v_errors int := 0; v_warnings int := 0;
BEGIN
  v_dry := CASE WHEN p_dry_run AND v_start IS NOT NULL THEN public.gl_post_pending(true, 'manual', NULL) ELSE NULL END;
  SELECT count(*) INTO v_unbalanced FROM (
    SELECT j.id FROM public.gl_journals j JOIN public.gl_journal_lines l ON l.journal_id = j.id
     WHERE j.entry_date BETWEEN p_period_start AND v_end
     GROUP BY j.id HAVING sum(l.debit_jpy) <> sum(l.credit_jpy) OR count(*) < 2) x;
  SELECT count(*) INTO v_duplicates FROM (
    SELECT j.source_type, j.source_id FROM public.gl_journals j
     WHERE j.kind = 'auto' AND j.status = 'posted' AND j.source_id IS NOT NULL
     GROUP BY 1, 2 HAVING count(*) > 1) x;
  SELECT count(*) INTO v_drafts FROM public.expenses e WHERE e.status = 'draft' AND e.expense_date BETWEEN p_period_start AND v_end;
  SELECT coalesce(sum(l.debit_jpy - l.credit_jpy), 0) INTO v_suspense
    FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id
   WHERE l.account_code IN ('1190', '1195') AND j.entry_date <= v_end;
  v_unmapped := public.gl_unmapped_methods(v_start);
  v_no_paid_from := public.gl_expenses_without_paid_from(v_start);
  v_unrec := public.gl_unreconciled_accounts(p_period_start);
  v_errors := v_unbalanced + v_duplicates + coalesce((v_dry->>'pending')::int, 0) + coalesce((v_dry->>'failed')::int, 0);
  v_warnings := jsonb_array_length(v_unmapped) + jsonb_array_length(v_no_paid_from) + v_drafts + jsonb_array_length(v_unrec) + CASE WHEN v_suspense <> 0 THEN 1 ELSE 0 END;
  RETURN jsonb_build_object(
    'period_start', p_period_start, 'period_end', v_end,
    'errors', v_errors, 'warnings', v_warnings, 'can_close', v_errors = 0,
    'unposted_events', coalesce((v_dry->>'pending')::int, 0), 'posting_failed', coalesce((v_dry->>'failed')::int, 0), 'dry_run', v_dry IS NOT NULL,
    'unbalanced_journals', v_unbalanced, 'duplicate_journals', v_duplicates,
    'unmapped_methods', v_unmapped, 'expenses_without_paid_from', v_no_paid_from, 'draft_expenses', v_drafts,
    'unreconciled_accounts', v_unrec, 'suspense_jpy', v_suspense);
END
$fn$;
REVOKE ALL ON FUNCTION public.gl_close_readiness(date, boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_close_readiness(p_period_start date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'view_ledger') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_period_start IS NULL OR p_period_start <> date_trunc('month', p_period_start)::date THEN RETURN jsonb_build_object('error', 'invalid_period'); END IF;
  RETURN public.gl_close_readiness(p_period_start, true);
END
$fn$;
REVOKE ALL ON FUNCTION public.get_close_readiness(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_close_readiness(date) TO authenticated;
COMMENT ON FUNCTION public.get_close_readiness(date) IS
  'Phase 8 (D1): what is still open before a month is closed — unposted events (dry run), posting failures, unbalanced / duplicate journals (errors, block the close); unmapped payment spellings, approved expenses without Paid from, draft expenses in the month, money accounts not reconciled, suspense balance (warnings, listed and recorded). view_ledger.';

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
  v_ready jsonb;
  v_note text;
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
  v_run := public.gl_post_settled('manual', v_uid);
  IF coalesce((v_run->>'failed')::int, 0) > 0 THEN
    RETURN jsonb_build_object('error', 'posting_failed', 'run', v_run);
  END IF;
  v_ready := public.gl_close_readiness(v_period, true);
  IF (v_ready->>'errors')::int > 0 THEN
    RETURN jsonb_build_object('error', 'ledger_errors', 'readiness', v_ready);
  END IF;
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  IF (v_ready->>'warnings')::int > 0 THEN
    v_note := left(coalesce(v_note || ' | ', '') || 'Closed with ' || (v_ready->>'warnings') || ' open item(s): '
              || jsonb_array_length(v_ready->'unmapped_methods') || ' unmapped spelling(s), '
              || jsonb_array_length(v_ready->'expenses_without_paid_from') || ' expense(s) without Paid from, '
              || (v_ready->>'draft_expenses') || ' draft expense(s), '
              || jsonb_array_length(v_ready->'unreconciled_accounts') || ' account(s) not reconciled'
              || CASE WHEN (v_ready->>'suspense_jpy')::numeric <> 0 THEN ', suspense balance' ELSE '' END, 1000);
  END IF;
  UPDATE public.gl_periods SET status = 'closed', closed_at = now(), closed_by = v_uid, note = v_note, updated_at = now()
   WHERE period_start = v_period;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('gl_period', gen_random_uuid(), 'close_period', jsonb_build_object('period_start', v_period, 'note', v_note, 'readiness', v_ready - 'unmapped_methods' - 'expenses_without_paid_from' - 'unreconciled_accounts'), v_uid, now());
  RETURN jsonb_build_object('ok', true, 'period', (SELECT to_jsonb(gp) FROM public.gl_periods gp WHERE gp.period_start = v_period), 'readiness', v_ready);
END
$fn$;
REVOKE ALL ON FUNCTION public.close_period(date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_period(date, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Nightly completeness check (D5).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gl_check_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at      timestamptz NOT NULL DEFAULT now(),
  trigger     text NOT NULL CHECK (trigger IN ('cron', 'manual')),
  run_by      uuid NULL,
  errors      integer NOT NULL DEFAULT 0,
  warnings    integer NOT NULL DEFAULT 0,
  issues      jsonb NOT NULL DEFAULT '[]'::jsonb,
  bell_rung   boolean NOT NULL DEFAULT false,
  duration_ms integer NULL
);
CREATE INDEX IF NOT EXISTS gl_check_runs_ran_idx ON public.gl_check_runs (ran_at DESC);
ALTER TABLE public.gl_check_runs ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.gl_check_runs IS
  'Phase 8: one row per completeness check (nightly 01:10 JST or "Run check now"). issues = [{kind, severity, ref, label, link}]; the staff bell rings when errors > 0 or a warning is new since the previous run.';
DROP POLICY IF EXISTS gl_check_runs_read ON public.gl_check_runs;
CREATE POLICY gl_check_runs_read ON public.gl_check_runs FOR SELECT TO authenticated
  USING ((SELECT public.has_permission((SELECT auth.uid()), 'view_ledger')));
REVOKE ALL ON public.gl_check_runs FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.gl_check_runs FROM authenticated;
GRANT SELECT ON public.gl_check_runs TO authenticated;

CREATE OR REPLACE FUNCTION public.gl_run_completeness_check(p_trigger text, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_t0 timestamptz := clock_timestamp();
  v_start date := public.gl_ledger_start();
  v_today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_issues jsonb := '[]'::jsonb;
  v_dry jsonb;
  v_prev jsonb;
  v_errors int; v_warnings int;
  v_new_warnings int;
  v_bell boolean := false;
  v_id uuid;
  r record;
  n int;
  v_bal numeric;
BEGIN
  IF v_start IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'started', false, 'reason', 'ledger_start_not_set');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('gl_completeness_check'));

  v_dry := public.gl_post_pending(true, 'manual', p_user_id);
  IF coalesce((v_dry->>'posted')::int, 0) > 0 THEN
    v_issues := v_issues || jsonb_build_object('kind', 'unposted', 'severity', 'error', 'ref', NULL, 'count', (v_dry->>'posted')::int,
      'label', (v_dry->>'posted') || ' event(s) have no journal yet (the nightly posting did not run or keeps failing)', 'link', jsonb_build_object('view', 'journals'));
  END IF;
  IF coalesce((v_dry->>'reversed')::int, 0) > 0 THEN
    v_issues := v_issues || jsonb_build_object('kind', 'orphan', 'severity', 'error', 'ref', NULL, 'count', (v_dry->>'reversed')::int,
      'label', (v_dry->>'reversed') || ' journal(s) no longer match their source and await reversal', 'link', jsonb_build_object('view', 'journals'));
  END IF;
  SELECT * INTO r FROM public.gl_posting_runs pr ORDER BY pr.started_at DESC LIMIT 1;
  IF r.id IS NOT NULL AND r.failed > 0 THEN
    v_issues := v_issues || jsonb_build_object('kind', 'posting_failed', 'severity', 'error', 'ref', r.id::text, 'count', r.failed,
      'label', 'The last posting run failed on ' || r.failed || ' event(s): ' || coalesce(split_part(r.note, E'\n', 1), ''), 'link', jsonb_build_object('view', 'journals'));
  END IF;

  FOR r IN SELECT j.source_type, j.source_id, count(*) AS n FROM public.gl_journals j
            WHERE j.kind = 'auto' AND j.status = 'posted' AND j.source_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1
  LOOP
    v_issues := v_issues || jsonb_build_object('kind', 'duplicate', 'severity', 'error', 'ref', r.source_type || ' ' || r.source_id, 'count', r.n,
      'label', r.n || ' live journals for one ' || r.source_type || ' event', 'link', jsonb_build_object('view', 'journals', 'source_type', r.source_type, 'source_id', r.source_id));
  END LOOP;

  FOR r IN SELECT j.id, j.journal_no, j.entry_date, sum(l.debit_jpy) AS dr, sum(l.credit_jpy) AS cr, count(l.id) AS lines
             FROM public.gl_journals j LEFT JOIN public.gl_journal_lines l ON l.journal_id = j.id
            GROUP BY j.id, j.journal_no, j.entry_date HAVING coalesce(sum(l.debit_jpy), 0) <> coalesce(sum(l.credit_jpy), 0) OR count(l.id) < 2
            ORDER BY j.journal_no LIMIT 50
  LOOP
    v_issues := v_issues || jsonb_build_object('kind', 'unbalanced', 'severity', 'error', 'ref', '#' || r.journal_no, 'count', 1,
      'label', 'Journal #' || r.journal_no || ' (' || r.entry_date || '): debits ' || coalesce(r.dr, 0) || ' ≠ credits ' || coalesce(r.cr, 0) || CASE WHEN r.lines < 2 THEN ' (fewer than two lines)' ELSE '' END,
      'link', jsonb_build_object('view', 'journals', 'journal_no', r.journal_no));
  END LOOP;

  SELECT coalesce(sum(l.debit_jpy), 0) - coalesce(sum(l.credit_jpy), 0) INTO v_bal FROM public.gl_journal_lines l;
  IF v_bal <> 0 THEN
    v_issues := v_issues || jsonb_build_object('kind', 'trial_balance', 'severity', 'error', 'ref', NULL, 'count', 1,
      'label', 'The trial balance does not balance: debits − credits = ' || v_bal || ' yen', 'link', jsonb_build_object('view', 'trial'));
  END IF;

  SELECT count(*) INTO n FROM public.gl_journals j WHERE j.posted_at >= now() - interval '24 hours' AND j.entry_date <> j.source_date AND j.status = 'posted';
  IF n > 0 THEN
    v_issues := v_issues || jsonb_build_object('kind', 'late_posting', 'severity', 'warning', 'ref', v_today::text, 'count', n,
      'label', n || ' journal(s) posted in the last day belong to a closed month and landed in the open one (original date kept)', 'link', jsonb_build_object('view', 'journals'));
  END IF;

  FOR r IN SELECT m::date AS month_start FROM generate_series(date_trunc('month', v_start)::date, date_trunc('month', v_today)::date - interval '1 month', interval '1 month') m
            WHERE (m + interval '1 month' - interval '1 day')::date <= v_today - 10
              AND NOT EXISTS (SELECT 1 FROM public.gl_periods gp WHERE gp.period_start = m::date AND gp.status = 'closed')
  LOOP
    v_issues := v_issues || jsonb_build_object('kind', 'month_open', 'severity', 'warning', 'ref', to_char(r.month_start, 'YYYY-MM'), 'count', 1,
      'label', to_char(r.month_start, 'FMMonth YYYY') || ' ended more than 10 days ago and is still open', 'link', jsonb_build_object('view', 'periods', 'month', to_char(r.month_start, 'YYYY-MM')));
  END LOOP;

  FOR r IN SELECT l.account_code, sum(l.debit_jpy - l.credit_jpy) AS bal, min(j.entry_date) AS oldest
             FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id
            WHERE l.account_code IN ('1190', '1195') GROUP BY 1 HAVING sum(l.debit_jpy - l.credit_jpy) <> 0 AND min(j.entry_date) <= v_today - 30
  LOOP
    v_issues := v_issues || jsonb_build_object('kind', 'suspense', 'severity', 'warning', 'ref', r.account_code, 'count', 1,
      'label', 'Account ' || r.account_code || ' still carries ' || r.bal || ' yen older than 30 days (map the spelling or set Paid from)', 'link', jsonb_build_object('view', 'journals', 'account', r.account_code));
  END LOOP;

  SELECT count(*) INTO n FROM public.expenses e WHERE e.status = 'approved' AND e.paid_from IS NULL AND e.approved_at <= now() - interval '7 days'
     AND NOT EXISTS (SELECT 1 FROM public.gl_payment_method_map mm WHERE mm.spelling = lower(btrim(e.payment_method)) AND mm.kind = 'cash');
  IF n > 0 THEN
    v_issues := v_issues || jsonb_build_object('kind', 'expense_paid_from', 'severity', 'warning', 'ref', NULL, 'count', n,
      'label', n || ' approved expense(s) have had no Paid from account for over a week', 'link', jsonb_build_object('view', 'expenses'));
  END IF;
  SELECT count(*) INTO n FROM public.expenses e WHERE e.status = 'draft' AND e.expense_date <= v_today - 14;
  IF n > 0 THEN
    v_issues := v_issues || jsonb_build_object('kind', 'expense_draft', 'severity', 'warning', 'ref', NULL, 'count', n,
      'label', n || ' expense draft(s) dated more than two weeks ago are still waiting for approval', 'link', jsonb_build_object('view', 'expenses'));
  END IF;

  n := jsonb_array_length(public.gl_unmapped_methods(v_start));
  IF n > 0 THEN
    v_issues := v_issues || jsonb_build_object('kind', 'unmapped_method', 'severity', 'warning', 'ref', NULL, 'count', n,
      'label', n || ' payment spelling(s) are not mapped to an account (posted to 1190)', 'link', jsonb_build_object('view', 'accounts'));
  END IF;

  FOR r IN SELECT m::date AS month_start FROM generate_series(date_trunc('month', v_start)::date, date_trunc('month', v_today)::date - interval '1 month', interval '1 month') m
            WHERE (m + interval '1 month' - interval '1 day')::date <= v_today - 15
  LOOP
    n := jsonb_array_length(public.gl_unreconciled_accounts(r.month_start));
    IF n > 0 THEN
      v_issues := v_issues || jsonb_build_object('kind', 'reconciliation', 'severity', 'warning', 'ref', to_char(r.month_start, 'YYYY-MM'), 'count', n,
        'label', n || ' money account(s) with movements in ' || to_char(r.month_start, 'FMMonth YYYY') || ' are not reconciled', 'link', jsonb_build_object('view', 'bankrec', 'month', to_char(r.month_start, 'YYYY-MM')));
    END IF;
  END LOOP;

  SELECT count(*) FILTER (WHERE x->>'severity' = 'error'), count(*) FILTER (WHERE x->>'severity' = 'warning') INTO v_errors, v_warnings FROM jsonb_array_elements(v_issues) x;
  SELECT cr.issues INTO v_prev FROM public.gl_check_runs cr ORDER BY cr.ran_at DESC LIMIT 1;
  SELECT count(*) INTO v_new_warnings FROM jsonb_array_elements(v_issues) x
   WHERE x->>'severity' = 'warning'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v_prev, '[]'::jsonb)) y WHERE y->>'kind' = x->>'kind' AND coalesce(y->>'ref', '') = coalesce(x->>'ref', ''));
  v_bell := v_errors > 0 OR v_new_warnings > 0;
  INSERT INTO public.gl_check_runs (trigger, run_by, errors, warnings, issues, bell_rung, duration_ms)
  VALUES (p_trigger, p_user_id, v_errors, v_warnings, v_issues, v_bell, (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::int)
  RETURNING id INTO v_id;
  IF v_bell THEN
    INSERT INTO public.staff_notifications (type, title, body, metadata)
    VALUES ('ledger_check', 'Ledger check: ' || (v_errors + v_warnings) || ' issue' || CASE WHEN v_errors + v_warnings = 1 THEN '' ELSE 's' END,
            CASE WHEN v_errors > 0 THEN v_errors || ' need attention before the month can close. ' ELSE '' END || 'Open Finance → Ledger → Checks.',
            jsonb_build_object('run_id', v_id, 'errors', v_errors, 'warnings', v_warnings, 'new_warnings', v_new_warnings));
  END IF;
  RETURN jsonb_build_object('ok', true, 'started', true, 'run_id', v_id, 'errors', v_errors, 'warnings', v_warnings, 'new_warnings', v_new_warnings, 'bell_rung', v_bell, 'issues', v_issues);
END
$fn$;
REVOKE ALL ON FUNCTION public.gl_run_completeness_check(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gl_run_completeness_check(text, uuid) TO service_role;
COMMENT ON FUNCTION public.gl_run_completeness_check(text, uuid) IS
  'Phase 8 (D5): the nightly ledger check (cron gl-completeness-check 16:10 UTC) and "Run check now". Errors: unposted / orphan events (dry run), a failed posting run, duplicate journals, unbalanced journals, trial balance off. Warnings: late postings into the open month, months open > 10 days after their end, suspense balances > 30 days, approved expenses without Paid from > 7 days, drafts > 14 days, unmapped spellings, money accounts not reconciled 15 days after month end. One staff bell (no amounts) when errors > 0 or a warning is new.';

CREATE OR REPLACE FUNCTION public.run_ledger_check()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'post_journal') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  RETURN public.gl_run_completeness_check('manual', v_uid);
END
$fn$;
REVOKE ALL ON FUNCTION public.run_ledger_check() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_ledger_check() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_ledger_checks(p_limit integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'view_ledger') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  RETURN jsonb_build_object(
    'can_post', public.has_permission(v_uid, 'post_journal'),
    'latest', (SELECT to_jsonb(cr) FROM public.gl_check_runs cr ORDER BY cr.ran_at DESC LIMIT 1),
    'runs', coalesce((SELECT jsonb_agg(to_jsonb(cr) - 'issues' ORDER BY cr.ran_at DESC) FROM (SELECT * FROM public.gl_check_runs ORDER BY ran_at DESC LIMIT greatest(1, least(coalesce(p_limit, 30), 200))) cr), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_ledger_checks(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ledger_checks(integer) TO authenticated;

DO $c$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'gl-completeness-check') THEN
      PERFORM cron.unschedule('gl-completeness-check');
    END IF;
    PERFORM cron.schedule('gl-completeness-check', '10 16 * * *', $job$ SELECT public.gl_run_completeness_check('cron', NULL); $job$);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'gl-completeness-check cron schedule skipped: %', SQLERRM;
END $c$;

-- ---------------------------------------------------------------------------
-- 7. get_ledger_status re-stated: last check run + reconciliation counts per month.
-- ---------------------------------------------------------------------------
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
    'fiscal_year_start_month', coalesce((SELECT (value #>> '{}')::int FROM public.system_settings WHERE key = 'fiscal_year_start_month'), 4),
    'php_jpy_rate', public.gl_rate(),
    'can_post', public.has_permission(v_uid, 'post_journal'),
    'can_close', public.has_permission(v_uid, 'close_period'),
    'can_admin', public.has_permission(v_uid, 'admin_settings'),
    'pending', v_pending,
    'last_run', (SELECT to_jsonb(r) FROM public.gl_posting_runs r ORDER BY r.started_at DESC LIMIT 1),
    'last_check', (SELECT to_jsonb(cr) - 'issues' FROM public.gl_check_runs cr ORDER BY cr.ran_at DESC LIMIT 1),
    'journal_count', (SELECT count(*) FROM public.gl_journals),
    'moved_count', (SELECT count(*) FROM public.gl_journals WHERE entry_date <> source_date AND status = 'posted'),
    'unmapped_methods', public.gl_unmapped_methods(v_start),
    'expenses_without_paid_from', public.gl_expenses_without_paid_from(v_start),
    'periods', coalesce((
      SELECT jsonb_agg(to_jsonb(p) || jsonb_build_object(
               'reconciled_accounts', (SELECT count(*) FROM public.bank_reconciliations r WHERE r.month_start = p.period_start AND r.status = 'reconciled'),
               'unreconciled_accounts', jsonb_array_length(public.gl_unreconciled_accounts(p.period_start))) ORDER BY p.period_start DESC)
        FROM public.gl_periods p), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_ledger_status(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ledger_status(boolean) TO authenticated;
