/**
 * WEBSITE RECEIPT PDF (領収書) — rendered on the server, never in a browser
 * (owner decisions 2026-10-27; docs/RECEIPTS.md).
 *
 * FONT: the WHOLE Noto Sans JP font (OFL), embedded WITHOUT subsetting.
 * pdf-lib 1.17.1 + @pdf-lib/fontkit 1.1.1 subsetting drops most glyphs of
 * Noto Sans JP (TTF and OTF) — proven 2026-10-27 in pdf.js and macOS PDFKit —
 * so subsetting is off. The font is NOT in the repo (5.7 MB; a server-side
 * bundled function may be at most 5 MB): it is read from the PRIVATE bucket
 * receipt-assets at RECEIPT_FONT_PATH and kept in memory per instance.
 * Follow-up if Supabase is too slow: a pre-cut font (JIS level 1+2 kanji,
 * kana, Latin) in the same place.
 *
 * NO SEAL / STAMP (owner 2026-10-27): the receipt carries no company seal
 * image and no stamp mark. Authenticity is the QR + verify code.
 *
 * TOTALS BLOCK (owner 2026-10-27, like the Hub invoice): 小計（税抜）,
 * 消費税（10%）, 割引 (always, as a minus), 送料 (always), 代引手数料 and
 * 延滞金 only when > 0, 合計（税込） = the money received. Figures come from
 * the stored receipt (web_receipt_snapshot); nothing is recomputed here.
 * Pesos print as "PHP 42,000" (the font has no ₱); no yen figure and no
 * exchange rate on a peso receipt. No layaway wording.
 * No form fields. Every render logs one timing line.
 */
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";
import QRCode from "npm:qrcode@1.5.4";
import {
  methodLabel, purposeFor, receiptDate, receiptMinus, receiptMoney,
  type ReceiptCurrency, type ReceiptLang,
} from "./receipt-math.ts";

export const RECEIPT_ASSETS_BUCKET = "receipt-assets";
export const RECEIPT_FONT_PATH = "fonts/NotoSansJP-Regular.ttf";
export const RECEIPT_VERIFY_URL = "https://chajewelsjp.com/receipts/verify";

export const ISSUER = {
  nameJa: "Ｃｈａ　Ｊｅｗｅｌｓ株式会社",
  nameEn: "Cha Jewels Co., Ltd.",
  postal: "〒124-0012",
  address: "東京都葛飾区立石6丁目5番1号タイムマンション301",
  tel: "03-6657-6129",
  email: "sales@chajewelsjp.com",
  registration: "T7011801044120",
} as const;

type AnyRec = Record<string, unknown>;

export interface ReceiptPayload {
  receipt_number: string;
  order_number: string;
  currency: ReceiptCurrency;
  lines: AnyRec;
  total_paid: number;
  penalty_total: number;
  taxable_total: number;
  subtotal: number;
  tax_amount: number;
  fx_rate_used: number | null;
  addressee: string | null;
  purpose: string;
  verify_code: string;
  issued_at: string;
}

export interface RenderInput {
  receipt: ReceiptPayload;
  lang: ReceiptLang;
  issueNo: number;
  isReissue: boolean;
  downloadedAt: string;
}

export interface ReceiptRow {
  label: string;
  value: string;
  emphasis?: boolean;
  indent?: boolean;
  /** A hairline above the row (the start of the totals block). */
  rule?: boolean;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const W = {
  ja: {
    title: "領　収　書", reissue: "再発行", honorific: "様", amountLabel: "金額", taxIncl: "（税込）",
    purposeLabel: "但し", received: "上記正に領収いたしました。",
    number: "領収書番号", date: "発行日", order: "ご注文番号", reissued: (n: number, d: string) => `再発行（${n}回目の発行）　${d}`,
    details: "内訳", subtotal: "小計（税抜）", tax: "消費税（10%）", discount: "割引", shipping: "送料",
    cod: "代引手数料", penalties: "延滞金", total: "合計（税込）", payments: "お支払い方法",
    stamp: "電子発行のため収入印紙の貼付はありません。",
    issuer: "発行者", registration: "登録番号",
    verify: "この領収書の確認", verifyAt: "chajewelsjp.com/receipts/verify",
    item: "品名", quantity: "数量", unitEx: "単価（税抜）", amountEx: "金額（税抜）",
  },
  en: {
    title: "RECEIPT", reissue: "REISSUED", honorific: "", amountLabel: "Amount received", taxIncl: " (tax included)",
    purposeLabel: "For", received: "Received with thanks.",
    number: "Receipt No.", date: "Date of issue", order: "Order No.", reissued: (n: number, d: string) => `Reissued (issue no. ${n})  ${d}`,
    details: "Details", subtotal: "Subtotal (excl. tax)", tax: "10% Tax", discount: "Discount", shipping: "Shipping fee",
    cod: "COD fee", penalties: "Late fee", total: "Total (tax incl.)", payments: "Payment",
    stamp: "Issued electronically; no revenue stamp is affixed.",
    issuer: "Issued by", registration: "Registration No.",
    verify: "Verify this receipt", verifyAt: "chajewelsjp.com/receipts/verify",
    item: "Item", quantity: "Qty", unitEx: "Unit price (excl. tax)", amountEx: "Amount (excl. tax)",
  },
} as const;

export interface ItemTable {
  header: [string, string, string, string];
  rows: [string, string, string, string][];
}

/** The item table, EXCLUDING tax (stored unit_price_ex / line_ex). Pure: unit-tested. */
export function itemTable(r: ReceiptPayload, lang: ReceiptLang): ItemTable {
  const w = W[lang];
  const items = (Array.isArray(r.lines?.items) ? r.lines.items : []) as AnyRec[];
  return {
    header: [w.item, w.quantity, w.unitEx, w.amountEx],
    rows: items.map((i) => [
      String(i.title ?? "").trim(),
      String(num(i.quantity) || 1),
      receiptMoney(num(i.unit_price_ex), r.currency),
      receiptMoney(num(i.line_ex), r.currency),
    ]),
  };
}

/** The totals block, in print order, from the stored figures. Pure: unit-tested. */
export function totalsRows(r: ReceiptPayload, lang: ReceiptLang): ReceiptRow[] {
  const w = W[lang];
  const L = r.lines ?? {};
  const cur = r.currency;
  const rows: ReceiptRow[] = [
    { label: w.subtotal, value: receiptMoney(num(r.subtotal), cur), rule: true },
    { label: w.tax, value: receiptMoney(num(r.tax_amount), cur) },
    { label: w.discount, value: receiptMinus(num(L.discount_total), cur) },
    { label: w.shipping, value: receiptMoney(num(L.shipping), cur) },
  ];
  if (num(L.cod_fee) > 0) rows.push({ label: w.cod, value: receiptMoney(num(L.cod_fee), cur) });
  if (num(r.penalty_total) > 0) rows.push({ label: w.penalties, value: receiptMoney(num(r.penalty_total), cur) });
  rows.push({ label: w.total, value: receiptMoney(num(r.total_paid), cur), emphasis: true });
  return rows;
}


/** One line per payment method actually used (points excluded; store credit included). */
export function paymentRows(r: ReceiptPayload, lang: ReceiptLang): ReceiptRow[] {
  const pays = (Array.isArray(r.lines?.payments) ? r.lines.payments : []) as AnyRec[];
  return pays.map((p) => ({ label: methodLabel(String(p.method ?? ""), lang), value: receiptMoney(num(p.amount), r.currency) }));
}

export function verifyUrl(code: string): string {
  return `${RECEIPT_VERIFY_URL}?code=${encodeURIComponent(code)}`;
}

// ---------------------------------------------------------------- rendering
const PAGE: [number, number] = [595.28, 841.89]; // A4
const M = 48;
const INK = rgb(0.1, 0.1, 0.18);
const MUTED = rgb(0.42, 0.42, 0.42);
const GOLD = rgb(0.79, 0.64, 0.15);
const RED = rgb(0.72, 0.1, 0.1);

function fit(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

function right(page: PDFPage, font: PDFFont, text: string, xRight: number, y: number, size: number, color = INK) {
  page.drawText(text, { x: xRight - font.widthOfTextAtSize(text, size), y, size, font, color });
}

function drawQr(page: PDFPage, text: string, x: number, y: number, size: number) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const cell = size / n;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) {
        page.drawRectangle({ x: x + c * cell, y: y + (n - 1 - r) * cell, width: cell, height: cell, color: rgb(0, 0, 0) });
      }
    }
  }
}

/** The PDF bytes. Pure apart from the libraries: the font is passed in. */
export async function renderReceiptPdf(input: RenderInput, fontBytes: Uint8Array): Promise<Uint8Array> {
  const { receipt: r, lang } = input;
  const w = W[lang];
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`${lang === "ja" ? "領収書" : "Receipt"} ${r.receipt_number}`);
  doc.setAuthor(lang === "ja" ? ISSUER.nameJa : ISSUER.nameEn);
  doc.setCreator("Cha Jewels");
  doc.setProducer("Cha Jewels");
  doc.setCreationDate(new Date(input.downloadedAt));
  doc.setModificationDate(new Date(input.downloadedAt));
  // locl OFF: in a Latin run fontkit's locl swaps the digits for alternates
  // that pdf.js / Acrobat space wide ("K1 8", "TEL 0 3"). The font's default
  // glyphs are already the Japanese forms (checked 2026-10-27).
  const font = await doc.embedFont(fontBytes, { subset: false, features: { locl: false } });

  const page = doc.addPage(PAGE);
  const [pw, ph] = PAGE;
  const xr = pw - M;
  let y = ph - M;

  page.drawRectangle({ x: M, y: ph - M + 10, width: pw - 2 * M, height: 3, color: GOLD });

  // Title, centred; reissue mark top right.
  const title = w.title;
  page.drawText(title, { x: (pw - font.widthOfTextAtSize(title, 26)) / 2, y: y - 30, size: 26, font, color: INK });
  if (input.isReissue) {
    const tw = font.widthOfTextAtSize(w.reissue, 14);
    page.drawRectangle({ x: xr - tw - 16, y: y - 34, width: tw + 16, height: 26, borderColor: RED, borderWidth: 1.5 });
    page.drawText(w.reissue, { x: xr - tw - 8, y: y - 27, size: 14, font, color: RED });
  }
  y -= 70;

  // Meta, right column.
  const meta: [string, string][] = [
    [w.number, r.receipt_number],
    [w.date, receiptDate(r.issued_at, lang)],
    [w.order, r.order_number],
  ];
  let my = y;
  for (const [k, v] of meta) {
    right(page, font, `${k}　${v}`, xr, my, 9.5);
    my -= 14;
  }
  if (input.isReissue) {
    right(page, font, w.reissued(input.issueNo, receiptDate(input.downloadedAt, lang)), xr, my, 8.5, RED);
  }

  // Addressee, left.
  const addr = (r.addressee ?? "").trim();
  const addrText = lang === "ja" ? `${addr || "　　　　　　　　　　"}　${w.honorific}` : (addr || " ");
  if (lang === "en") page.drawText("Received from", { x: M, y: y + 2, size: 8.5, font, color: MUTED });
  page.drawText(fit(font, addrText, 15, 300), { x: M, y: y - 16, size: 15, font, color: INK });
  page.drawLine({ start: { x: M, y: y - 22 }, end: { x: M + 310, y: y - 22 }, thickness: 0.8, color: INK });
  y -= 70;

  // Amount box.
  const amount = `${receiptMoney(Number(r.total_paid), r.currency)}${lang === "ja" ? "-" : ""}`;
  page.drawRectangle({ x: M, y: y - 44, width: pw - 2 * M, height: 54, color: rgb(0.965, 0.957, 0.937) });
  page.drawText(w.amountLabel, { x: M + 16, y: y - 22, size: 11, font, color: MUTED });
  const amtSize = 24;
  const tail = w.taxIncl;
  const amtW = font.widthOfTextAtSize(amount, amtSize);
  const tailW = font.widthOfTextAtSize(tail, 11);
  const ax = (pw - amtW - tailW) / 2 + 30;
  page.drawText(amount, { x: ax, y: y - 26, size: amtSize, font, color: INK });
  page.drawText(tail, { x: ax + amtW + 4, y: y - 24, size: 11, font, color: INK });
  y -= 70;

  page.drawText(fit(font, `${w.purposeLabel}　${purposeFor(r.purpose, lang)}`, 11, pw - 2 * M), { x: M, y, size: 11, font, color: INK });
  y -= 18;
  page.drawText(w.received, { x: M, y, size: 10, font, color: INK });
  y -= 30;

  // Breakdown.
  page.drawText(w.details, { x: M, y, size: 10, font, color: MUTED });
  y -= 6;
  page.drawLine({ start: { x: M, y }, end: { x: xr, y }, thickness: 0.6, color: GOLD });
  y -= 15;
  // Item table (excl. tax): 品名 | 数量 | 単価（税抜） | 金額（税抜）.
  const table = itemTable(r, lang);
  const colQty = xr - 230;
  const colUnit = xr - 110;
  const hs = 8.5;
  page.drawText(table.header[0], { x: M, y, size: hs, font, color: MUTED });
  right(page, font, table.header[1], colQty, y, hs, MUTED);
  right(page, font, table.header[2], colUnit, y, hs, MUTED);
  right(page, font, table.header[3], xr, y, hs, MUTED);
  y -= 15;
  const maxItems = 14;
  for (const [title, qty, unit, amount] of table.rows.slice(0, maxItems)) {
    page.drawText(fit(font, title, 9.5, colQty - M - 40), { x: M, y, size: 9.5, font, color: INK });
    right(page, font, qty, colQty, y, 9.5);
    right(page, font, unit, colUnit, y, 9.5);
    right(page, font, amount, xr, y, 9.5);
    y -= 14;
  }
  if (table.rows.length > maxItems) {
    page.drawText(`… +${table.rows.length - maxItems}`, { x: M, y, size: 9, font, color: MUTED });
    y -= 14;
  }

  // Totals block.
  const rows = totalsRows(r, lang);
  for (const row of rows) {
    const size = row.emphasis ? 11 : 9.5;
    if (row.rule) {
      y -= 2;
      page.drawLine({ start: { x: M, y: y + 12 }, end: { x: xr, y: y + 12 }, thickness: 0.3, color: MUTED });
    }
    if (row.emphasis) {
      y -= 4;
      page.drawLine({ start: { x: M, y: y + 13 }, end: { x: xr, y: y + 13 }, thickness: 0.4, color: MUTED });
    }
    const x = colQty - 60;
    page.drawText(fit(font, row.label, size, xr - x - 110), { x, y, size, font, color: INK });
    if (row.value) right(page, font, row.value, xr, y, size);
    y -= row.emphasis ? 18 : 14;
  }
  y -= 4;

  const pays = paymentRows(r, lang);
  if (pays.length) {
    page.drawText(w.payments, { x: M, y, size: 10, font, color: MUTED });
    y -= 14;
    for (const p of pays) {
      page.drawText(fit(font, p.label, 9.5, 300), { x: M + 12, y, size: 9.5, font, color: INK });
      right(page, font, p.value, xr, y, 9.5);
      y -= 14;
    }
    y -= 4;
  }


  // Footer: QR + verify code (left), issuer (right), revenue-stamp note.
  const fy = M + 40;
  const qrSize = 74;
  drawQr(page, verifyUrl(r.verify_code), M, fy, qrSize);
  page.drawText(w.verify, { x: M + qrSize + 10, y: fy + qrSize - 10, size: 8.5, font, color: MUTED });
  page.drawText(w.verifyAt, { x: M + qrSize + 10, y: fy + qrSize - 22, size: 8.5, font, color: INK });
  page.drawText(r.verify_code.slice(0, 20), { x: M + qrSize + 10, y: fy + qrSize - 36, size: 8, font, color: INK });
  page.drawText(r.verify_code.slice(20), { x: M + qrSize + 10, y: fy + qrSize - 47, size: 8, font, color: INK });

  const ix = pw / 2 - 30;
  const issuerLines = [
    { t: w.issuer, s: 8, c: MUTED },
    { t: lang === "ja" ? ISSUER.nameJa : ISSUER.nameEn, s: 11, c: INK },
    { t: ISSUER.postal, s: 7.5, c: INK },
    { t: ISSUER.address, s: 7.5, c: INK },
    { t: `TEL ${ISSUER.tel}　${ISSUER.email}`, s: 7.5, c: INK },
    { t: `${w.registration} ${ISSUER.registration}`, s: 7.5, c: INK },
  ];
  let iy = fy + qrSize + 14;
  for (const l of issuerLines) {
    page.drawText(fit(font, l.t, l.s, xr - ix - 4), { x: ix, y: iy, size: l.s, font, color: l.c });
    iy -= l.s + 5;
  }

  page.drawText(w.stamp, { x: M, y: M + 10, size: 8, font, color: MUTED });
  page.drawRectangle({ x: M, y: M - 6, width: pw - 2 * M, height: 1.5, color: GOLD });

  return await doc.save({ useObjectStreams: true });
}

// ------------------------------------------------------------- the assets
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js client
type Db = any;

let fontCache: Uint8Array | null = null;

async function download(db: Db, path: string): Promise<Uint8Array | null> {
  const { data, error } = await db.storage.from(RECEIPT_ASSETS_BUCKET).download(path);
  if (error || !data) return null;
  return new Uint8Array(await (data as Blob).arrayBuffer());
}

export interface ReceiptAssets {
  font: Uint8Array | null;
  fontMs: number;
  fontCached: boolean;
}

/** The font, cached for the instance's life. */
export async function loadReceiptAssets(db: Db): Promise<ReceiptAssets> {
  const t0 = performance.now();
  const fontCached = fontCache !== null;
  if (!fontCache) fontCache = await download(db, RECEIPT_FONT_PATH);
  const t1 = performance.now();
  return { font: fontCache, fontMs: Math.round(t1 - t0), fontCached };
}
