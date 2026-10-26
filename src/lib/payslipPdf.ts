/**
 * Timesheet → Payslips → "Download PDF" (owner option B, 2026-10-26; docs/PAYSLIPS.md).
 *
 * One file: page 1 is the payslip from its STORED figures, drawn on an offscreen canvas
 * (pdf-lib's standard fonts cannot encode ₱ or Japanese) and embedded as a PNG; the
 * following pages are the proof of payment (paid payslips only). Built in the browser
 * only — nothing is uploaded or stored.
 */
import { PDFDocument, StandardFonts, rgb, type PDFPage } from 'pdf-lib';
import { formatDate, payslipFileName, payslipRows, todayTokyo, type Payslip } from '@/lib/payslips';

/** A4 portrait in PDF points. */
export const A4 = { width: 595.28, height: 841.89 } as const;
const MARGIN = 36;
/** Canvas pixels per PDF point for page 1 (≥ 2x for print). */
export const PAGE1_SCALE = 2.5;

export interface ProofFile {
  bytes: Uint8Array;
  contentType: string;
  fileName: string;
}

export type ImageConverter = (bytes: Uint8Array, contentType: string) => Promise<Uint8Array | null>;

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

/** Assemble the PDF from a rendered page 1 and the (optional) proof. Pure apart from pdf-lib. */
export async function buildPayslipPdf(opts: {
  page1Png: Uint8Array;
  proof: ProofFile | null;
  paidOn: string | null;
  convertImage?: ImageConverter;
}): Promise<BuiltPayslipPdf> {
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(opts.page1Png);
  const first = doc.addPage([A4.width, A4.height]);
  const size = fitInside(png.width, png.height, A4.width - MARGIN * 2, A4.height - MARGIN * 2);
  first.drawImage(png, { x: (A4.width - size.width) / 2, y: A4.height - MARGIN - size.height, ...size });

  let proofIncluded: boolean | null = null;
  if (opts.proof) {
    proofIncluded = await appendProof(doc, opts.proof, opts.paidOn, opts.convertImage);
    if (!proofIncluded) await addFallbackPage(doc, opts.proof.fileName);
  }
  const bytes = await doc.save();
  return { bytes, pageCount: doc.getPageCount(), proofIncluded };
}

async function appendProof(doc: PDFDocument, proof: ProofFile, paidOn: string | null, convert?: ImageConverter): Promise<boolean> {
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
    drawCaption(page, `Proof of payment — ${proof.fileName} — paid on ${formatDate(paidOn)}`, font);
    return true;
  } catch {
    return false;
  }
}

// ── Browser-only helpers ────────────────────────────────────────────────────

const FONT = '"Hiragino Sans", "Yu Gothic", "Noto Sans JP", "Meiryo", "Segoe UI", Arial, sans-serif';

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

/** Page 1: the payslip rows (same content and order as the Excel file) drawn on an A4 canvas. */
export async function renderPayslipPage(p: Payslip, generatedOn: string = todayTokyo()): Promise<Uint8Array> {
  const w = Math.round((A4.width - MARGIN * 2) * PAGE1_SCALE);
  const h = Math.round((A4.height - MARGIN * 2) * PAGE1_SCALE);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas_unavailable');
  const s = PAGE1_SCALE;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'top';

  const rows = payslipRows(p, generatedOn);
  const labelW = 210 * s;
  const valueX = labelW + 12 * s;
  const valueW = w - valueX;
  let y = 0;
  rows.forEach((row, i) => {
    if (i === 0) { ctx.font = `600 ${15 * s}px ${FONT}`; ctx.fillText(String(row[0]), 0, y); y += 22 * s; return; }
    if (i === 1) { ctx.font = `700 ${19 * s}px ${FONT}`; ctx.fillText(String(row[0]), 0, y); y += 30 * s; return; }
    if (row.length === 0) { y += 8 * s; return; }
    if (row.length === 1) {
      ctx.font = `700 ${11 * s}px ${FONT}`;
      ctx.fillText(String(row[0]).toUpperCase(), 0, y);
      y += 16 * s;
      return;
    }
    const isTotal = row[0] === 'Total';
    ctx.font = `${isTotal ? 700 : 400} ${(isTotal ? 13 : 10.5) * s}px ${FONT}`;
    const lineH = (isTotal ? 18 : 15) * s;
    if (row[1] === '') {
      // a full-width line (the payment line)
      for (const l of wrap(ctx, String(row[0]), w)) { ctx.fillText(l, 0, y); y += lineH; }
      return;
    }
    const labelLines = wrap(ctx, String(row[0]), labelW);
    const valueLines = wrap(ctx, String(row[1]), valueW);
    labelLines.forEach((l, k) => ctx.fillText(l, 0, y + k * lineH));
    valueLines.forEach((l, k) => ctx.fillText(l, valueX, y + k * lineH));
    y += Math.max(labelLines.length, valueLines.length) * lineH;
    ctx.strokeStyle = '#d9d9d9';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y + 2 * s); ctx.lineTo(w, y + 2 * s); ctx.stroke();
    y += 5 * s;
  });

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

/**
 * Builds and downloads Payslip_<Name>_<YYYY-MM>.pdf. `loadProof` fetches the proof for a paid
 * payslip (10-minute signed URL); it returns null, or throws, when the file cannot be fetched.
 * Returns the fallback note when the proof could not be included.
 */
export async function downloadPayslipPdf(
  p: Payslip,
  loadProof: () => Promise<ProofFile | null>,
): Promise<{ proofNote: string | null }> {
  const page1Png = await renderPayslipPage(p);
  let proof: ProofFile | null = null;
  let note: string | null = null;
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
  const built = await buildPayslipPdf({ page1Png, proof, paidOn: p.paid_on, convertImage: browserImageToJpeg });
  if (built.proofIncluded === false) note = proofFallbackNote(fileName);
  saveBytes(built.bytes, payslipFileName(p.staff_name, p.pay_month, 'pdf'), 'application/pdf');
  return { proofNote: note };
}
