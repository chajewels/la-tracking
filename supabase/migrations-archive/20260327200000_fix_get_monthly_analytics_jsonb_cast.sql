-- Fix get_monthly_analytics: cast jsonb value correctly
-- system_settings.value is jsonb; use (value #>> '{}')::numeric to extract scalar
CREATE OR REPLACE FUNCTION get_monthly_analytics()
RETURNS TABLE (
  month         date,
  collected_jpy numeric,
  forfeited_jpy numeric,
  penalties_jpy numeric
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH rate AS (
    SELECT (value #>> '{}')::numeric AS r
    FROM system_settings
    WHERE key = 'php_jpy_rate'
  ),
  collected AS (
    SELECT
      date_trunc('month', p.date_paid)::date AS month,
      SUM(CASE WHEN a.currency = 'JPY' THEN p.amount_paid
               ELSE p.amount_paid * (SELECT r FROM rate) END) AS jpy
    FROM payments p
    JOIN layaway_accounts a ON a.id = p.account_id
    WHERE p.voided_at IS NULL
      AND a.invoice_number NOT LIKE 'TEST-%'
    GROUP BY 1
  ),
  forfeited AS (
    SELECT
      date_trunc('month', a.updated_at)::date AS month,
      SUM(CASE WHEN a.currency = 'JPY' THEN a.remaining_balance
               ELSE a.remaining_balance * (SELECT r FROM rate) END) AS jpy
    FROM layaway_accounts a
    WHERE a.status IN ('forfeited', 'final_forfeited')
      AND a.invoice_number NOT LIKE 'TEST-%'
    GROUP BY 1
  ),
  penalties AS (
    SELECT
      date_trunc('month', pf.updated_at)::date AS month,
      SUM(CASE WHEN a.currency = 'JPY' THEN pf.penalty_amount
               ELSE pf.penalty_amount * (SELECT r FROM rate) END) AS jpy
    FROM penalty_fees pf
    JOIN layaway_accounts a ON a.id = pf.account_id
    WHERE pf.status = 'paid'
      AND a.invoice_number NOT LIKE 'TEST-%'
    GROUP BY 1
  ),
  all_months AS (
    SELECT month FROM collected
    UNION SELECT month FROM forfeited
    UNION SELECT month FROM penalties
  )
  SELECT
    m.month,
    COALESCE(c.jpy, 0)   AS collected_jpy,
    COALESCE(f.jpy, 0)   AS forfeited_jpy,
    COALESCE(pen.jpy, 0) AS penalties_jpy
  FROM all_months m
  LEFT JOIN collected  c   ON c.month   = m.month
  LEFT JOIN forfeited  f   ON f.month   = m.month
  LEFT JOIN penalties  pen ON pen.month = m.month
  ORDER BY 1;
$$;
