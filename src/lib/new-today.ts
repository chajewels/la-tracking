import { getPHTToday } from '@/lib/date-utils';

/**
 * "New today" on the Dashboard card and in the Sales lists it links to
 * (?new=today). Today is the PHT day (CLAUDE.md TIMEZONE), not the browser's:
 * a browser in Tokyo used to start "today" at 23:00 PHT the day before.
 */
export const NEW_TODAY_PARAM = 'new';
export const NEW_TODAY_VALUE = 'today';

/** PHT midnight today, as an ISO instant for a created_at >= filter. */
export function phtStartOfTodayISO(now: Date = new Date()): string {
  const day = Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(now);
  return new Date(`${day}T00:00:00+08:00`).toISOString();
}

/** Created on the current PHT day. */
export function isCreatedTodayPHT(createdAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  return Number.isFinite(t) && t >= new Date(phtStartOfTodayISO(now)).getTime();
}

/**
 * PostgREST filter that keeps what the Sales lists show: Hub orders, and web
 * orders once paid (website orders PR 5). Keeps the card's count equal to the
 * rows behind its button.
 */
export const SHOWN_IN_SALES_LISTS_OR = 'source_channel.is.null,source_channel.neq.web,web_released_at.not.is.null,status.eq.completed';

export { getPHTToday };
