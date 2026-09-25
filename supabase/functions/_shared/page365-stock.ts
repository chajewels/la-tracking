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
 *                        "will take / will flag / skipped" BEFORE import (D1).
 *   applyPage365Stock    create-cash-order / create-layaway-account: after the
 *                        order and its lines are written. Lines come from the
 *                        STORED DRAFT, never from the browser; the browser only
 *                        says which draft positions the CSR marked as service.
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
  held: number;
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
  for (const it of items) {
    if (it.kind === "service") {
      out.push({ first_word: firstWord(it.name), result: "service", stock_qty: null, checked_at: at });
      continue;
    }
    const { data, error } = await supabase.rpc("page365_match_line", { p_name: it.name });
    type MatchRow = { o_first_word: string | null; o_match_result: Page365MatchResult; o_stock_qty: number | null };
    const row = (Array.isArray(data) ? data[0] : data) as MatchRow | null | undefined;
    if (error || !row) {
      out.push(null);
      continue;
    }
    out.push({
      first_word: row.o_first_word ?? null,
      result: row.o_match_result,
      stock_qty: typeof row.o_stock_qty === "number" ? row.o_stock_qty : null,
      checked_at: at,
    });
  }
  return out;
}
