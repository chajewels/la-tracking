/**
 * Timesheet → Consolidation corrections — pure rules, no I/O (owner-confirmed 2026-10-26 21:13;
 * docs/TIMESHEET-SPEC.md "Corrections (Admin + Brenda)"; migration
 * 20270202100000_timesheet_corrections.sql). The database re-checks everything.
 */
import { isoToWall } from '@/lib/timesheetTime';

export type PunchKey = 'am_in' | 'am_out' | 'pm_in' | 'pm_out';
export const PUNCH_KEYS: PunchKey[] = ['am_in', 'am_out', 'pm_in', 'pm_out'];
export const PUNCH_LABEL: Record<PunchKey, string> = {
  am_in: 'AM in', am_out: 'AM out', pm_in: 'PM in', pm_out: 'PM out',
};

export type Punches = Record<PunchKey, string | null>;

export interface TimesheetCorrection {
  id: string;
  user_id: string;
  work_date: string; // YYYY-MM-DD
  old_punches: Punches;
  new_punches: Punches;
  comment: string;
  corrected_by: string;
  corrected_by_name: string | null;
  corrected_at: string;
}

export type CorrectionsState = { available: false } | { available: true; canCorrect: boolean; corrections: TimesheetCorrection[] };

export const LOCKED_MESSAGE = 'This day was corrected — ask Admin or Brenda to change it.';
export const COMMENT_MIN = 3;
export const COMMENT_MAX = 500;

function punchesOf(v: unknown): Punches {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out = {} as Punches;
  for (const k of PUNCH_KEYS) out[k] = typeof o[k] === 'string' && o[k] ? String(o[k]) : null;
  return out;
}

export function normaliseCorrections(raw: unknown): TimesheetCorrection[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((r) => {
    const c = r as Record<string, unknown>;
    return {
      id: String(c.id),
      user_id: String(c.user_id),
      work_date: String(c.work_date).slice(0, 10),
      old_punches: punchesOf(c.old_punches),
      new_punches: punchesOf(c.new_punches),
      comment: String(c.comment ?? ''),
      corrected_by: String(c.corrected_by ?? ''),
      corrected_by_name: (c.corrected_by_name as string | null) ?? null,
      corrected_at: String(c.corrected_at ?? ''),
    };
  });
}

export function correctionKey(userId: string, workDate: string): string {
  return `${userId}|${workDate}`;
}

/** Every correction per (user, day), newest first. */
export function correctionsByDay(list: TimesheetCorrection[]): Map<string, TimesheetCorrection[]> {
  const map = new Map<string, TimesheetCorrection[]>();
  for (const c of list) {
    const k = correctionKey(c.user_id, c.work_date);
    const arr = map.get(k) ?? [];
    arr.push(c);
    map.set(k, arr);
  }
  for (const arr of map.values()) arr.sort((a, b) => b.corrected_at.localeCompare(a.corrected_at));
  return map;
}

export function commentProblem(comment: string): string | null {
  const t = comment.trim();
  if (t.length < COMMENT_MIN) return 'Write a reason for the correction (at least 3 characters).';
  if (t.length > COMMENT_MAX) return 'The reason is over 500 characters.';
  return null;
}

/** "AM in 09:00 → 10:00" for each punch that changed, in the staff member's timezone. */
export function changedPunchLines(c: Pick<TimesheetCorrection, 'old_punches' | 'new_punches'>, tz: string): string[] {
  const out: string[] = [];
  for (const k of PUNCH_KEYS) {
    const before = c.old_punches[k];
    const after = c.new_punches[k];
    const same = before === after || (before != null && after != null && new Date(before).getTime() === new Date(after).getTime());
    if (same) continue;
    out.push(`${PUNCH_LABEL[k]} ${isoToWall(before, tz) || '—'} → ${isoToWall(after, tz) || '—'}`);
  }
  return out;
}

/** '2026-10-20' → '20 Oct 2026'. */
export function dayLabel(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** A correction's time, in Philippine time (the Hub's canonical zone). */
export function correctedAtLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d)} PHT`;
}

/** "Corrected by Brendalyn Bumagat on 21 Oct 2026: Forgot to punch out". */
export function correctionSummary(c: TimesheetCorrection): string {
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', day: '2-digit', month: 'short', year: 'numeric' })
    .format(new Date(c.corrected_at));
  return `Corrected by ${c.corrected_by_name || 'Admin'} on ${when}: ${c.comment}`;
}

export function isDayLockedError(err: unknown): boolean {
  const e = err as { message?: string; details?: string } | null;
  return /day_locked/.test(`${e?.message ?? ''} ${e?.details ?? ''}`);
}

export function correctionRefusal(code: string | undefined): string {
  switch (code) {
    case 'permission_denied': return 'Only Admin and Brenda can correct a timesheet day.';
    case 'staff_not_found': return 'This staff member has no timesheet profile.';
    case 'comment_required': return 'Write a reason for the correction (3 to 500 characters).';
    case 'invalid_date': return 'Days can be corrected from 1 April 2026 (1 June 2026 until the database update) up to today.';
    case 'invalid_punch': return 'Each time must be on this day (PM out may run past midnight, up to 06:00).';
    case 'invalid_order': return 'The times must be in order: AM in, AM out, PM in, PM out.';
    case 'save_failed': return 'The correction was not saved. Try again.';
    default: return 'Something went wrong. Try again in a moment.';
  }
}
