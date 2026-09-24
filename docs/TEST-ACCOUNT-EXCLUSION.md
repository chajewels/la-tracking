<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

## TEST ACCOUNT EXCLUSION — NON-NEGOTIABLE

Real accounts have purely numeric invoice numbers. All test/scaffolding accounts have non-numeric invoices (families: TEST-001..005, CJ-2026-*). The canonical exclusion applied to EVERY operational and financial surface is: keep numeric only — SQL `invoice_number ~ '^[0-9]+$'`; PostgREST `.filter('<embed>.invoice_number','match','^[0-9]+$')`. The old `TEST-%`/`TEST%` filters are INCOMPLETE (miss the CJ- family) and must be replaced by this rule.

Status (2026-05-23): applied across all frontend surfaces (Dashboard, Finance, CSR Monitoring, CSR Alerts, Smart Reminders, Extensions, Audit panels) and all 20 SQL reporting RPCs (13 fc_*, get_collection_analytics, get_monthly_sales, get_monthly_analytics, get_aging_buckets, get_forecast_6m, get_forecast_drilldown, get_top_outstanding_customers). Also enforced in the dashboard-summary EDGE FUNCTION — every layaway_accounts query plus the cash_orders and layaway_accounts payment joins use .filter('<embed>.invoice_number','match','^[0-9]+$'); this powers all Overview headline KPIs (Total Receivables, Predicted, Collections This Month, etc.).

Finance dashboard client-side cascade: useAccounts() returns rawAccounts (unfiltered); Finance.tsx derives `accounts` = rawAccounts filtered to /^[0-9]+$/.test(invoice_number). Every downstream memo inherits it — accountMap, collFiltered (via accountMap.has(p.account_id)), totalForfeitedCollected, recentCompleted. One root filter, all figures clean.

Documented exception: get_staff_performance is intentionally NOT numeric-filtered — it counts confirmed payment_submissions per reviewer (a staff-activity metric), so test-account submissions are legitimately counted as real staff actions. The other unfiltered helpers (get_bulk_setup_invite_candidates, get_recent_qualifying_order, get_unpaid_schedule) are operational, not dashboard counts.

Resolved this sweep: get_monthly_sales ALL-mode currency-conversion bug fixed (#132); get_monthly_analytics + get_aging_buckets numeric filters added (#133); the get_collection_analytics concern is closed — collection_rate is now a true capped efficiency = collected_due / expected, both summed from schedule_with_actuals by due-month (#137).

Re-runnable audit — find any reporting function still missing the filter:
  SELECT p.proname, (pg_get_functiondef(p.oid) LIKE '%^[0-9]+$%') AS has_numeric_filter
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND (p.proname LIKE 'get%' OR p.proname LIKE 'fc%')
  ORDER BY has_numeric_filter, p.proname;
  Expected false only for the four helpers named above — none are financial dashboard counts.

DB-enforced as of 2026-06-12: the convention is now backed by a `customers.is_test` boolean flag plus the `enforce_test_invoice_prefix()` trigger function attached BEFORE INSERT OR UPDATE on both `layaway_accounts` and `cash_orders`. Any account written under a customer where `is_test = true` gets its `invoice_number` auto-prefixed to `TEST-<number>` at write time — staff cannot accidentally save a purely-numeric invoice for a test customer, so the regex filters exclude the account regardless of what was typed in. **The rule is now: every new test customer MUST be flagged `is_test = true`. That is the single manual step; everything downstream is automatic.** Test Customer (customer_id `4201767c-54e6-48d0-8c9e-c1b3c07a931e`) is already flagged. See `docs/SCHEMA-FACTS.md` for the column/trigger spec and `docs/FIXED-BUGS.md` Bug #220-era TEST-4567 incident for the original leak that motivated the trigger.

