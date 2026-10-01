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

/**
 * Formats a value that may be a DATE-ONLY string ("2026-09-30", e.g.
 * cash_orders.order_date) for display. A bare date has no time of day, so it
 * must not go through formatPHTDisplay: new Date("2026-09-30") is UTC
 * midnight, which PHT shows as "8:00 AM PHT" — a time nobody recorded
 * (cash order timeline "Order placed", 2026-09-30). A date-only value is
 * shown as its calendar day, with no time; anything else is a timestamp and
 * takes the usual PHT display.
 */
export function formatPHTDateOrTime(d: Date | string): string {
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })
      .format(new Date(Date.UTC(y, m - 1, day)));
  }
  return formatPHTDisplay(d);
}
