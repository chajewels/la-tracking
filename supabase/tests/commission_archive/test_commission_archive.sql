-- People (from ../payslips/stubs.sql): admin A (..0a), Brenda B (..0b, can_view_all), CSR C (..0c), finance F (..0f), staff S (..05).
\set A '00000000-0000-0000-0000-00000000000a'
\set B '00000000-0000-0000-0000-00000000000b'
\set C '00000000-0000-0000-0000-00000000000c'
\set F '00000000-0000-0000-0000-00000000000f'
\set S '00000000-0000-0000-0000-000000000005'

CREATE FUNCTION public.t_ok(p_name text, p_cond boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAILED: %', p_name; END IF;
  RAISE NOTICE 'C % ok', p_name;
END $$;

-- ===== C1. shape =====
SELECT public.t_ok('C1 cutoff_day column is nullable smallint',
  (SELECT data_type = 'smallint' AND is_nullable = 'YES' FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'commission_splits' AND column_name = 'cutoff_day'));
SELECT public.t_ok('C1 every existing split is still end-of-month (NULL)',
  (SELECT count(*) = 0 FROM public.commission_splits WHERE cutoff_day IS NOT NULL));
SELECT public.t_ok('C1 cutoff_day 0 refused', (SELECT public.t_as(:'A', 'postgres', $$INSERT INTO public.commission_splits (month, cutoff_day) VALUES ('2099-01-01', 0)$$) = '23514'));
SELECT public.t_ok('C1 cutoff_day 29 refused', (SELECT public.t_as(:'A', 'postgres', $$INSERT INTO public.commission_splits (month, cutoff_day) VALUES ('2099-01-01', 29)$$) = '23514'));
SELECT public.t_ok('C1 trigger exists on sales_log, row-level, before insert/update/delete',
  (SELECT count(*) = 1 FROM pg_trigger WHERE tgrelid = 'public.sales_log'::regclass AND tgname = 'sales_log_archive_guard'
     AND tgtype & 1 = 1 AND tgtype & 2 = 2 AND tgtype & 4 = 4 AND tgtype & 8 = 8 AND tgtype & 16 = 16));
SELECT public.t_ok('C1 the guard never assigns to NEW',
  (SELECT prosrc !~ 'NEW\.[a-z_]+\s*:=' AND prosrc !~ 'NEW\s*:=' FROM pg_proc WHERE proname = 'sales_log_archive_guard'));
SELECT public.t_ok('C1 autocheck_sales_log_eligible is the baseline body (untouched)',
  (SELECT md5(prosrc) = :'autocheck_md5' FROM pg_proc WHERE proname = 'autocheck_sales_log_eligible'));
SELECT public.t_ok('C1 anon cannot run the period functions or the guard',
  NOT has_function_privilege('anon', 'public.commission_period_month(date)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.commission_period_is_closed(date)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.sales_log_archive_guard()', 'EXECUTE'));

-- Configuration used below: April 2026 (calendar months), then November 2026 with cut-off 20 (inherits to Dec...).
INSERT INTO public.commission_splits (month) VALUES ('2026-04-01');
INSERT INTO public.commission_splits (month, cutoff_day) VALUES ('2026-11-01', 20);

-- ===== C2. period month =====
SELECT public.t_ok('C2 Sep 30 -> Sep', public.commission_period_month('2026-09-30') = '2026-09-01');
SELECT public.t_ok('C2 Oct 1 and Oct 31 -> Oct', public.commission_period_month('2026-10-01') = '2026-10-01' AND public.commission_period_month('2026-10-31') = '2026-10-01');
SELECT public.t_ok('C2 Nov 1 and Nov 20 -> Nov', public.commission_period_month('2026-11-01') = '2026-11-01' AND public.commission_period_month('2026-11-20') = '2026-11-01');
SELECT public.t_ok('C2 Nov 21 and Nov 30 -> Dec', public.commission_period_month('2026-11-21') = '2026-12-01' AND public.commission_period_month('2026-11-30') = '2026-12-01');
SELECT public.t_ok('C2 Dec 1 and Dec 20 -> Dec (Dec inherits Nov)', public.commission_period_month('2026-12-01') = '2026-12-01' AND public.commission_period_month('2026-12-20') = '2026-12-01');
SELECT public.t_ok('C2 Dec 21 -> Jan 2027', public.commission_period_month('2026-12-21') = '2027-01-01');
SELECT public.t_ok('C2 before any split -> own month', public.commission_period_month('2025-06-30') = '2025-06-01');

-- ===== C3. closing (Philippine date) =====
SELECT public.t_clock('2026-10-31 15:59:59+00');
SELECT public.t_ok('C3 Oct is still open on Oct 31 (PH)', public.commission_period_is_closed('2026-10-15') = false);
SELECT public.t_clock('2026-10-31 16:00:00+00');
SELECT public.t_ok('C3 Oct closes on Nov 1 (PH)', public.commission_period_is_closed('2026-10-15') = true);
SELECT public.t_ok('C3 Nov 1-20 is open on Nov 1', public.commission_period_is_closed('2026-11-05') = false);
SELECT public.t_clock('2026-11-20 15:59:59+00');
SELECT public.t_ok('C3 Nov 1-20 is still open on Nov 20 (PH)', public.commission_period_is_closed('2026-11-05') = false);
SELECT public.t_clock('2026-11-20 16:00:00+00');
SELECT public.t_ok('C3 Nov 1-20 closes on Nov 21 (PH)', public.commission_period_is_closed('2026-11-05') = true);
SELECT public.t_ok('C3 Nov 21 sale (December) is open on Nov 21', public.commission_period_is_closed('2026-11-25') = false);
SELECT public.t_ok('C3 NULL date is not closed', public.commission_period_is_closed(NULL) = false);
-- From here the clock is Nov 5 2026 (PH): Sep and Oct are CLOSED, Nov 1-20 is OPEN.
SELECT public.t_clock('2026-11-05 03:00:00+00');

-- ===== C4. automatic writers keep working on archived sales =====
INSERT INTO public.sales_log (sale_date, invoice_number, status, eligible, channel, source) VALUES
  ('2026-09-10', 'ARCH-1', 'Pending', false, 'Chat', 'DM'),
  ('2026-10-05', 'ARCH-2', 'Pending', false, 'Chat', 'DM'),
  ('2026-11-03', 'CUR-1', 'Pending', false, 'Chat', 'DM'),
  ('2026-09-12', 'ARCH-3', 'Paid', true, 'Chat', 'DM'),
  ('2026-09-13', 'ARCH-4', 'Paid', true, 'Chat', 'DM'),
  ('2026-09-14', 'ARCH-5', 'Paid', true, 'Chat', 'DM'),
  ('2026-09-15', 'ARCH-6', 'Paid', true, 'Chat', 'DM');
SELECT public.t_ok('C4 service_role: archived Pending -> Paid succeeds',
  public.t_as(:'A', 'service_role', $$UPDATE public.sales_log SET status = 'Paid' WHERE invoice_number = 'ARCH-1'$$) = 'ok');
SELECT public.t_ok('C4 ... and eligible auto-ticks as before', (SELECT status = 'Paid' AND eligible FROM public.sales_log WHERE invoice_number = 'ARCH-1'));
SELECT public.t_ok('C4 service_role: archived (Oct) Pending -> Paid succeeds',
  public.t_as(:'A', 'service_role', $$UPDATE public.sales_log SET status = 'Paid' WHERE invoice_number = 'ARCH-2'$$) = 'ok');
SELECT public.t_ok('C4 ... eligible auto-ticks', (SELECT eligible FROM public.sales_log WHERE invoice_number = 'ARCH-2'));
SELECT public.t_ok('C4 service_role: current-period Pending -> Paid succeeds and ticks', public.t_as(:'A', 'service_role', $$UPDATE public.sales_log SET status = 'Paid' WHERE invoice_number = 'CUR-1'$$) = 'ok');
SELECT public.t_ok('C4 service_role: current-period Pending -> Paid succeeds and ticks (data)', (SELECT eligible FROM public.sales_log WHERE invoice_number = 'CUR-1'));
SELECT public.t_ok('C4 service_role can also insert and delete in an archived period',
  public.t_as(:'A', 'service_role', $$INSERT INTO public.sales_log (sale_date, invoice_number) VALUES ('2026-09-01', 'ARCH-X')$$) = 'ok'
  AND public.t_as(:'A', 'service_role', $$DELETE FROM public.sales_log WHERE invoice_number = 'ARCH-X'$$) = 'ok');

-- SECURITY DEFINER writers called BY a signed-in staff member: their sales_log write runs as the owner, so it passes.
SELECT public.t_ok('C4 rename_invoice_number_atomic on an archived sale (called by staff)', public.t_as(:'S', 'authenticated', $$SELECT public.rename_invoice_number_atomic('ARCH-3', 'ARCH-3R')$$) = 'ok');
SELECT public.t_ok('C4 rename_invoice_number_atomic on an archived sale (called by staff) (data)', (SELECT count(*) = 1 FROM public.sales_log WHERE invoice_number = 'ARCH-3R'));
SELECT public.t_ok('C4 cancel_layaway_atomic on an archived sale', public.t_as(:'S', 'authenticated', $$SELECT public.cancel_layaway_atomic('ARCH-4')$$) = 'ok');
SELECT public.t_ok('C4 cancel_layaway_atomic on an archived sale (data)', (SELECT status = 'Cancelled' AND NOT eligible FROM public.sales_log WHERE invoice_number = 'ARCH-4'));
SELECT public.t_ok('C4 cancel_cash_order_atomic on an archived sale', public.t_as(:'S', 'authenticated', $$SELECT public.cancel_cash_order_atomic('ARCH-5')$$) = 'ok');
SELECT public.t_ok('C4 cancel_cash_order_atomic on an archived sale (data)', (SELECT status = 'Cancelled' FROM public.sales_log WHERE invoice_number = 'ARCH-5'));
SELECT public.t_ok('C4 page365_apply_invoice_stage on an archived sale', public.t_as(:'S', 'authenticated', $$SELECT public.page365_apply_invoice_stage('ARCH-6')$$) = 'ok');
SELECT public.t_ok('C4 page365_apply_invoice_stage on an archived sale (data)', (SELECT status = 'Cancelled' FROM public.sales_log WHERE invoice_number = 'ARCH-6'));

-- ===== C5. staff editing directly =====
SELECT public.t_ok('C5 staff UPDATE of an archived sale refused (CJA01)',
  public.t_as(:'S', 'authenticated', $$UPDATE public.sales_log SET client_name = 'x' WHERE invoice_number = 'ARCH-1'$$) = 'CJA01');
SELECT public.t_ok('C5 staff DELETE of an archived sale refused',
  public.t_as(:'S', 'authenticated', $$DELETE FROM public.sales_log WHERE invoice_number = 'ARCH-1'$$) = 'CJA01');
SELECT public.t_ok('C5 staff INSERT into an archived period refused',
  public.t_as(:'S', 'authenticated', $$INSERT INTO public.sales_log (sale_date, invoice_number) VALUES ('2026-10-20', 'ARCH-N')$$) = 'CJA01');
SELECT public.t_ok('C5 nothing changed by the refusals',
  (SELECT client_name IS NULL FROM public.sales_log WHERE invoice_number = 'ARCH-1')
  AND NOT EXISTS (SELECT 1 FROM public.sales_log WHERE invoice_number = 'ARCH-N'));
SELECT public.t_ok('C5 the refusal message names the rule',
  (SELECT m LIKE '%archived commission period%Admin or Brenda%' FROM (SELECT public.t_msg(:'S', $$UPDATE public.sales_log SET client_name = 'x' WHERE invoice_number = 'ARCH-1'$$) AS m) q));
SELECT public.t_ok('C5 staff INSERT in the current period allowed',
  public.t_as(:'S', 'authenticated', $$INSERT INTO public.sales_log (sale_date, invoice_number) VALUES ('2026-11-04', 'CUR-2')$$) = 'ok');
SELECT public.t_ok('C5 staff UPDATE in the current period allowed',
  public.t_as(:'S', 'authenticated', $$UPDATE public.sales_log SET client_name = 'y' WHERE invoice_number = 'CUR-2'$$) = 'ok');
SELECT public.t_ok('C5 a sale dated Nov 25 (December period) is current',
  public.t_as(:'S', 'authenticated', $$INSERT INTO public.sales_log (sale_date, invoice_number) VALUES ('2026-11-25', 'CUR-3')$$) = 'ok');
SELECT public.t_ok('C5 staff cannot move a current sale into an archived date',
  public.t_as(:'S', 'authenticated', $$UPDATE public.sales_log SET sale_date = '2026-10-31' WHERE invoice_number = 'CUR-2'$$) = 'CJA01');
SELECT public.t_ok('C5 staff cannot pull an archived sale into the current period',
  public.t_as(:'S', 'authenticated', $$UPDATE public.sales_log SET sale_date = '2026-11-04' WHERE invoice_number = 'ARCH-1'$$) = 'CJA01');
SELECT public.t_ok('C5 staff DELETE in the current period allowed',
  public.t_as(:'S', 'authenticated', $$DELETE FROM public.sales_log WHERE invoice_number = 'CUR-3'$$) = 'ok');
SELECT public.t_ok('C5 staff changing status Pending -> Paid by hand on a current sale still auto-ticks', public.t_as(:'S', 'authenticated', $$UPDATE public.sales_log SET status = 'Pending', eligible = false, channel = 'Chat', source = 'DM' WHERE invoice_number = 'CUR-2'$$) = 'ok'
  AND public.t_as(:'S', 'authenticated', $$UPDATE public.sales_log SET status = 'Paid' WHERE invoice_number = 'CUR-2'$$) = 'ok');
SELECT public.t_ok('C5 staff changing status Pending -> Paid by hand on a current sale still auto-ticks (data)', (SELECT eligible FROM public.sales_log WHERE invoice_number = 'CUR-2'));
SELECT public.t_ok('C5 finance and CSR (not the payslip gate) are refused too',
  public.t_as(:'F', 'authenticated', $$UPDATE public.sales_log SET client_name = 'x' WHERE invoice_number = 'ARCH-1'$$) = 'CJA01'
  AND public.t_as(:'C', 'authenticated', $$UPDATE public.sales_log SET client_name = 'x' WHERE invoice_number = 'ARCH-1'$$) = 'CJA01');

-- ===== C6. Admin and Brenda =====
SELECT public.t_ok('C6 admin edits an archived sale', public.t_as(:'A', 'authenticated', $$UPDATE public.sales_log SET client_name = 'adm' WHERE invoice_number = 'ARCH-1'$$) = 'ok');
SELECT public.t_ok('C6 admin edits an archived sale (data)', (SELECT client_name = 'adm' FROM public.sales_log WHERE invoice_number = 'ARCH-1'));
SELECT public.t_ok('C6 Brenda (can_view_all) edits an archived sale', public.t_as(:'B', 'authenticated', $$UPDATE public.sales_log SET client_name = 'bre' WHERE invoice_number = 'ARCH-1'$$) = 'ok');
SELECT public.t_ok('C6 Brenda (can_view_all) edits an archived sale (data)', (SELECT client_name = 'bre' FROM public.sales_log WHERE invoice_number = 'ARCH-1'));
SELECT public.t_ok('C6 admin and Brenda add to an archived period',
  public.t_as(:'A', 'authenticated', $$INSERT INTO public.sales_log (sale_date, invoice_number) VALUES ('2026-10-20', 'ARCH-A')$$) = 'ok'
  AND public.t_as(:'B', 'authenticated', $$INSERT INTO public.sales_log (sale_date, invoice_number) VALUES ('2026-10-21', 'ARCH-B')$$) = 'ok');
SELECT public.t_ok('C6 admin and Brenda delete archived sales',
  public.t_as(:'A', 'authenticated', $$DELETE FROM public.sales_log WHERE invoice_number = 'ARCH-A'$$) = 'ok'
  AND public.t_as(:'B', 'authenticated', $$DELETE FROM public.sales_log WHERE invoice_number = 'ARCH-B'$$) = 'ok');

-- ===== C7. a cut-off change re-opens / closes by rule =====
SELECT public.t_clock('2026-11-21 03:00:00+00');
SELECT public.t_ok('C7 on Nov 21 (PH) Nov 1-20 is archived for staff',
  public.t_as(:'S', 'authenticated', $$UPDATE public.sales_log SET client_name = 'z' WHERE invoice_number = 'CUR-1'$$) = 'CJA01');
SELECT public.t_ok('C7 ... and Nov 25 is still current',
  public.t_as(:'S', 'authenticated', $$INSERT INTO public.sales_log (sale_date, invoice_number) VALUES ('2026-11-25', 'CUR-4')$$) = 'ok');
