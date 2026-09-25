// deno-lint-ignore-file no-explicit-any
/**
 * page365-stock — Page365 invoice lines reduce storefront stock, once.
 *
 * The rules live in SQL (migration 20260926120000_page365_stock_sync.sql):
 * page365_match_line decides what a line matches, page365_apply_stock claims
 * each line in the page365_stock_lines ledger and only then takes stock, and a
 * trigger on both order tables gives it back when the order dies. This file is
 * the edge side of that and deliberately decides nothing about stock itself.
 *
 *   previewPage365Stock  page365-fetch-order: read-only match per draft line,
 *                        stored on the draft so the review screen can show
 *                        what the import will do BEFORE import (D1).
 *   readStockMode        which of the two import behaviours is live (below).
 *   applyPage365Stock    create-cash-order / create-layaway-account: after the
 *                        order and its lines are written. Lines come from the
 *                        STORED DRAFT, never from the browser; the browser only
 *                        says which draft positions the CSR marked as service.
 *
 * TWO MODES (system_settings.page365_stock_mode, migration 20260928100000):
 *   inventory_sync  (live since PR 2) Page365 is the stock master. An import
 *                   claims, matches and flags each line exactly as before but
 *                   NEVER changes website stock; stock follows the Page365
 *                   inventory fetch (docs/PAGE365-IMPORT.md "INVENTORY").
 *   invoice         the #195 behaviour (an import takes stock) — the rollback.
 * A product switched to "Don't sync with Page365"
 * (website_products.page365_sync_disabled) never has its stock moved by an
 * import in either mode; the match is still recorded.
 *
 * A business outcome (no match, several products, several sizes, not enough
 * stock) is never an error — the order stands and the line is flagged. Only a
 * bad request or a database error throws, and the caller rolls the order back.
 */

// The service-role client, taken as _shared/order-extras.ts takes it: a
// structural type sends supabase-js into "excessively deep" instantiation
// (TS2589) at the call sites.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = any;

/** Twin of SQL public.page365_first_word: the first whitespace-delimited word,
 *  upper-cased, ignoring leading blanks incl. U+3000 and NBSP. Null when the
 *  name is blank. JS `\s` already covers U+3000 and U+00A0. */
export function firstWord(name: string | null | undefined): string | null {
  const m = String(name ?? "").match(/^\s*(\S+)/);
  return m ? m[1].toUpperCase() : null;
}

export type Page365MatchResult =
  | "matched" | "unmatched" | "ambiguous_sku" | "no_variant" | "ambiguous_variant";

/** What the fetch stores on each draft item. `result: 'service'` for a line the
 *  parser recognised as a resize/service fee — skipped, never flagged. */
export interface Page365StockMatch {
  first_word: string | null;
  result: Page365MatchResult | "service";
  stock_qty: number | null;
  checked_at: string;
  /** The matched website variant (result 'matched' only). Lets the fetch reuse
   *  the catalogue's own copy of the main photo instead of storing a second
   *  file. Absent on drafts fetched before PR 2. */
  variant_id?: string | null;
  /** The matched product is switched to "Don't sync with Page365". Null when
   *  it could not be read. Absent on drafts fetched before PR 2. */
  sync_disabled?: boolean | null;
}

export type Page365StockMode = "inventory_sync" | "invoice";

/** Twin of the SQL rule: only an explicit 'invoice' brings back the #195
 *  decrement; anything else (incl. a missing row) is inventory_sync. */
export function stockModeFrom(value: unknown): Page365StockMode {
  return value === "invoice" ? "invoice" : "inventory_sync";
}

export async function readStockMode(supabase: SupabaseLike): Promise<Page365StockMode> {
  const { data } = await supabase
    .from("system_settings").select("value").eq("key", "page365_stock_mode").maybeSingle();
  return stockModeFrom((data as { value?: unknown } | null)?.value);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** The draft positions (1-based) the CSR marked as a service. Anything that is
 *  not a positive integer is dropped rather than trusted; duplicates collapse. */
export function normaliseServiceLineNos(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<number>();
  for (const x of v) {
    const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN;
    if (Number.isInteger(n) && n >= 1 && n <= 10_000) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Validate the Page365 part of a create request BEFORE the order is written.
 * A Page365 import must name its draft: the draft is where the lines stock is
 * taken from. Returns the draft id, or an error message for a 400/409.
 */
export async function checkPage365Draft(
  supabase: SupabaseLike,
  page365No: unknown,
  draftId: unknown,
): Promise<{ ok: true; draftId: string } | { ok: false; status: number; error: string }> {
  if (!isUuid(draftId)) {
    return { ok: false, status: 400, error: "page365_draft_id is required for a Page365 import — fetch the link again." };
  }
  const { data: row, error } = await supabase
    .from("page365_drafts").select("id, page365_no").eq("id", draftId).maybeSingle();
  if (error) return { ok: false, status: 500, error: `Could not read the Page365 draft: ${error.message}` };
  const data = row as { page365_no: number | string } | null;
  if (!data) return { ok: false, status: 409, error: "The Page365 draft no longer exists — fetch the link again." };
  if (Number(data.page365_no) !== Number(page365No)) {
    return { ok: false, status: 409, error: `The Page365 draft is for invoice ${data.page365_no}, not ${page365No}.` };
  }
  return { ok: true, draftId };
}

export interface Page365StockResult {
  ok: true;
  page365_no: number;
  /** PR 2. Absent from a pre-PR 2 database. */
  mode?: Page365StockMode;
  held: number;
  /** PR 2: matched lines recorded without moving stock (inventory_sync). */
  recorded?: number;
  /** PR 2: matched lines on a product switched to "Don't sync with Page365". */
  sync_off?: number;
  flagged: number;
  services: number;
  already_claimed: number;
  lines: Array<{
    line_no: number; name: string; first_word: string | null; match_result: string;
    stock_state: string; flag: string | null; stock_seen: number | null;
  }> | null;
}

/** Claim-and-reduce. Throws on a request or database error (caller rolls the
 *  order back); returns the per-line outcome otherwise. */
export async function applyPage365Stock(
  supabase: SupabaseLike,
  kind: "cash" | "layaway",
  orderId: string,
  draftId: string,
  serviceLineNos: number[],
  actorId: string | null,
): Promise<Page365StockResult> {
  const { data, error } = await supabase.rpc("page365_apply_stock", {
    p_order_kind: kind,
    p_order_id: orderId,
    p_draft_id: draftId,
    p_service_line_nos: serviceLineNos,
    p_actor: actorId,
  });
  if (error) throw new Error(`Could not apply Page365 stock: ${error.message}`);
  const result = data as Page365StockResult | null;
  if (!result || result.ok !== true) throw new Error("Could not apply Page365 stock: no result");
  return result;
}

/**
 * Read-only preview for the review screen. One matcher call per product line
 * (an invoice has a handful). If the matcher is not there yet — the SQL has not
 * been run — every line comes back null ("not checked") and the fetch goes on:
 * a preview must never block a fetch.
 */
export async function previewPage365Stock(
  supabase: SupabaseLike,
  items: Array<{ kind: "product" | "service"; name: string }>,
): Promise<Array<Page365StockMatch | null>> {
  const at = new Date().toISOString();
  const out: Array<Page365StockMatch | null> = [];
  const productOf: Array<string | null> = [];
  for (const it of items) {
    productOf.push(null);
    if (it.kind === "service") {
      out.push({ first_word: firstWord(it.name), result: "service", stock_qty: null, checked_at: at });
      continue;
    }
    const { data, error } = await supabase.rpc("page365_match_line", { p_name: it.name });
    type MatchRow = {
      o_first_word: string | null; o_match_result: Page365MatchResult; o_stock_qty: number | null;
      o_product_id: string | null; o_variant_id: string | null;
    };
    const row = (Array.isArray(data) ? data[0] : data) as MatchRow | null | undefined;
    if (error || !row) {
      out.push(null);
      continue;
    }
    productOf[productOf.length - 1] = row.o_match_result === "matched" ? row.o_product_id ?? null : null;
    out.push({
      first_word: row.o_first_word ?? null,
      result: row.o_match_result,
      stock_qty: typeof row.o_stock_qty === "number" ? row.o_stock_qty : null,
      checked_at: at,
      variant_id: row.o_match_result === "matched" ? row.o_variant_id ?? null : null,
      sync_disabled: null,
    });
  }

  // The switch, one read for every matched product. Unreadable = null (the
  // review screen then says nothing about it); never a guess.
  const ids = [...new Set(productOf.filter((x): x is string => !!x))];
  if (ids.length) {
    const { data, error } = await supabase
      .from("website_products").select("id, page365_sync_disabled").in("id", ids);
    if (!error && Array.isArray(data)) {
      const off = new Map((data as { id: string; page365_sync_disabled: boolean | null }[])
        .map(r => [r.id, r.page365_sync_disabled === true]));
      productOf.forEach((pid, n) => {
        const m = out[n];
        if (pid && m && off.has(pid)) m.sync_disabled = off.get(pid)!;
      });
    }
  }
  return out;
}
