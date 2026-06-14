# Timesheet Feature — Spec

**Status:** BUILT & LIVE (2026-06-14, on main/production). Product/pay logic LOCKED. Shipped as
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

### Constants — FIXED in code, NOT per-user (locked 2026-06-13)

Per-day rates are CODE CONSTANTS in `src/lib/timesheetEngine.ts`. They are
NOT configurable per user and NOT seeded from the profile. The four
columns `half_day_rate`, `full_day_rate`, `full_day_threshold_hours`,
`dayoff_divisor` on `timesheet_profiles` are intentionally unused (left
null at write time, ignored by the engine).

- CSR: half-day ₱400, full-day rate = `round(basic_salary / (TIMESHEET_ROWS
  − 4), 4)` = `round(basic_salary / 27, 4)` — fixed /27 every month (31-row
  grid − 4 day-off divisor), not calendar-month-variable; full-day threshold
  `> 5.99 hr`, day-off divisor 4.
- Live Admin: half-day ₱300, full-day ₱500, full-day threshold `> 3.99 hr`.
  Live Admin has NO `basic_salary` and NO `allowance` — those columns
  stay null.

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

## 31-row grid & spillover

31-row grid from the 1st (TIMESHEET_ROWS=31 consecutive dates). Spillover rows — the next calendar month's first day(s) filling rows past the current month's last day — COUNT toward the displaying month's totals (daily hours, salary, and the Monday-anchored absence/allowance week-bucketing), exactly like in-month rows. Each month's grid is independent, so a boundary day shared by two adjacent months counts in BOTH; the CSR min(gross,basic) cap prevents double-pay. Implemented 2026-06-14: engine sums the full window (9f835f0a); per-month entry fetch widened to 1st..1st+30 days (e8878d05).

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
- pay config — Assignments UI collects ONLY:
  - CSR → `basic_salary`, `allowance` (both ₱). Per-day rates are derived
    by the engine from constants + `basic_salary` (see "Constants" above).
  - Live Admin → no money fields at all. Pay is computed entirely from
    the fixed ₱300 / ₱500 tiers in code.
  The four override columns (`half_day_rate`, `full_day_rate`,
  `full_day_threshold_hours`, `dayoff_divisor`) are written as null and
  never read by the engine.
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
