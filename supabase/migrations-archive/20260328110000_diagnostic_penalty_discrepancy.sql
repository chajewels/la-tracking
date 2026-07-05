-- ────────────────────────────────────────────────────────────────────────────
-- DIAGNOSTIC: compare penalty_fees data from two date angles
-- Run this in the Supabase SQL editor to identify the discrepancy source.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Penalties grouped by penalty_date (when the penalty was charged)
SELECT
  'by_penalty_date'                                      AS source,
  date_trunc('month', pf.penalty_date)::date             AS month,
  a.currency,
  COUNT(*)                                               AS count,
  SUM(pf.penalty_amount)                                 AS amount_php_or_jpy,
  SUM(CASE WHEN a.currency = 'JPY' THEN pf.penalty_amount
           WHEN a.currency = 'PHP' THEN pf.penalty_amount * (
             SELECT (value #>> '{}')::numeric FROM system_settings WHERE key = 'php_jpy_rate'
           )
           ELSE pf.penalty_amount END)                   AS amount_jpy
FROM penalty_fees pf
JOIN layaway_accounts a ON a.id = pf.account_id
WHERE pf.status = 'paid'
  AND a.invoice_number NOT LIKE 'TEST-%'
GROUP BY 1, 2, 3
ORDER BY 2, 3;

-- 2. Penalties grouped by updated_at (current RPC behavior — when status changed)
SELECT
  'by_updated_at'                                        AS source,
  date_trunc('month', pf.updated_at)::date               AS month,
  a.currency,
  COUNT(*)                                               AS count,
  SUM(pf.penalty_amount)                                 AS amount_php_or_jpy,
  SUM(CASE WHEN a.currency = 'JPY' THEN pf.penalty_amount
           WHEN a.currency = 'PHP' THEN pf.penalty_amount * (
             SELECT (value #>> '{}')::numeric FROM system_settings WHERE key = 'php_jpy_rate'
           )
           ELSE pf.penalty_amount END)                   AS amount_jpy
FROM penalty_fees pf
JOIN layaway_accounts a ON a.id = pf.account_id
WHERE pf.status = 'paid'
  AND a.invoice_number NOT LIKE 'TEST-%'
GROUP BY 1, 2, 3
ORDER BY 2, 3;

-- 3. Check for unexpected currency values
SELECT
  a.currency,
  COUNT(*) AS penalty_count,
  SUM(pf.penalty_amount) AS total_amount
FROM penalty_fees pf
JOIN layaway_accounts a ON a.id = pf.account_id
WHERE pf.status = 'paid'
  AND a.invoice_number NOT LIKE 'TEST-%'
GROUP BY 1
ORDER BY 1;

-- 4. Check whether penalty payments also appear in the payments table
--    (would indicate double-counting in the collected CTE)
SELECT
  'penalty_payments_in_payments_table' AS check,
  COUNT(*) AS count,
  SUM(p.amount_paid) AS total
FROM payments p
WHERE p.payment_type IN ('penalty', 'dp')
   OR p.remarks ILIKE '%penalty%'
   AND p.voided_at IS NULL;
