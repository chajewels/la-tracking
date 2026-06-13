# Timesheet Feature — Spec

**Status:** BUILT (2026-06-13). Product/pay logic LOCKED. Shipped as
`src/pages/Timesheet.tsx` + `src/lib/timesheetEngine.ts` (pure-TS engine,
Commissions precedent), reading `timesheet_profiles` / `timesheet_entries`
under RLS — no edge function. Route `/timesheet` in
`PUBLIC_AUTHENTICATED_PATHS`; admin/finance tabs gated in-page by
`roles.includes(...)`. Repo audit resolved (see below).

---

## Overview

Monthly staff timesheet. Lives under **CSR Operations → Timesheet** on
`app.chajewelsjp.com` (internal/staff only — never portal). Live time-in/
time-out punching, strict per-user isolation (a user sees only their own
sheet), automatic monthly consolidation, and an admin-only cost master.

---

## Pay models

Two template types assigned per user: `live_admin`, `csr`.

**Daily hours (both models):**
`((pm_out − am_in) − (pm_in − am_out)) × 24` → hours.
Morning session + afternoon session, midday break excluded.

### Live Admin
- Daily salary: `<1 hr → 0`; `1–3.99 hr → 300`; `≥4 hr → 500`
- Monthly salary = sum of daily salaries (uncapped)
- No basic salary, no allowance, no day-off divisor

### CSR
- Daily salary: `<1 hr → 0`; `1–5.99 hr → 400`; `≥6 hr → full-day rate`
- Full-day rate = `round(basic_salary / (days_in_month − 4), 4)`
  (the −4 = assumed 4 day-offs/month)
- Monthly gross = `min(sum(daily salaries), basic_salary)` (capped at basic)
- Allowance: monthly, with absence deduction (below)
- Net pay = capped gross + allowance paid

### Constants
Stored as per-user config seeded with template defaults; overridable per user.
- CSR: half_day_rate=400, full_day_threshold=6h, dayoff_divisor=4
- Live Admin: half_day_rate=300, full_day_rate=500, full_day_threshold=4h

---

## Allowance absence deduction (CSR only)

- Monthly allowance splits into 4 equal weekly quarters.
- Week = Mon–Sun (template starts Monday).
- Absence = scheduled work day with hours < 1 (scheduled day-offs excluded).
- A week with **≥3 absences** forfeits that week's ¼.
- Partial 5th week rolls into week 4.
- allowance_paid = monthly_allowance × (1 − forfeited_weeks ÷ 4)

---

## NO OF DAY-OFF

Count of days in the month with hours < 1.

---

## Entry / punch

- Live punch (Time In / Time Out), validated against the user's assigned
  work schedule.
- Each user punches their own only.
- Four punches/day: AM in, AM out, PM in, PM out (manual correction allowed).
- Per-user timezone, default Asia/Manila.

---

## Profile (per user) — provisional table `timesheet_profiles`

- template_type (`live_admin` | `csr`), job_title
- timezone (default Asia/Manila)
- assigned work schedule (work weekdays + expected hours) — drives
  absence/day-off detection and punch validation
- pay config:
  - CSR → basic_salary, allowance, half_day_rate(400),
    full_day_threshold(6), dayoff_divisor(4)
  - Live Admin → half_day_rate(300), full_day_rate(500),
    full_day_threshold(4)
- active flag

Pay/rate fields: visible to the user themselves + admin; hidden from
other users.

---

## Entries — provisional table `timesheet_entries`

- user_id, work_date, am_in, am_out, pm_in, pm_out
- computed daily_hours, daily_salary (via view/generated)
- unique (user_id, work_date)

---

## Views / outputs

- **User monthly sheet:** own rows only; user sees their own pay.
- **Consolidation master** (admin/finance): day-by-day matrix of each
  user's (hrs, salary); per-person TOTAL = monthly net
  (CSR = capped gross + allowance; Live Admin = total salary).
- **Cost master** (admin only): monthly net cost per user + totals;
  hidden from non-admins.

---

## Access / RLS / permissions

- `timesheet_entries`: user SELECT/INSERT/UPDATE own rows (user mapped to
  `auth.uid()`); admin/finance SELECT all.
- Profile pay fields: visible to the user themselves + admin; hidden from
  other users.
- Cost master: admin-only — RLS + permission key + sidebar gating.
- Permission keys (role_permissions, explicit `is_allowed = true`):
  - view_own_timesheet (all staff)
  - manage_timesheet_assignments (admin)
  - view_timesheet_consolidation (admin/finance)
  - view_timesheet_costs (admin only)
- Cash-orders first-class rule: N/A — this is a staff-scoped HR feature,
  not an account-scoped feature.

---

## Placement

CSR Operations → Timesheet child item; route on `app.chajewelsjp.com`.

---

## Repo audit (RESOLVED 2026-06-13)

- ✅ staff/users table: `public.profiles` (`user_id`, `full_name`) drives
  the Assignments list; `timesheet_*.user_id` = auth user id.
- ✅ CSR Operations sidebar: child item added in
  `src/components/layout/AppSidebar.tsx` (`{ label: 'Timesheet', tab,
  path: ROUTES.TIMESHEET }`).
- ✅ RLS: per-user isolation (own rows) + admin/finance read-all, applied
  via SQL Editor. The My tab still filters explicitly by `user_id`.
- ✅ Access control: NO `role_permissions` keys and NO edge function were
  added (per build guardrails). Gating is RLS + in-page
  `roles.includes('admin')` / `roles.includes('finance')`, and
  `/timesheet` in `PUBLIC_AUTHENTICATED_PATHS`. The earlier
  permission-key plan (view_own_timesheet etc.) was intentionally NOT
  implemented.
- ✅ Final table/column names confirmed: `timesheet_profiles`,
  `timesheet_entries` (hand-added to `src/integrations/supabase/types.ts`).
