-- Stand-ins for the live commission objects the archive migration touches. Run AFTER ../payslips/stubs.sql and
-- the payslips migration (it needs the real public.can_manage_payslips).
CREATE TABLE public.commission_splits (
  month date NOT NULL PRIMARY KEY,
  closer_pct numeric DEFAULT 0 NOT NULL, processor_pct numeric DEFAULT 0 NOT NULL, coordinator_pct numeric DEFAULT 0 NOT NULL,
  support_pct numeric DEFAULT 0 NOT NULL, verifier_pct numeric DEFAULT 0 NOT NULL, top_sales_pct numeric DEFAULT 0 NOT NULL,
  top_sales_2_pct numeric DEFAULT 0 NOT NULL, pool_per_item_php numeric DEFAULT 200 NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL, merge_groups jsonb DEFAULT '[]'::jsonb NOT NULL);

CREATE TABLE public.sales_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY, sale_date date NOT NULL, item_code text, item_amount numeric,
  client_name text, closer text, processor text, coordinator text, support text, verifier text,
  status text DEFAULT 'Paid' NOT NULL, channel text, source text,
  opened_in_chat boolean DEFAULT true NOT NULL, closed_in_chat boolean DEFAULT true NOT NULL, eligible boolean DEFAULT true NOT NULL,
  notes text, created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL, invoice_number text);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales_log TO authenticated, service_role;
GRANT SELECT ON public.commission_splits TO authenticated, service_role;

-- Copied verbatim from the baseline (20260705230000_baseline_live_schema.sql).
CREATE OR REPLACE FUNCTION public.autocheck_sales_log_eligible()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status = 'Paid'
     AND NEW.channel != 'Live'
     AND NEW.source NOT IN ('Live Post', 'Online Store', 'Other')
  THEN
    IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM 'Paid' THEN
      NEW.eligible := true;
    ELSIF TG_OP = 'INSERT' AND NEW.eligible IS DISTINCT FROM false THEN
      NEW.eligible := true;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER sales_log_autocheck_eligible BEFORE INSERT OR UPDATE ON public.sales_log
  FOR EACH ROW EXECUTE FUNCTION public.autocheck_sales_log_eligible();

-- Stubs for the SECURITY DEFINER writers that touch sales_log. The real bodies (cancel_layaway_atomic,
-- cancel_cash_order_atomic, rename_invoice_number_atomic, page365_apply_invoice_stage) need many other tables; what
-- matters here is only WHICH ROLE their sales_log write runs as (the owner, never `authenticated`).
CREATE FUNCTION public.rename_invoice_number_atomic(p_old text, p_new text) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
  AS $$ UPDATE public.sales_log SET invoice_number = p_new WHERE invoice_number = p_old $$;
CREATE FUNCTION public.cancel_layaway_atomic(p_invoice text) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
  AS $$ UPDATE public.sales_log SET status = 'Cancelled', eligible = false WHERE invoice_number = p_invoice $$;
CREATE FUNCTION public.cancel_cash_order_atomic(p_invoice text) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
  AS $$ UPDATE public.sales_log SET status = 'Cancelled', eligible = false WHERE invoice_number = p_invoice $$;
CREATE FUNCTION public.page365_apply_invoice_stage(p_invoice text) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
  AS $$ UPDATE public.sales_log SET status = 'Cancelled', eligible = false WHERE invoice_number = p_invoice $$;
GRANT EXECUTE ON FUNCTION public.rename_invoice_number_atomic(text, text), public.cancel_layaway_atomic(text),
  public.cancel_cash_order_atomic(text), public.page365_apply_invoice_stage(text) TO authenticated, service_role;

-- Test helper: run one statement as a role with auth.uid() = p_uid; returns 'ok' or the SQLSTATE.
CREATE FUNCTION public.t_as(p_uid text, p_role text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_uid, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RETURN SQLSTATE;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN 'ok';
END $$;

-- Clock for the harness only: the migration's functions are pointed at fake.now() AFTER the migration is
-- applied (explicit search_path with pg_catalog last), so the real function bodies run against a chosen "today".
CREATE SCHEMA fake;
CREATE TABLE fake.clock (ts timestamptz NOT NULL);
INSERT INTO fake.clock VALUES ('2026-11-05 03:00:00+00');
CREATE FUNCTION fake.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT ts FROM fake.clock $$;
CREATE FUNCTION public.t_clock(p timestamptz) RETURNS void LANGUAGE sql AS $$ UPDATE fake.clock SET ts = p $$;

CREATE FUNCTION public.t_msg(p_uid text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_uid, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RETURN SQLERRM;
  END;
  RESET ROLE;
  RETURN 'ok';
END $$;
