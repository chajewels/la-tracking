/**
 * Staff Timesheet engine — pure computation, no I/O.
 *
 * Mirrors commissionEngine.ts in style: types + pure functions, all reads
 * happen in the page under RLS. Currency is PHP throughout.
 *
 * Two template types: `live_admin`, `csr`. Pay logic is LOCKED per
 * docs/TIMESHEET-SPEC.md (2026-06-13). The -0.01 in the threshold
 * comparisons reproduces the source sheet's >3.99 / >5.99 tests exactly.
 */

export type TemplateType = 'live_admin' | 'csr';

export interface TimesheetProfile {
  id: string;
  user_id: string;
  template_type: TemplateType;
  job_title: string | null;
  timezone: string;
  work_days: number[];           // ISO dow 1=Mon..7=Sun
  shift_start: string | null;    // 'HH:MM' / 'HH:MM:SS'
  shift_end: string | null;
  basic_salary: number | null;
  allowance: number | null;
  half_day_rate: number | null;
  full_day_rate: number | null;
  full_day_threshold_hours: number | null;
  dayoff_divisor: number;
  active: boolean;
}

export interface TimesheetEntry {
  work_date: string;             // 'YYYY-MM-DD'
  am_in: string | null;          // timestamptz ISO
  am_out: string | null;
  pm_in: string | null;
  pm_out: string | null;
}

export interface DayComputation {
  date: string;                  // 'YYYY-MM-DD'
  dow: number;                   // ISO 1..7
  inMonth: boolean;              // date's YYYY-MM === monthKey (false = spillover row)
  hours: number;
  salary: number;
  isScheduled: boolean;
  isAbsence: boolean;            // IN-MONTH scheduled day with hours < 1
  isDayoff: boolean;             // IN-MONTH day with hours < 1
  entry: TimesheetEntry | null;
}

export interface MonthComputation {
  monthKey: string;              // 'YYYY-MM'
  monthLabel: string;            // e.g. "Jun 2026"
  days: DayComputation[];
  total_hours: number;
  gross: number;
  allowance_paid: number;
  net: number;
  dayoff_count: number;
  forfeitedWeeks: number;
}

// ── Fixed pay constants (LOCKED — not configurable per profile) ─────────────
//
// Per-day rates are CODE CONSTANTS. The four override columns on
// timesheet_profiles (half_day_rate, full_day_rate,
// full_day_threshold_hours, dayoff_divisor) are intentionally ignored
// by this engine. They remain on the schema as unused/null. Only
// basic_salary (CSR) and allowance (CSR) come from the profile.
//
// A monthly sheet ALWAYS has 31 day rows (matches the source
// spreadsheet's fixed day-count cell). Shorter months (30-day,
// February) spill into the next month's first days until 31 is
// reached. The CSR full-day rate normalizes over 31, not the actual
// calendar month length — divisor is (TIMESHEET_ROWS − 4) = 27.

export const TIMESHEET_ROWS = 31;

const LIVE_ADMIN_HALF = 300;
const LIVE_ADMIN_FULL = 500;
const CSR_HALF = 400;
const CSR_DAYOFF_DIVISOR = 4;

// Thresholds reproduce the source sheet's >3.99 / >5.99 tests exactly.
const LIVE_ADMIN_FULL_THRESHOLD = 3.99;
const CSR_FULL_THRESHOLD = 5.99;

export const TEMPLATE_LABEL: Record<TemplateType, string> = {
  live_admin: 'Live Admin',
  csr: 'CSR',
};

// ── Month helpers ───────────────────────────────────────────────────────────

export function monthKeyFromDate(iso: string | null | undefined): string | null {
  if (!iso || iso.length < 7) return null;
  return iso.slice(0, 7);
}

export function daysInMonthOf(monthKey: string): number {
  const [yearStr, monthStr] = monthKey.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return 0;
  return new Date(year, month, 0).getDate();
}

export function monthLabelFromKey(monthKey: string): string {
  const [yearStr, monthStr] = monthKey.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return monthKey;
  return new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/** ISO day-of-week (1=Mon..7=Sun) for a 'YYYY-MM-DD' string, computed in a
 *  timezone-stable way (parse the parts, no UTC shift). */
export function isoDowOf(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  const js = new Date(y, (m || 1) - 1, d || 1).getDay(); // 0=Sun..6=Sat
  return js === 0 ? 7 : js;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 'YYYY-MM-DD' for day `d` of `monthKey`. */
function dateStrOf(monthKey: string, day: number): string {
  return `${monthKey}-${pad2(day)}`;
}

// ── Core pay math ───────────────────────────────────────────────────────────

/** Hours between two timestamps; 0 when either is null. */
export function hoursBetween(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return (tb - ta) / 3600000;
}

/** Wall-clock time-of-day of a timestamptz in the given IANA timezone,
 *  expressed as decimal hours in 0..24. Null/empty/invalid → 0.
 *  Mirrors the sheet's interpretation of a blank punch cell as 0. */
export function timeOfDayHours(iso: string | null, timezone: string): number {
  if (!iso) return 0;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 0;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');
  // Some locales emit "24:00:00" for midnight under hour12:false — normalize.
  const h = hour === 24 ? 0 : hour;
  return h + minute / 60 + second / 3600;
}

/** Daily hours per the source sheet's literal formula:
 *    ((E - B) - (D - C)) × 24
 *  where B = am_in, C = am_out, D = pm_in, E = pm_out, each as a
 *  time-of-day in decimal hours (blank → 0). We already work in
 *  decimal hours, so the ×24 is implicit. Result is clamped to >= 0.
 *
 *  This correctly handles in+out only (no lunch punches), AM-only,
 *  PM-only, and full days — any blank punch contributes 0, which is
 *  the spreadsheet's behavior. */
export function dailyHours(
  entry: TimesheetEntry | null | undefined,
  timezone: string,
): number {
  if (!entry) return 0;
  const B = timeOfDayHours(entry.am_in, timezone);
  const C = timeOfDayHours(entry.am_out, timezone);
  const D = timeOfDayHours(entry.pm_in, timezone);
  let E = timeOfDayHours(entry.pm_out, timezone);
  // A non-blank pm_out at 00:00 reads as 0h, which the time-of-day formula
  // can't distinguish from "before pm_in". The workday ends at 00:00 midnight,
  // so a real midnight punch-out means END OF DAY = 24:00. Blank pm_out (null)
  // stays 0 — only an actual midnight punch is lifted.
  if (entry.pm_out && E === 0) E = 24;
  const h = (E - B) - (D - C);
  return h < 0 ? 0 : h;
}

/** Daily salary for the given worked hours under a profile.
 *  Rates are FIXED code constants — the profile's half_day_rate,
 *  full_day_rate, full_day_threshold_hours and dayoff_divisor columns
 *  are intentionally ignored. Only basic_salary feeds the CSR
 *  derivation.
 *
 *  CSR full-day rate normalizes over the fixed 31-row sheet span,
 *  NOT the actual month length: basic / (TIMESHEET_ROWS − 4) = basic / 27.
 *  (Param kept for backward compatibility and is unused.)
 */
export function dailySalary(hours: number, profile: TimesheetProfile, _daysInMonth?: number): number {
  void _daysInMonth;
  if (hours < 1) return 0;

  if (profile.template_type === 'live_admin') {
    return hours > LIVE_ADMIN_FULL_THRESHOLD ? LIVE_ADMIN_FULL : LIVE_ADMIN_HALF;
  }

  // csr
  const basic = profile.basic_salary ?? 0;
  const fullRate = Math.round((basic / (TIMESHEET_ROWS - CSR_DAYOFF_DIVISOR)) * 10000) / 10000;
  return hours > CSR_FULL_THRESHOLD ? fullRate : CSR_HALF;
}

/** Add `n` days to a 'YYYY-MM-DD' string and return the resulting
 *  'YYYY-MM-DD'. DST-safe: works in UTC and never crosses local DST
 *  boundaries. */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = Date.UTC(y, (m || 1) - 1, d || 1) + n * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** The fixed 31 consecutive dates that form a month's sheet, starting
 *  at the 1st of `monthKey`. Shorter months spill into the next month
 *  automatically. */
export function timesheetDatesOf(monthKey: string): string[] {
  const first = `${monthKey}-01`;
  const out: string[] = [];
  for (let i = 0; i < TIMESHEET_ROWS; i++) out.push(addDays(first, i));
  return out;
}

/** Bucket the 31 timesheet dates of `monthKey` into 4 Mon–Sun weeks,
 *  anchored on MONDAYS. The full 31-row window is bucketed — INCLUDING
 *  spillover dates in the next calendar month — because every row in a
 *  month's grid counts toward that month's totals (incl. absence
 *  forfeiture). Each month's grid is independent, so a shared boundary
 *  day is bucketed in both adjacent months.
 *
 *  Anchoring on Mondays — rather than advancing on each Sunday — fixes
 *  the lone-leading-partial-week bug: when a month starts on a Sunday
 *  (e.g. Feb/Mar 2026) the old logic made the 1st its own 1-day bucket
 *  that could never reach >= 3 absences, so its quarter of the
 *  allowance was never forfeitable. Here the leading days before the
 *  first Monday merge into week 1 (bucket 0), each subsequent Monday
 *  opens the next bucket, and any 5th week rolls into bucket 3. */
export function weekBuckets(monthKey: string): string[][] {
  const buckets: string[][] = [[], [], [], []];
  let idx = 0;
  let seenMonday = false;
  for (const date of timesheetDatesOf(monthKey)) {
    if (isoDowOf(date) === 1) {
      if (seenMonday) idx = Math.min(idx + 1, 3);
      seenMonday = true;
    }
    buckets[idx].push(date);
  }
  return buckets;
}

// ── Month computation ───────────────────────────────────────────────────────

export function computeMonth(
  monthKey: string,
  entries: TimesheetEntry[],
  profile: TimesheetProfile,
): MonthComputation {
  // The sheet ALWAYS has 31 day rows starting at monthKey/01. EVERY row in
  // that window — including spillover rows dated in the NEXT calendar month
  // (e.g. 7/1 for June) — counts toward THIS month's totals. Each month's
  // grid is independent: a boundary day shared by two adjacent months is
  // summed in BOTH (no deduplication). `entryByDate` accepts any date in the
  // window, so a boundary-day entry is picked up by both months.
  const sheetDates = timesheetDatesOf(monthKey);
  const dateSet = new Set(sheetDates);
  const entryByDate = new Map<string, TimesheetEntry>();
  for (const e of entries) {
    if (dateSet.has(e.work_date)) entryByDate.set(e.work_date, e);
  }
  const workDays = new Set(profile.work_days ?? []);

  const days: DayComputation[] = [];
  let total_hours = 0;
  let sumDailySalary = 0;
  let dayoff_count = 0;

  for (const date of sheetDates) {
    const dow = isoDowOf(date);
    const inMonth = date.slice(0, 7) === monthKey; // metadata only; spillover still counts
    const isScheduled = workDays.has(dow);

    const entry = entryByDate.get(date) ?? null;
    const hours = entry ? dailyHours(entry, profile.timezone || 'Asia/Manila') : 0;
    const salary = dailySalary(hours, profile);
    // A missing entry (hours 0) on a scheduled day is an absence.
    const isAbsence = isScheduled && hours < 1;
    const isDayoff = hours < 1;

    total_hours += hours;
    sumDailySalary += salary;
    if (hours < 1) dayoff_count += 1;

    days.push({ date, dow, inMonth, hours, salary, isScheduled, isAbsence, isDayoff, entry });
  }

  let gross: number;
  let allowance_paid: number;
  let forfeitedWeeks = 0;

  if (profile.template_type === 'csr') {
    gross = profile.basic_salary != null ? Math.min(sumDailySalary, profile.basic_salary) : sumDailySalary;

    // Allowance absence deduction — LOCKED. Every scheduled work day in the
    // 31-row window with hours < 1 (INCLUDING dates with no entry row, and
    // INCLUDING spillover rows) is an absence; those are exactly the days
    // flagged isAbsence above. A Mon–Sun bucket with >= 3 absences forfeits
    // its quarter. Buckets span the full window, so a fully-empty month
    // forfeits all 4 → allowance 0.
    const absenceByDate = new Map<string, boolean>();
    for (const d of days) absenceByDate.set(d.date, d.isAbsence);
    const buckets = weekBuckets(monthKey);
    for (const bucket of buckets) {
      const absences = bucket.reduce((n, date) => n + (absenceByDate.get(date) ? 1 : 0), 0);
      if (absences >= 3) forfeitedWeeks += 1;
    }
    const allowance = profile.allowance ?? 0;
    allowance_paid = Math.round(allowance * (1 - Math.min(forfeitedWeeks, 4) / 4) * 100) / 100;
  } else {
    gross = sumDailySalary; // live_admin: uncapped
    allowance_paid = 0;
  }

  const net = gross + allowance_paid;

  return {
    monthKey,
    monthLabel: monthLabelFromKey(monthKey),
    days,
    total_hours,
    gross,
    allowance_paid,
    net,
    dayoff_count,
    forfeitedWeeks,
  };
}

// ── Consolidation across users ──────────────────────────────────────────────

export interface ConsolidationUserCol {
  user_id: string;
  name: string;
  template_type: TemplateType;
  net: number;
  total_hours: number;
  allowance_paid: number;
}

export interface ConsolidationDayCell {
  hours: number;
  salary: number;
}

export interface ConsolidationResult {
  monthKey: string;
  monthLabel: string;
  daysInMonth: number;
  dates: string[];                                  // 'YYYY-MM-DD' for each calendar day
  users: ConsolidationUserCol[];                    // one per active profile
  // matrix[date][user_id] = { hours, salary }
  matrix: Record<string, Record<string, ConsolidationDayCell>>;
}

/** Given a monthKey, the set of (active) profiles, and entries grouped by
 *  user_id, return the per-day per-user (hours, salary) matrix plus each
 *  user's net + total hours. `nameByUser` supplies display names. */
export function computeConsolidation(
  monthKey: string,
  profiles: TimesheetProfile[],
  entriesByUser: Map<string, TimesheetEntry[]>,
  nameByUser: Map<string, string>,
): ConsolidationResult {
  // Fixed 31-row span (matches computeMonth). `daysInMonth` in the
  // returned shape is the sheet row count, NOT the calendar month
  // length — kept under that name for backward compatibility with the
  // existing page caller.
  const dates: string[] = timesheetDatesOf(monthKey);
  const daysInMonth = dates.length;

  const users: ConsolidationUserCol[] = [];
  const matrix: Record<string, Record<string, ConsolidationDayCell>> = {};
  for (const date of dates) matrix[date] = {};

  for (const profile of profiles) {
    const userEntries = entriesByUser.get(profile.user_id) ?? [];
    const month = computeMonth(monthKey, userEntries, profile);
    users.push({
      user_id: profile.user_id,
      name: nameByUser.get(profile.user_id) ?? profile.user_id,
      template_type: profile.template_type,
      net: month.net,
      total_hours: month.total_hours,
      allowance_paid: month.allowance_paid,
    });
    for (const d of month.days) {
      matrix[d.date][profile.user_id] = { hours: d.hours, salary: d.salary };
    }
  }

  users.sort((a, b) => a.name.localeCompare(b.name));

  return {
    monthKey,
    monthLabel: monthLabelFromKey(monthKey),
    daysInMonth,
    dates,
    users,
    matrix,
  };
}

// ── Cross-month cost summary (admin Full Summary) ───────────────────────────

export interface MonthCostRow {
  monthKey: string;
  label: string;
  csr: number;
  liveAdmin: number;
  total: number;
}

export interface AllMonthsSummary {
  rows: MonthCostRow[];
  cumulative: { csr: number; liveAdmin: number; total: number };
}

/** The months whose 31-row window contains `dateStr`: always the date's own
 *  month, plus the PRECEDING month when the date is a spillover day of it
 *  (i.e. it falls within `[prev/01 .. prev/01 + 30 days]`). A boundary day
 *  like 7/1 therefore belongs to both July's and June's window. */
function monthsWindowingDate(dateStr: string): string[] {
  const own = monthKeyFromDate(dateStr);
  if (!own) return [];
  const result = [own];
  const [y, m] = own.split('-').map(Number);
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const prev = `${prevY}-${pad2(prevM)}`;
  if (dateStr <= addDays(`${prev}-01`, TIMESHEET_ROWS - 1)) result.push(prev);
  return result;
}

/** Aggregate net payroll cost per month across every ACTIVE profile.
 *  Net is the cost basis (same value Cost Master shows). A month SURFACES
 *  and SUMS on its 31-row window: a month appears if any entry falls in its
 *  window, and its net is computed from every window entry — in-month AND
 *  spillover. A boundary-day entry (e.g. 7/1) therefore contributes to both
 *  June's and July's window. computeMonth windows the entries it receives,
 *  so this only sums computeMonth(...).net — no pay math is duplicated. */
export function computeAllMonthsSummary(
  profiles: TimesheetProfile[],
  allEntries: (TimesheetEntry & { user_id: string })[],
): AllMonthsSummary {
  const active = profiles.filter(p => p.active);

  // Months whose 31-row window contains at least one entry, ascending. A
  // boundary-day entry surfaces both the date's month and the preceding one.
  const monthSet = new Set<string>();
  for (const e of allEntries) {
    for (const mk of monthsWindowingDate(e.work_date)) monthSet.add(mk);
  }
  const monthKeys = Array.from(monthSet).sort();

  // Group entries by user once, for per-month windowing.
  const entriesByUser = new Map<string, (TimesheetEntry & { user_id: string })[]>();
  for (const e of allEntries) {
    const list = entriesByUser.get(e.user_id) ?? [];
    list.push(e);
    entriesByUser.set(e.user_id, list);
  }

  const rows: MonthCostRow[] = [];
  const cumulative = { csr: 0, liveAdmin: 0, total: 0 };

  for (const monthKey of monthKeys) {
    const windowSet = new Set(timesheetDatesOf(monthKey));
    let csr = 0;
    let liveAdmin = 0;
    for (const profile of active) {
      const userEntries = (entriesByUser.get(profile.user_id) ?? [])
        .filter(e => windowSet.has(e.work_date));
      const month = computeMonth(monthKey, userEntries, profile);
      if (profile.template_type === 'csr') csr += month.net;
      else liveAdmin += month.net;
    }
    const total = csr + liveAdmin;
    rows.push({ monthKey, label: monthLabelFromKey(monthKey), csr, liveAdmin, total });
    cumulative.csr += csr;
    cumulative.liveAdmin += liveAdmin;
    cumulative.total += total;
  }

  return { rows, cumulative };
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatPHP(n: number): string {
  return `₱${Math.round(n).toLocaleString('en-US')}`;
}

/** PHP with up to 2 decimals (for per-day CSR full-day rates that aren't whole). */
export function formatPHP2(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return `₱${rounded.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function formatHours(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return rounded.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
