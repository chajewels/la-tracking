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
  hours: number;
  salary: number;
  isScheduled: boolean;
  isAbsence: boolean;            // scheduled day with hours < 1
  isDayoff: boolean;             // any day with hours < 1
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

// ── Template defaults (applied when a profile field is null) ────────────────

interface TemplateDefaults {
  half_day_rate: number;
  full_day_rate: number | null;
  full_day_threshold_hours: number;
  dayoff_divisor: number;
}

export const TEMPLATE_DEFAULTS: Record<TemplateType, TemplateDefaults> = {
  live_admin: { half_day_rate: 300, full_day_rate: 500, full_day_threshold_hours: 4, dayoff_divisor: 4 },
  csr:        { half_day_rate: 400, full_day_rate: null, full_day_threshold_hours: 6, dayoff_divisor: 4 },
};

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

/** Daily hours = AM session + PM session, null-safe, clamped to >= 0. */
export function dailyHours(entry: TimesheetEntry | null | undefined): number {
  if (!entry) return 0;
  const h = hoursBetween(entry.am_in, entry.am_out) + hoursBetween(entry.pm_in, entry.pm_out);
  return h > 0 ? h : 0;
}

/** Daily salary for the given worked hours under a profile.
 *  daysInMonth feeds the CSR full-day rate derivation. */
export function dailySalary(hours: number, profile: TimesheetProfile, daysInMonth: number): number {
  if (hours < 1) return 0;
  const defaults = TEMPLATE_DEFAULTS[profile.template_type];
  const threshold = profile.full_day_threshold_hours ?? defaults.full_day_threshold_hours;

  if (profile.template_type === 'live_admin') {
    const fullRate = profile.full_day_rate ?? defaults.full_day_rate ?? 500;
    const halfRate = profile.half_day_rate ?? defaults.half_day_rate;
    return hours > (threshold - 0.01) ? fullRate : halfRate;
  }

  // csr
  const basic = profile.basic_salary ?? 0;
  const divisor = profile.dayoff_divisor ?? defaults.dayoff_divisor;
  const fullRate = Math.round((basic / Math.max(1, daysInMonth - divisor)) * 10000) / 10000;
  const halfRate = profile.half_day_rate ?? defaults.half_day_rate;
  return hours > (threshold - 0.01) ? fullRate : halfRate;
}

/** Bucket day numbers (1..daysInMonth) into Mon–Sun weeks.
 *  Week 1 = day 1 through the first Sunday; capped at 4 buckets — any
 *  5th-week days roll into bucket 4 (index 3). Returns an array of 4 arrays
 *  of day numbers. */
export function weekBuckets(monthKey: string, daysInMonth: number): number[][] {
  const buckets: number[][] = [[], [], [], []];
  let bucketIdx = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const dow = isoDowOf(dateStrOf(monthKey, day));
    const idx = Math.min(bucketIdx, 3);
    buckets[idx].push(day);
    // Sunday closes the current week → advance the bucket pointer.
    if (dow === 7) bucketIdx++;
  }
  return buckets;
}

// ── Month computation ───────────────────────────────────────────────────────

export function computeMonth(
  monthKey: string,
  entries: TimesheetEntry[],
  profile: TimesheetProfile,
): MonthComputation {
  const daysInMonth = daysInMonthOf(monthKey);
  const entryByDate = new Map<string, TimesheetEntry>();
  for (const e of entries) {
    if (monthKeyFromDate(e.work_date) === monthKey) entryByDate.set(e.work_date, e);
  }
  const workDays = new Set(profile.work_days ?? []);

  const days: DayComputation[] = [];
  let total_hours = 0;
  let sumDailySalary = 0;
  let dayoff_count = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const date = dateStrOf(monthKey, day);
    const dow = isoDowOf(date);
    const entry = entryByDate.get(date) ?? null;
    const hours = entry ? dailyHours(entry) : 0;
    const salary = dailySalary(hours, profile, daysInMonth);
    const isScheduled = workDays.has(dow);
    const isAbsence = isScheduled && hours < 1;
    const isDayoff = hours < 1;

    total_hours += hours;
    sumDailySalary += salary;
    if (hours < 1) dayoff_count += 1;

    days.push({ date, dow, hours, salary, isScheduled, isAbsence, isDayoff, entry });
  }

  let gross: number;
  let allowance_paid: number;
  let forfeitedWeeks = 0;

  if (profile.template_type === 'csr') {
    gross = profile.basic_salary != null ? Math.min(sumDailySalary, profile.basic_salary) : sumDailySalary;

    // Allowance absence deduction — LOCKED. A week with >= 3 absences forfeits
    // its quarter of the monthly allowance.
    const absenceByDay = new Map<number, boolean>();
    for (const d of days) {
      absenceByDay.set(Number(d.date.slice(8, 10)), d.isAbsence);
    }
    const buckets = weekBuckets(monthKey, daysInMonth);
    for (const bucket of buckets) {
      const absences = bucket.reduce((n, day) => n + (absenceByDay.get(day) ? 1 : 0), 0);
      if (absences >= 3) forfeitedWeeks += 1;
    }
    const allowance = profile.allowance ?? 0;
    allowance_paid = allowance * (1 - Math.min(forfeitedWeeks, 4) / 4);
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
  const daysInMonth = daysInMonthOf(monthKey);
  const dates: string[] = [];
  for (let day = 1; day <= daysInMonth; day++) dates.push(dateStrOf(monthKey, day));

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
