/**
 * EXTENSION RULES (owner rules 2026-10-20) — the one-time extension after a
 * forfeiture: when it ends, who may still start it, when it stops penalties,
 * when it final-forfeits, and the date the customer is told. Full text:
 * docs/PENALTY-AND-FORFEITURE.md "Extension end date and final forfeiture".
 *
 * ONE file for every caller: reactivate-account, request-extension,
 * penalty-engine and auto-forfeit-settlement import it from here, and the Hub
 * (AccountDetail, CustomerPortal, business-rules canReactivate) imports the
 * same file from src/. Pure: no network, no database. Dates are YYYY-MM-DD
 * strings, so a string comparison is a date comparison.
 */

/** Whole days after forfeited_at during which an extension can still start. */
export const EXTENSION_WINDOW_DAYS = 7;

/** The words the customer sees when the window has closed; staff see the same. */
export const EXTENSION_WINDOW_CLOSED_MESSAGE =
  "The extension request window has closed. Please contact us directly for assistance.";

const DAY_MS = 86_400_000;

/** The PHT (Asia/Manila) calendar day of an instant, as YYYY-MM-DD. */
export function phtDay(instant: string | Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(
    new Date(instant),
  );
}

function parseDay(ymd: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) throw new Error(`not a YYYY-MM-DD date: ${ymd}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function formatDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * YYYY-MM-DD plus `months` calendar months on the same day-of-month, clamped
 * to the last day of the target month (Jan 31 + 1 → Feb 28, or Feb 29 in a
 * leap year) — the same fallback account creation uses for due dates.
 */
export function addMonthsClamped(ymd: string, months: number): string {
  const [y, m, d] = parseDay(ymd);
  const targetIndex = m - 1 + months; // 0-based month, may run past 11
  const lastDay = new Date(Date.UTC(y, targetIndex + 1, 0)).getUTCDate();
  return formatDay(new Date(Date.UTC(y, targetIndex, Math.min(d, lastDay))));
}

/** YYYY-MM-DD plus `days` calendar days (negative goes back). */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = parseDay(ymd);
  return formatDay(new Date(Date.UTC(y, m - 1, d + days)));
}

/**
 * R1 — the extension ends exactly ONE month after the FORFEITURE date: the PHT
 * calendar day of forfeited_at, same day-of-month next month, clamped. Never
 * the reactivation or request date (supersedes Bug #108).
 */
export function extensionEndFromForfeiture(forfeitedAt: string): string {
  return addMonthsClamped(phtDay(forfeitedAt), 1);
}

/** Whole 24-hour periods elapsed since forfeited_at. */
export function daysSinceForfeiture(
  forfeitedAt: string,
  nowMs: number = Date.now(),
): number {
  return Math.floor((nowMs - new Date(forfeitedAt).getTime()) / DAY_MS);
}

/**
 * R2 — the extension window: open while whole days elapsed since forfeited_at
 * are <= 7, so it closes exactly 8 x 24h after forfeiture (the "7 days" of the
 * customer copy; docs/OPEN-BUGS.md logs the deliberate off-by-one). The same
 * check for the customer's request and for staff reactivation. An account with
 * no forfeited_at has no clock to run out (the portal's long-standing
 * behaviour); reactivation refuses such an account separately (R1).
 */
export function extensionWindowOpen(
  forfeitedAt: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!forfeitedAt) return true;
  return daysSinceForfeiture(forfeitedAt, nowMs) <= EXTENSION_WINDOW_DAYS;
}

/**
 * R4 — the extension has run out ON its end date: today (PHT) >= end. The
 * 00:10 UTC auto-forfeit run is 08:10 PHT, so the account final-forfeits that
 * morning, not the day after.
 */
export function extensionExpired(
  extensionEndDate: string | null | undefined,
  todayPht: string,
): boolean {
  return !!extensionEndDate && todayPht >= extensionEndDate;
}

/**
 * R3 — no penalty (new, or a waived one reinstated) for an extension_active
 * account on or after its end date.
 */
export function penaltyBlockedByExtensionEnd(
  status: string,
  extensionEndDate: string | null | undefined,
  todayPht: string,
): boolean {
  return (
    status === "extension_active" &&
    extensionExpired(extensionEndDate, todayPht)
  );
}

/**
 * R6 — the last day the customer is told to settle by: the day BEFORE the end
 * date, because the account final-forfeits on the morning of the end date.
 * Customer-facing "until / settle by" copy shows this, never the end date.
 */
export function customerSettleByDate(extensionEndDate: string): string {
  return addDays(extensionEndDate, -1);
}
