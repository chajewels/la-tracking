# Commissions: cut-off periods and the Sales Log archive

Owner-confirmed plan 2026-10-30. Migration `20270225100000_commission_cutoff_archive.sql`. CSR Operations commission only.

## The period rule
- A commission period is named after the month it ENDS in. `sales_log.sale_date` (date only) decides which period a sale is in.
- Setting: Commissions → Config → Commission Splits → **Cut-off** per month row (`commission_splits.cutoff_day`, 1–28; empty = End of month). It inherits forward like the percentages (the split is resolved exactly as before: exact month, else the latest month <= the target). "Add Month" copies the inherited row, cut-off included.
- A date whose day is <= the cut-off of its own month stays in that month; a later day belongs to the NEXT month's period.
- October 2026 stays Oct 1–31. With Nov 2026 set to 20: Nov = Nov 1–20, Dec = Nov 21–Dec 20, Jan 2027 = Dec 21–Jan 20, and so on.
- Past months are frozen: every existing row has a NULL cut-off, so Apr–Oct 2026 figures are unchanged.
- One rule, two twins that must agree: `periodKeyForDate` / `periodRange` in `src/lib/commissionEngine.ts` and `public.commission_period_month(date)` in SQL. `computeMonth`, `listMonthKeys` and `computeAllMonths` group by period.
- The Monthly tab shows the range under each month ("Nov 2026 · Nov 1 – Nov 20").

## Sales Log and Archived
- Sales Log: the period holding today (Philippine date) and later. **Archived** tab: completed periods, one month at a time (newest first). A period closes the day after its cut-off in Philippine time (`commission_period_is_closed(date)`): Oct 2026 on Nov 1, Nov 1–20 on Nov 21.
- Archived sales can be added, edited and deleted ONLY by Admin and Brenda: `public.can_manage_payslips(auth.uid())` (admin, or `timesheet_profiles.can_view_all`; today only Brenda). Everyone else sees them read-only, no buttons. If the database refuses, its message is shown in the toast.

## The guard (database)
- `sales_log_archive_guard` (BEFORE INSERT OR UPDATE OR DELETE on `sales_log`, SQLSTATE `CJA01`) refuses a sale whose OLD or NEW `sale_date` is in a closed period unless the caller passes the gate above. It also stops moving a sale into or out of an archived date.
- It acts ONLY when `current_user = 'authenticated'`, i.e. a direct edit from the screen. `service_role` and SECURITY DEFINER functions (owner role) pass untouched, so the automatic Pending → Paid flip (review-payment-submission), cancel (`cancel_layaway_atomic`, `cancel_cash_order_atomic`, `terminate_web_order_atomic`), `rename_invoice_number_atomic` and `page365_apply_invoice_stage` keep working on archived sales exactly as before. The guard is therefore SECURITY INVOKER on purpose; never make it SECURITY DEFINER.
- It never modifies NEW, and `autocheck_sales_log_eligible` is untouched.

## Safe before the migration is applied
The frontend reaches production before the Lovable apply (docs/GIT-WORKFLOW.md). Every `commission_splits` read goes through `fetchCommissionSplits`: if the select including `cutoff_day` fails with an undefined-column error it retries once without it and treats every cut-off as null. Until the column exists the Config tab hides Cut-off and nothing is archived (the Sales Log shows everything, as before).

## Known follow-up (not in this change)
`PayslipsTab.fetchMonthSales` fetches the CALENDAR month. For a period that crosses months (Dec 2026 = Nov 21–Dec 20) the payslip commission would miss Nov 21–30 and count nothing after Dec 20. Fine for Nov 2026 and earlier; fix it (fetch `periodRange(monthKey)`) BEFORE the December 2026 payslips are finalized.

## Tests
`src/test/commission-cutoff-engine.test.ts`, `src/test/commission-cutoff-screens.test.tsx`, SQL harness `supabase/tests/commission_archive/run.sh` (see its header).

## Release order
PR merged to develop → owner releases develop → main → after the owner's OK, Claude Code (sole sender) sends the Lovable apply message for the migration → Admin adds Nov 2026 in Commissions → Config with Cut-off 20.
