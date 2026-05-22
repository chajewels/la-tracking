## NEW HEALTH CHECKS (15-21, added in Phase 5 — 2026-03-29)

  Check 15: total_paid drift — SUM(payments) matches account.total_paid
  Check 16: allocation ceiling breach — no row over-allocated
  Check 17: inflated schedule rows — no pending/overdue rows with inflated total_due_amount
  Check 18: zero remaining not paid — all zero-remaining rows marked paid
  Check 19: wrongful forfeit — no zero-balance forfeited accounts
  Check 20: carried amount on paid row — no unconsumed carry on paid rows
  Check 21: double carry — no account has carry on multiple rows

## PERIODIC HEALTH QUERIES

```sql
-- Detect stale partially_paid rows (run periodically)
SELECT la.invoice_number, ls.installment_number
FROM layaway_schedule ls
JOIN layaway_accounts la ON la.id = ls.account_id
LEFT JOIN (
  SELECT schedule_id, SUM(allocated_amount) AS allocated
  FROM payment_allocations pa2
  JOIN payments p ON p.id = pa2.payment_id
  WHERE p.voided_at IS NULL
  GROUP BY schedule_id
) pa ON pa.schedule_id = ls.id
WHERE ls.status = 'partially_paid'
  AND COALESCE(pa.allocated, 0) >= (
    ls.base_installment_amount
    + COALESCE(ls.penalty_amount, 0)
    + COALESCE(ls.carried_amount, 0)
  ) - 0.005
  AND la.invoice_number NOT LIKE 'TEST-%';
-- Expected result: 0 rows. If rows appear, update db_status to paid.
```

