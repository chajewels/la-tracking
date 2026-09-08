import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/handler.ts";

/**
 * Daily JPY -> PHP rate fetch. Called by pg_cron job `daily-fx-rate`
 * (Vault-backed service key, 00:45 UTC = 08:45 PHT).
 *
 * Writes one row per PHT day into public.fx_rates.
 *   jpy_php = PHP per 1 JPY — the same direction as
 *   system_settings.php_jpy_rate, so PHP = JPY x jpy_php.
 *
 * The `website` edge function reads the latest row and computes
 * price_php = round(price_jpy * jpy_php) at read time. Nothing is stored
 * on the variant.
 */

interface Source {
  name: string;
  url: string;
  read: (json: Record<string, unknown>) => number | null;
}

// Both are key-free public endpoints. Primary first, fallback second.
const SOURCES: Source[] = [
  {
    name: "open.er-api.com",
    url: "https://open.er-api.com/v6/latest/JPY",
    read: (j) => {
      const rates = j?.rates as Record<string, number> | undefined;
      return typeof rates?.PHP === "number" ? rates.PHP : null;
    },
  },
  {
    name: "frankfurter.app",
    url: "https://api.frankfurter.app/latest?from=JPY&to=PHP",
    read: (j) => {
      const rates = j?.rates as Record<string, number> | undefined;
      return typeof rates?.PHP === "number" ? rates.PHP : null;
    },
  },
];

/** PHT day boundary — CLAUDE.md TIMEZONE STANDARD. */
function phtToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
}

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req, { allowServiceRole: true });
  if (ctx instanceof Response) return ctx;
  if (!ctx.isService) return jsonResponse({ error: "Unauthorized" }, 401);

  const errors: string[] = [];
  let rate: number | null = null;
  let source = "";

  for (const s of SOURCES) {
    try {
      const res = await fetch(s.url, { headers: { Accept: "application/json" } });
      if (!res.ok) {
        errors.push(`${s.name}: HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      const value = s.read(json);
      // Sanity band: JPY->PHP has sat between 0.2 and 1.0 for decades. A value
      // outside it means the endpoint changed shape or inverted the pair.
      if (value === null || !Number.isFinite(value) || value <= 0.2 || value >= 1.0) {
        errors.push(`${s.name}: implausible rate ${value}`);
        continue;
      }
      rate = value;
      source = s.name;
      break;
    } catch (err) {
      errors.push(`${s.name}: ${(err as Error)?.message ?? err}`);
    }
  }

  if (rate === null) {
    console.error("fetch-fx-rate: no usable rate", errors);
    return jsonResponse({ ok: false, error: "no_rate", attempts: errors }, 502);
  }

  const date = phtToday();
  const { error } = await ctx.supabase
    .from("fx_rates")
    .upsert(
      { date, jpy_php: Number(rate.toFixed(6)), source, updated_at: new Date().toISOString() },
      { onConflict: "date" },
    );
  if (error) {
    console.error("fetch-fx-rate: upsert failed", error.message);
    return jsonResponse({ ok: false, error: error.message }, 500);
  }

  console.log(`fetch-fx-rate: ${date} jpy_php=${rate} via ${source}`);
  return jsonResponse({ ok: true, date, jpy_php: Number(rate.toFixed(6)), source, attempts: errors });
});
