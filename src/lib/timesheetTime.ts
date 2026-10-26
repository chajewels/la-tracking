/**
 * Wall-clock ↔ instant helpers for timesheet punches, in a profile's IANA timezone
 * (default Asia/Manila). Moved verbatim from src/pages/Timesheet.tsx (2026-10-26) so the
 * Consolidation correction dialog composes punches exactly the way My Timesheet does.
 */

/** Offset (ms) such that asUTC(localFieldsOf(date in tz)) − date = offset. */
export function getTzOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    Number(map.hour), Number(map.minute), Number(map.second),
  );
  return asUTC - date.getTime();
}

/** Convert a wall-clock 'HH:MM' on `workDate` in `tz` to a UTC ISO instant. */
export function zonedWallToISO(workDate: string, hhmm: string, tz: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = workDate.split('-').map(Number);
  const naiveUTC = Date.UTC(y, mo - 1, d, h || 0, m || 0, 0);
  const offset = getTzOffsetMs(new Date(naiveUTC), tz);
  return new Date(naiveUTC - offset).toISOString();
}

/** Extract 'HH:MM' wall-clock in `tz` from a timestamptz ISO. */
export function isoToWall(iso: string | null, tz: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit',
  }).format(d);
}
