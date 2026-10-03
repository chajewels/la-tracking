/**
 * ONE PESO RATE (owner decision 2026-10-03): every peso figure the website
 * shows or quotes follows the Hub's system_settings.php_jpy_rate — the same
 * rate every Hub calculation uses (CLAUDE.md CURRENCY CONVERSION STANDARD:
 * ¥1 = ₱rate; PHP = JPY × rate). The daily market rate (fx_rates, fetched
 * from open.er-api.com) is retired: its cron is unscheduled and the table is
 * history only.
 *
 * Pure parsing lives here so vitest pins it (src/test/php-jpy-rate.test.ts):
 * the setting is stored as a JSON STRING ("0.42"), sometimes a number — both
 * must read as 0.42; anything else reads as "no rate", never a fallback.
 */
export interface FxRate { jpy_php: number; as_of: string }

/** system_settings.php_jpy_rate → PHP per ¥1, or null when unusable (fail closed). */
export function parsePhpJpyRate(raw: unknown): number | null {
  let v: unknown = raw;
  if (typeof v === "string") {
    const t = v.trim();
    try { v = JSON.parse(t); } catch { v = t; }
    if (typeof v === "string") v = v.trim();
  }
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return null;
  return n;
}

/** PHT day of the setting's last change — the "as of" the website and the Catalog show. */
export function rateAsOf(updatedAt: unknown): string {
  const t = updatedAt ? Date.parse(String(updatedAt)) : NaN;
  const d = Number.isFinite(t) ? new Date(t) : new Date();
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(d);
}

/** The Hub's rate, as every peso figure on the website reads it. */
// deno-lint-ignore no-explicit-any
export async function hubFxRate(supabase: any): Promise<FxRate | null> {
  const { data, error } = await supabase
    .from("system_settings").select("value, updated_at").eq("key", "php_jpy_rate").maybeSingle();
  if (error) throw error;
  const rate = parsePhpJpyRate((data as { value?: unknown } | null)?.value);
  if (rate === null) return null;
  return { jpy_php: rate, as_of: rateAsOf((data as { updated_at?: unknown } | null)?.updated_at) };
}
