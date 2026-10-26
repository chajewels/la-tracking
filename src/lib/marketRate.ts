/**
 * Today's JPY → PHP market rate, fetched in the browser for ONE purpose: pre-filling the yen
 * to send in Timesheet → Payslips → Record payment (owner 2026-10-26, docs/PAYSLIPS.md).
 *
 * This is the only exception to the ONE PESO RATE rule (CLAUDE.md): nothing here is stored,
 * no figure in the Hub is computed from it, and the payment still records the ACTUAL rate
 * (pesos received ÷ yen sent). Never fall back to system_settings.php_jpy_rate here.
 */

export interface MarketRate {
  php_per_jpy: number;
  source: string;
  as_of: string;
}

export const MARKET_RATE_QUERY_KEY = ['jpy-php-market-rate'] as const;
export const MARKET_RATE_STALE_MS = 10 * 60 * 1000;
export const MARKET_RATE_TIMEOUT_MS = 8000;

const PRIMARY_URL = 'https://open.er-api.com/v6/latest/JPY';
const FALLBACK_URL = 'https://api.frankfurter.dev/v1/latest?from=JPY&to=PHP';

/** A plausible ¥1 → ₱ rate (it has sat around 0.38–0.45); anything else is treated as a bad answer. */
export function plausibleRate(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0.2 && n < 1.0 ? n : null;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

async function getJson(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function ratesPhp(body: Record<string, unknown> | null): number | null {
  const rates = body?.rates as Record<string, unknown> | undefined;
  return plausibleRate(rates?.PHP);
}

export async function fetchJpyPhpMarketRate(
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
  timeoutMs: number = MARKET_RATE_TIMEOUT_MS,
): Promise<MarketRate | null> {
  const primary = await getJson(PRIMARY_URL, fetchImpl, timeoutMs);
  const p = ratesPhp(primary);
  if (p != null) {
    return { php_per_jpy: p, source: 'open.er-api.com', as_of: String(primary?.time_last_update_utc ?? '') };
  }
  const fallback = await getJson(FALLBACK_URL, fetchImpl, timeoutMs);
  const f = ratesPhp(fallback);
  if (f != null) {
    return { php_per_jpy: f, source: 'frankfurter.dev', as_of: String(fallback?.date ?? '') };
  }
  return null;
}

/** "0.4057" — up to 4 decimals for display. */
export function formatMarketRate(r: number): string {
  return r.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
