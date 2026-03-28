CREATE OR REPLACE FUNCTION get_forecast_6m()
RETURNS TABLE (
  month        date,
  currency     text,
  installments bigint,
  remaining    numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    date_trunc('month', s.due_date)::date AS month,
    a.currency::text,
    COUNT(*)                              AS installments,
    SUM(s.total_due_amount - COALESCE(s.paid_amount, 0)) AS remaining
  FROM layaway_schedule s
  JOIN layaway_accounts a ON a.id = s.account_id
  WHERE s.due_date >= date_trunc('month', now())
    AND s.due_date < date_trunc('month', now()) + INTERVAL '7 months'
    AND s.status IN ('pending', 'partially_paid', 'overdue')
    AND a.status IN ('active', 'overdue', 'final_settlement', 'extension_active')
    AND a.invoice_number NOT LIKE 'TEST-%'
  GROUP BY 1, 2
  ORDER BY 1, 2;
$$;
