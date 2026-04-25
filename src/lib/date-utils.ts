/**
 * Returns today's date string in YYYY-MM-DD format
 * using PHT (Asia/Manila, UTC+8) as the canonical timezone.
 * Use this everywhere instead of new Date().toISOString().split('T')[0]
 */
export function getPHTToday(): string {
  return Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
  }).format(new Date());
}

/**
 * Returns current PHT datetime as a Date object
 * aligned to PHT midnight for date-only comparisons.
 */
export function getPHTNow(): Date {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }),
  );
}

/**
 * Formats a Date or ISO string as YYYY-MM-DD in PHT.
 */
export function toPHTDateString(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
  }).format(date);
}

/**
 * Formats a timestamp for display in PHT.
 * Returns e.g. "Apr 26, 2026 · 9:05 AM PHT"
 */
export function formatPHTDisplay(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return (
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date) + ' PHT'
  );
}
