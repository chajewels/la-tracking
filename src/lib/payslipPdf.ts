/**
 * Timesheet → Payslips → "Download PDF" (owner option B, 2026-10-26; corporate layout owner
 * 2026-10-27; docs/PAYSLIPS.md).
 *
 * One file: page 1 is the payslip from its STORED figures, drawn on an offscreen canvas
 * (pdf-lib's standard fonts cannot encode ₱ or Japanese) and embedded as a PNG; the
 * following pages are the proof of payment (paid payslips only). The proof is loaded first,
 * so page 1 can say "Page 1 of N". Built in the browser only — nothing is uploaded or stored.
 * The layout rules live in src/lib/payslipPdfLayout.ts.
 */
import { PDFDocument, StandardFonts, rgb, type PDFPage } from 'pdf-lib';
import badgeUrl from '@/assets/brand/cha-jewels-badge-512.webp';
import { formatDate, formatPeso, payslipFileName, type Payslip } from '@/lib/payslips';
import {
  assertEarningsMatch, earningsRows, footer, headerDetails, letterheadLines, letterheadSmallLines, payslipNumber,
  paymentBlock, paymentNote,
  proofCaption, rightBlockLayout, signatureBlock,
} from '@/lib/payslipPdfLayout';

/** A4 portrait in PDF points. */
export const A4 = { width: 595.28, height: 841.89 } as const;
const MARGIN = 36;
/** Canvas pixels per PDF point for page 1 (3x for print sharpness). */
export const PAGE1_SCALE = 3;

export interface ProofFile {
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
}

export type ImageConverter = (bytes: Uint8Array, contentType: string) => Promise<Uint8Array | null>;

/** Draws page 1 once the final page count (and whether the proof made it in) is known. */
export type Page1Renderer = (pageCount: number, proofIncluded: boolean | null) => Promise<Uint8Array>;

export interface BuiltPayslipPdf {
  bytes: Uint8Array;
  pageCount: number;
  /** null = no proof expected (unpaid); false = the fallback page was used. */
  proofIncluded: boolean | null;
}

type ProofKind = 'pdf' | 'png' | 'jpeg' | 'other-image' | 'unknown';

export function proofKind(contentType: string, fileName: string): ProofKind {
  const t = (contentType || '').toLowerCase();
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (t === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (t === 'image/png' || ext === 'png') return 'png';
  if (t === 'image/jpeg' || t === 'image/jpg' || ext === 'jpg' || ext === 'jpeg') return 'jpeg';
  if (t.startsWith('image/') || ['webp', 'heic', 'heif'].includes(ext)) return 'other-image';
  return 'unknown';
}

/** Standard fonts encode WinAnsi only: anything else in a caption becomes "?". */
export function winAnsiSafe(s: string): string {
  return s.replace(/[^\x20-\x7E\xA0-\xFF—–]/g, '?');
}

/** The size of (w, h) scaled to fit inside (maxW, maxH), keeping its proportions. */
export function fitInside(w: number, h: number, maxW: number, maxH: number): { width: number; height: number } {
  const k = Math.min(maxW / w, maxH / h);
  return { width: w * k, height: h * k };
}

function drawCaption(page: PDFPage, text: string, font: Awaited<ReturnType<PDFDocument['embedFont']>>) {
  page.drawText(winAnsiSafe(text), { x: MARGIN, y: MARGIN / 2, size: 9, font, color: rgb(0.25, 0.25, 0.25), maxWidth: A4.width - MARGIN * 2 });
}

async function addFallbackPage(doc: PDFDocument, fileName: string) {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([A4.width, A4.height]);
  page.drawText(winAnsiSafe(`Proof of payment could not be included — open it from the Hub: ${fileName}`), {
    x: MARGIN, y: A4.height - MARGIN - 14, size: 12, font, color: rgb(0, 0, 0), maxWidth: A4.width - MARGIN * 2, lineHeight: 16,
  });
}

export function proofFallbackNote(fileName: string): string {
  return `Proof of payment could not be included — open it from the Hub: ${fileName}`;
}

/**
 * Assemble the PDF: the proof pages first (so the page count is final), then page 1 is
 * rendered and inserted in front. Pure apart from pdf-lib and the renderer it is given.
 */
export async function buildPayslipPdf(opts: {
  page1Png?: Uint8Array;
  renderPage1?: Page1Renderer;
  proof: ProofFile | null;
  paidOn: string | null;
  payslipNo?: string;
  convertImage?: ImageConverter;
}): Promise<BuiltPayslipPdf> {
  const doc = await PDFDocument.create();
  let proofIncluded: boolean | null = null;
  if (opts.proof) {
    proofIncluded = await appendProof(doc, opts.proof, opts.paidOn, opts.payslipNo ?? '', opts.convertImage);
    if (!proofIncluded) await addFallbackPage(doc, opts.proof.fileName);
  }
  const pageCount = doc.getPageCount() + 1;
  const page1Png = opts.page1Png ?? (opts.renderPage1 ? await opts.renderPage1(pageCount, proofIncluded) : null);
  if (!page1Png) throw new Error('page1_missing');
  const png = await doc.embedPng(page1Png);
  const first = doc.insertPage(0, [A4.width, A4.height]);
  const size = fitInside(png.width, png.height, A4.width - MARGIN * 2, A4.height - MARGIN * 2);
  first.drawImage(png, { x: (A4.width - size.width) / 2, y: A4.height - MARGIN - size.height, ...size });

  const bytes = await doc.save();
  return { bytes, pageCount: doc.getPageCount(), proofIncluded };
}

async function appendProof(
  doc: PDFDocument, proof: ProofFile, paidOn: string | null, payslipNo: string, convert?: ImageConverter,
): Promise<boolean> {
  const kind = proofKind(proof.contentType, proof.fileName);
  try {
    if (kind === 'pdf') {
      const src = await PDFDocument.load(proof.bytes);
      const pages = await doc.copyPages(src, src.getPageIndices());
      if (pages.length === 0) return false;
      pages.forEach(p => doc.addPage(p));
      return true;
    }
    let image;
    if (kind === 'png') image = await doc.embedPng(proof.bytes);
    else if (kind === 'jpeg') image = await doc.embedJpg(proof.bytes);
    else if (kind === 'other-image' && convert) {
      const jpeg = await convert(proof.bytes, proof.contentType);
      if (!jpeg) return false;
      image = await doc.embedJpg(jpeg);
    } else {
      return false;
    }
    const page = doc.addPage([A4.width, A4.height]);
    const size = fitInside(image.width, image.height, A4.width - MARGIN * 2, A4.height - MARGIN * 2 - 14);
    page.drawImage(image, { x: (A4.width - size.width) / 2, y: A4.height - MARGIN - size.height, ...size });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    drawCaption(page, proofCaption(payslipNo, proof.fileName, paidOn), font);
    return true;
  } catch {
    return false;
  }
}

// ── Browser-only helpers ────────────────────────────────────────────────────

const FONT = '"Hiragino Sans", "Yu Gothic", "Noto Sans JP", "Meiryo", "Segoe UI", Arial, sans-serif';
const SERIF = '"Playfair Display", Georgia, "Times New Roman", "Hiragino Mincho ProN", "Noto Serif JP", serif';

const C = {
  text: '#222222',
  muted: '#555555',
  gold: '#C9A227',
  goldDark: '#8A6B12',
  goldPale: '#E8D28A',
  headerFill: '#F4EFE3',
  band: '#222222',
  paid: '#3B6D11',
  hairline: '#E2DDD0',
  box: '#DDD2B4',
} as const;

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const ch of Array.from(text)) {
    const next = line + ch;
    if (ctx.measureText(next).width > maxWidth && line) {
      const cut = line.lastIndexOf(' ');
      if (cut > 0 && ch !== ' ') { out.push(line.slice(0, cut)); line = line.slice(cut + 1) + ch; }
      else { out.push(line); line = ch === ' ' ? '' : ch; }
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/** The website badge, decoded by the browser; null when it cannot be decoded (no logo is drawn). */
async function loadBadge(): Promise<HTMLImageElement | null> {
  try {
    return await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image();
      const timer = setTimeout(() => resolve(null), 5_000);
      el.onload = () => { clearTimeout(timer); resolve(el.naturalWidth > 0 ? el : null); };
      el.onerror = () => { clearTimeout(timer); resolve(null); };
      el.src = badgeUrl;
    });
  } catch {
    return null;
  }
}

/**
 * Page 1: the corporate payslip (letterhead, paid-to / payment boxes, earnings table, net pay,
 * signatures, footer) drawn on the A4 content area. All coordinates are PDF points; the canvas
 * is scaled by PAGE1_SCALE.
 */
export async function renderPayslipPage(
  p: Payslip,
  opts: { pageCount: number; proofIncluded: boolean | null; finalizerName?: string | null },
): Promise<Uint8Array> {
  const rows = earningsRows(p);
  assertEarningsMatch(rows, p.total_php);

  const W = A4.width - MARGIN * 2;
  const H = A4.height - MARGIN * 2;
  const s = PAGE1_SCALE;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * s);
  canvas.height = Math.round(H * s);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas_unavailable');
  ctx.scale(s, s);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'top';

  const font = (weight: number, size: number, family: string = FONT) => { ctx.font = `${weight} ${size}px ${family}`; };
  const text = (str: string, x: number, y: number, color: string = C.text, align: CanvasTextAlign = 'left') => {
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(str, x, y);
    ctx.textAlign = 'left';
  };
  const glyphWidths = (str: string) => Array.from(str).map(ch => ctx.measureText(ch).width);
  /** Letter-spaced text, glyph by glyph (spacing between glyphs only). */
  const spaced = (str: string, x: number, y: number, spacing: number, color: string) => {
    let cx = x;
    for (const ch of Array.from(str)) { text(ch, cx, y, color); cx += ctx.measureText(ch).width + spacing; }
  };
  const rule = (x1: number, x2: number, y: number, width: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
  };

  // a. Letterhead — right block first (its width decides the left text width).
  const TITLE = 'PAYSLIP';
  const TITLE_SPACING = 4;
  font(600, 24, SERIF);
  const titleGlyphs = glyphWidths(TITLE);
  const details = headerDetails(p);
  font(400, 8.5);
  const labelWidths = details.map(d => ctx.measureText(d.label).width);
  font(600, 8.5);
  const valueWidths = details.map(d => ctx.measureText(d.value).width);
  const right = rightBlockLayout({ right: W, titleGlyphWidths: titleGlyphs, letterSpacing: TITLE_SPACING, labelWidths, valueWidths, gap: 10 });

  font(600, 24, SERIF);
  let tx = right.titleX;
  titleGlyphs.forEach((gw, i) => { text(TITLE[i], tx, 0, C.text); tx += gw + TITLE_SPACING; });
  const DETAIL_TOP = 36;
  const DETAIL_LINE = 13;
  details.forEach((d, i) => {
    const y = DETAIL_TOP + i * DETAIL_LINE;
    font(400, 8.5);
    text(d.label, right.labelRight, y, C.muted, 'right');
    font(600, 8.5);
    text(d.value, right.valueX, y, d.label === 'Status' && p.status === 'paid' ? C.paid : C.text);
  });
  const rightHeight = DETAIL_TOP + details.length * DETAIL_LINE;

  const badge = await loadBadge();
  const BADGE = 64;
  if (badge) ctx.drawImage(badge, 0, 0, BADGE, BADGE);
  const lx = badge ? BADGE + 12 : 0;
  // Fixed lines between the badge and the right block; never a mid-item wrap (owner 2026-10-27).
  const leftMax = right.left - 18 - lx;
  const [nameLine, legalLine] = letterheadLines();
  let ly = 2;
  font(700, 16, SERIF);
  text(nameLine.text, lx, ly, C.goldDark); ly += 21;
  font(600, 10);
  text(legalLine.text, lx, ly); ly += 15;
  const small = letterheadSmallLines((str, size) => { font(400, size); return ctx.measureText(str).width; }, leftMax);
  font(400, small.size);
  for (const l of small.lines) { text(l.text, lx, ly, C.muted); ly += small.size + 3.5; }
  const leftHeight = Math.max(badge ? BADGE : 0, ly);

  // b. Gold rule under the band.
  let y = Math.max(leftHeight, rightHeight) + 10;
  rule(0, W, y, 2, C.gold);
  y += 18;

  // c. Paid to / Payment boxes.
  const GAP = 14;
  const boxW = (W - GAP) / 2;
  const PAD = 10;
  const inner = boxW - PAD * 2;
  font(400, 9);
  const addressLines = wrap(ctx, p.address || '—', inner);
  const paidToHeight = 12 + 16 + (p.job_title ? 13 : 0) + addressLines.length * 12 + 13;
  const pay = paymentBlock(p);
  const paymentHeight = 12 + (pay.paid ? pay.rows.length * 13 : 14);
  const boxH = PAD * 2 + Math.max(paidToHeight, paymentHeight);
  const boxes: [number, string][] = [[0, 'PAID TO'], [boxW + GAP, 'PAYMENT']];
  for (const [bx, title] of boxes) {
    ctx.strokeStyle = C.box;
    ctx.lineWidth = 0.75;
    ctx.strokeRect(bx, y, boxW, boxH);
    font(700, 7.5);
    spaced(title, bx + PAD, y + PAD, 1.2, C.goldDark);
  }
  let py = y + PAD + 12;
  font(600, 11.5);
  text(p.staff_name, PAD, py); py += 16;
  if (p.job_title) { font(400, 9); text(p.job_title, PAD, py, C.muted); py += 13; }
  font(400, 9);
  for (const l of addressLines) { text(l, PAD, py); py += 12; }
  text(`Date of birth: ${formatDate(p.date_of_birth)}`, PAD, py);

  const px = boxW + GAP + PAD;
  let qy = y + PAD + 12;
  if (pay.paid) {
    for (const r of pay.rows) {
      font(400, 8.5);
      text(r.label, px, qy, C.muted);
      font(600, 8.5);
      text(r.value, px + inner, qy, C.text, 'right');
      qy += 13;
    }
  } else {
    font(400, 9.5);
    text(pay.note, px, qy, C.muted);
  }
  y += boxH + 20;

  // d. Earnings table.
  const COL_DETAILS = 150;
  const AMOUNT_RIGHT = W - 8;
  ctx.fillStyle = C.headerFill;
  ctx.fillRect(0, y, W, 20);
  font(700, 8.5);
  text('Earnings', 8, y + 6, C.goldDark);
  text('Details', COL_DETAILS, y + 6, C.goldDark);
  text('Amount ₱', AMOUNT_RIGHT, y + 6, C.goldDark, 'right');
  y += 20;
  const detailsMax = AMOUNT_RIGHT - 90 - COL_DETAILS;
  for (const r of rows) {
    font(400, 9);
    const dl = r.details ? wrap(ctx, r.details, detailsMax) : [''];
    const rowH = 8 + Math.max(1, dl.length) * 12;
    font(600, 9.5);
    text(r.label, 8, y + 5);
    font(400, 9);
    dl.forEach((l, k) => text(l, COL_DETAILS, y + 5 + k * 12, C.muted));
    font(500, 9.5);
    text(r.amountText, AMOUNT_RIGHT, y + 5, C.text, 'right');
    y += rowH;
    rule(0, W, y, 0.5, C.hairline);
  }

  // e. Net pay band, flush with the amounts' right edge.
  y += 10;
  const bandX = W * 0.45;
  ctx.fillStyle = C.band;
  ctx.fillRect(bandX, y, W - bandX, 30);
  font(600, 10, SERIF);
  spaced('NET PAY', bandX + 12, y + 10, 2, C.goldPale);
  font(700, 15, SERIF);
  text(formatPeso(p.total_php), AMOUNT_RIGHT, y + 7, C.goldPale, 'right');
  y += 30;

  // f. Payment line (paid only).
  const note = paymentNote(p, opts.proofIncluded);
  if (note) {
    y += 12;
    font(400, 8.5);
    for (const l of wrap(ctx, note, W)) { text(l, 0, y, C.muted); y += 11.5; }
  }

  // g. Signatures.
  const FOOTER_TOP = H - 18;
  const SIG_GAP = 24;
  const colW = (W - SIG_GAP * 2) / 3;
  const sigTop = Math.max(y + 44, FOOTER_TOP - 70);
  signatureBlock(p, opts.finalizerName).forEach((col, i) => {
    const x = i * (colW + SIG_GAP);
    rule(x, x + colW, sigTop, 0.75, C.text);
    font(400, 8);
    text(col.label, x, sigTop + 6, C.muted);
    font(500, 9);
    wrap(ctx, col.name, colW).forEach((l, k) => { if (l) text(l, x, sigTop + 19 + k * 11.5, C.text); });
  });

  // h. Footer.
  rule(0, W, FOOTER_TOP, 1, C.gold);
  const f = footer(opts.pageCount);
  font(400, 7.5);
  text(f.left, 0, FOOTER_TOP + 6, C.muted);
  text(f.right, W, FOOTER_TOP + 6, C.muted, 'right');

  const blob: Blob | null = await new Promise(res => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('canvas_unavailable');
  return new Uint8Array(await blob.arrayBuffer());
}

/** WebP / HEIC → JPEG through the browser's own decoder; null when it cannot decode it. */
export const browserImageToJpeg: ImageConverter = async (bytes, contentType) => {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: contentType || 'application/octet-stream' }));
  try {
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image();
      const timer = setTimeout(() => resolve(null), 10_000);
      el.onload = () => { clearTimeout(timer); resolve(el); };
      el.onerror = () => { clearTimeout(timer); resolve(null); };
      el.src = url;
    });
    if (!img || !img.naturalWidth || !img.naturalHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    const blob: Blob | null = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.9));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } finally {
    URL.revokeObjectURL(url);
  }
};

export function saveBytes(bytes: Uint8Array, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Builds the PDF bytes for a payslip (the proof is loaded first, then page 1 is drawn). */
export async function makePayslipPdf(
  p: Payslip,
  loadProof: () => Promise<ProofFile | null>,
  finalizerName?: string | null,
): Promise<BuiltPayslipPdf & { fileName: string }> {
  let proof: ProofFile | null = null;
  const fileName = p.proof_path ? p.proof_path.slice(p.proof_path.indexOf('/') + 1) : '';
  if (p.status === 'paid' && p.proof_path) {
    try {
      proof = await loadProof();
    } catch {
      proof = null;
    }
    // a proof that cannot be fetched still gets the fallback page
    if (!proof) proof = { bytes: new Uint8Array(), contentType: '', fileName };
  }
  const built = await buildPayslipPdf({
    renderPage1: (pageCount, proofIncluded) => renderPayslipPage(p, { pageCount, proofIncluded, finalizerName }),
    proof,
    paidOn: p.paid_on,
    payslipNo: payslipNumber(p),
    convertImage: browserImageToJpeg,
  });
  return { ...built, fileName };
}

/**
 * Builds and downloads Payslip_<Name>_<YYYY-MM>.pdf. `loadProof` fetches the proof for a paid
 * payslip (10-minute signed URL); it returns null, or throws, when the file cannot be fetched.
 * `finalizerName` is the "Prepared by" name (blank when unknown). Returns the fallback note when
 * the proof could not be included.
 */
export async function downloadPayslipPdf(
  p: Payslip,
  loadProof: () => Promise<ProofFile | null>,
  finalizerName?: string | null,
): Promise<{ proofNote: string | null }> {
  const built = await makePayslipPdf(p, loadProof, finalizerName);
  const note = built.proofIncluded === false ? proofFallbackNote(built.fileName) : null;
  saveBytes(built.bytes, payslipFileName(p.staff_name, p.pay_month, 'pdf'), 'application/pdf');
  return { proofNote: note };
}
