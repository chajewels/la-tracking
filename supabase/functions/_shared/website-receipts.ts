/**
 * WEBSITE RECEIPT ROUTES (docs/RECEIPTS.md; contract supabase/contracts/api.md
 * "Receipts"). Called from the `website` edge function, which has already
 * checked x-api-key and resolved the signed-in customer (customer routes).
 *
 *   GET   /me/receipts                 the customer's receipts
 *   PATCH /me/receipts/:id             addressee / purpose (issued only)
 *   GET   /me/receipts/:id/pdf?lang=   the PDF; records a download; 2nd+ = 再発行
 *   GET   /receipts/verify?code=       PUBLIC (x-api-key only): number, issue
 *                                      date, total, currency, valid/cancelled
 *
 * Every receipt write is a service-role RPC (migration 20270216100000); this
 * file never writes a table itself.
 */
import { corsHeaders, jsonResponse } from "./cors.ts";
import { cleanReceiptDetails, isReissue, normaliseVerifyCode, type ReceiptLang } from "./receipt-math.ts";
import { loadReceiptAssets, renderReceiptPdf, type ReceiptPayload } from "./receipt-pdf.ts";

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js client
type Db = any;
type AnyRec = Record<string, unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isReceiptId(v: unknown): boolean {
  return UUID_RE.test(String(v ?? ""));
}

export function receiptLang(v: unknown): ReceiptLang {
  return String(v ?? "").toLowerCase() === "en" ? "en" : "ja";
}

/** GET /me/receipts */
export async function listReceipts(db: Db, customerId: string): Promise<Response> {
  const { data, error } = await db.rpc("website_receipts_for_customer", { p_customer_id: customerId });
  if (error) throw error;
  const receipts = ((data ?? []) as AnyRec[]).map((r) => ({
    id: r.id,
    receipt_number: r.receipt_number,
    kind: r.kind,
    order_id: r.order_id,
    order_number: r.order_number,
    status: r.status,
    currency: r.currency,
    total: Number(r.total_paid ?? 0),
    issued_at: r.issued_at,
    cancelled_at: r.cancelled_at ?? null,
    addressee: r.addressee ?? null,
    purpose: r.purpose,
    downloads: Number(r.issue_count ?? 0),
  }));
  return jsonResponse({ receipts });
}

const DETAIL_STATUS: Record<string, number> = {
  not_found: 404, receipt_cancelled: 409, addressee_too_long: 400, purpose_too_long: 400, invalid_characters: 400,
};

/** PATCH /me/receipts/:id  body { addressee?, purpose? } */
export async function updateReceiptDetails(db: Db, customerId: string, receiptId: string, body: AnyRec): Promise<Response> {
  if (!isReceiptId(receiptId)) return jsonResponse({ error: "not_found" }, 404);
  const clean = cleanReceiptDetails(body.addressee, body.purpose);
  if ("error" in clean) return jsonResponse({ error: clean.error }, 400);
  const { data, error } = await db.rpc("update_website_receipt_details", {
    p_receipt_id: receiptId, p_customer_id: customerId, p_addressee: clean.addressee ?? "", p_purpose: clean.purpose,
  });
  if (error) throw error;
  const r = (data ?? {}) as AnyRec;
  if (r.error) return jsonResponse({ error: r.error, max: r.max ?? undefined }, DETAIL_STATUS[String(r.error)] ?? 400);
  return jsonResponse({ ok: true, addressee: r.addressee ?? null, purpose: r.purpose });
}

/** GET /me/receipts/:id/pdf?lang=ja|en */
export async function receiptPdf(db: Db, customerId: string, receiptId: string, langParam: unknown): Promise<Response> {
  if (!isReceiptId(receiptId)) return jsonResponse({ error: "not_found" }, 404);
  const lang = receiptLang(langParam);

  // Preflight (read only): own + issued, before anything is recorded.
  const { data: pre, error: preErr } = await db
    .from("website_receipts").select("id, status, customer_id").eq("id", receiptId).maybeSingle();
  if (preErr) throw preErr;
  if (!pre || (pre as AnyRec).customer_id !== customerId) return jsonResponse({ error: "not_found" }, 404);
  if ((pre as AnyRec).status !== "issued") return jsonResponse({ error: "receipt_cancelled" }, 409);

  // The font must be there BEFORE a download is recorded, so a missing font
  // never turns the customer's first download into a "reissue".
  const assets = await loadReceiptAssets(db);
  if (!assets.font) {
    console.error(JSON.stringify({ website_receipt_pdf: "font_missing", receipt_id: receiptId }));
    return jsonResponse({ error: "receipt_unavailable" }, 503);
  }

  const { data, error } = await db.rpc("record_website_receipt_issue", {
    p_receipt_id: receiptId, p_customer_id: customerId, p_language: lang,
  });
  if (error) throw error;
  const rec = (data ?? {}) as AnyRec;
  if (rec.error) return jsonResponse({ error: rec.error }, rec.error === "not_found" ? 404 : 409);

  const issueNo = Number(rec.issue_no);
  const t0 = performance.now();
  const bytes = await renderReceiptPdf({
    receipt: rec.receipt as unknown as ReceiptPayload,
    lang,
    issueNo,
    isReissue: isReissue(issueNo),
    downloadedAt: String(rec.downloaded_at),
  }, assets.font);
  const renderMs = Math.round(performance.now() - t0);
  const number = String((rec.receipt as AnyRec)?.receipt_number ?? "receipt");
  console.log(JSON.stringify({
    website_receipt_pdf: "rendered", receipt_number: number, issue_no: issueNo, lang,
    font_ms: assets.fontMs, font_cached: assets.fontCached,
    render_ms: renderMs, pdf_bytes: bytes.length,
  }));

  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${number}${isReissue(issueNo) ? "-reissue" : ""}.pdf"`,
      "Cache-Control": "no-store",
      "X-Receipt-Issue-No": String(issueNo),
    },
  });
}

// Per-instance dampener for the public verify route: 30 lookups per IP per
// 10 minutes. Codes are 160-bit random, so this is about load, not guessing.
const verifyHits = new Map<string, number[]>();
export function verifyRateLimited(ip: string, now = Date.now()): boolean {
  const hits = (verifyHits.get(ip) ?? []).filter((t) => now - t < 10 * 60 * 1000);
  if (hits.length >= 30) {
    verifyHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  verifyHits.set(ip, hits);
  if (verifyHits.size > 5000) verifyHits.clear();
  return false;
}

/** GET /receipts/verify?code=… — minimal answer only. */
export async function verifyReceipt(db: Db, req: Request, codeParam: unknown): Promise<Response> {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (verifyRateLimited(ip)) return jsonResponse({ error: "rate_limited" }, 429);
  const code = normaliseVerifyCode(codeParam);
  if (!code) return jsonResponse({ error: "not_found" }, 404);
  const { data, error } = await db.rpc("verify_website_receipt", { p_code: code });
  if (error) throw error;
  if (!data) return jsonResponse({ error: "not_found" }, 404);
  const r = data as AnyRec;
  return jsonResponse({
    receipt_number: r.receipt_number,
    issued_at: r.issued_at,
    total: Number(r.total ?? 0),
    currency: r.currency,
    status: r.status === "valid" ? "valid" : "cancelled",
  });
}
