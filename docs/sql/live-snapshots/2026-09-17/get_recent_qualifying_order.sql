-- LIVE SNAPSHOT — captured read-only, NOT a migration. Do not apply this file.
--
--   function  : public.get_recent_qualifying_order(p_customer_id uuid, p_lookback_days integer)
--   captured  : 2026-09-17 05:50:22.096422+00 (SELECT pg_get_functiondef(oid))
--   md5       : eaa9c4f2ac4ccb9ba89f8c6e46c11213
--   length    : 1826 bytes
--
-- The md5 and length above are of the text BELOW this header, which is the
-- pg_get_functiondef output byte for byte — header excluded. To re-verify:
--
--   SELECT md5(pg_get_functiondef(p.oid)), length(pg_get_functiondef(p.oid))
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'get_recent_qualifying_order';
--
-- Captured for the live-vs-repo diff pass (DIFF-FINDINGS.md beside this file).
-- The repo is NOT evidence about live — see CLAUDE.md, "A SQL EDITOR CHANGE
-- THAT IS NEVER COMMITTED IS INVISIBLE TO EVERY LATER REBUILD".

CREATE OR REPLACE FUNCTION public.get_recent_qualifying_order(p_customer_id uuid, p_lookback_days integer DEFAULT 3)
 RETURNS TABLE(source_kind text, account_id uuid, cash_order_id uuid, invoice_number text, loyalty_jpy_amount numeric, total_amount numeric, currency text, confirmed_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT q.source_kind, q.account_id, q.cash_order_id, q.invoice_number,
         q.loyalty_jpy_amount, q.total_amount, q.currency, q.confirmed_at
  FROM (
    SELECT 'layaway'::text AS source_kind, la.id AS account_id, NULL::uuid AS cash_order_id,
           la.invoice_number, la.loyalty_jpy_amount, la.total_amount, la.currency::text AS currency,
           ps.updated_at AS confirmed_at
    FROM layaway_accounts la
    JOIN payment_submissions ps
      ON ps.account_id = la.id AND ps.status::text = 'confirmed'
     AND ( ps.submission_type::text = 'downpayment'
        OR ps.reference_number ILIKE 'DP-%'
        OR ps.notes ~* '\y(down(payment)?|dp)\y' )
    WHERE la.customer_id = p_customer_id
      AND (la.loyalty_jpy_amount >= 10000 OR la.loyalty_jpy_amount IS NULL)
      AND la.status::text NOT IN ('cancelled','forfeited','final_forfeited')
      AND ps.updated_at >= now() - make_interval(days => p_lookback_days)
    UNION ALL
    SELECT 'cash'::text, NULL::uuid, co.id, co.invoice_number, co.loyalty_jpy_amount, co.total_amount,
           co.currency::text, co.completed_at
    FROM cash_orders co
    WHERE co.customer_id = p_customer_id
      AND (co.loyalty_jpy_amount >= 10000 OR co.loyalty_jpy_amount IS NULL)
      AND co.status::text = 'completed'
      AND co.completed_at IS NOT NULL
      AND co.completed_at >= now() - make_interval(days => p_lookback_days)
  ) q
  ORDER BY q.confirmed_at DESC
  LIMIT 1;
$function$
