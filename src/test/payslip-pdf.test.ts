import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildPayslipPdf, fitInside, proofFallbackNote, proofKind, winAnsiSafe } from "@/lib/payslipPdf";
import { payslipFileName } from "@/lib/payslips";

/**
 * Payslip PDF (owner option B, 2026-10-26): page 1 = the payslip (a PNG drawn on a canvas in
 * the browser; a tiny PNG stands in here), then the proof pages for a paid payslip, with a
 * fallback page when the proof cannot be included.
 */

const TINY_PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

async function pdfWithPages(n: number): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (let i = 0; i < n; i++) d.addPage([300, 400]);
  return d.save();
}

async function pages(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

describe("payslip PDF", () => {
  it("a finalized (unpaid) payslip is page 1 only", async () => {
    const r = await buildPayslipPdf({ page1Png: TINY_PNG, proof: null, paidOn: null });
    expect(r.pageCount).toBe(1);
    expect(r.proofIncluded).toBeNull();
    expect(await pages(r.bytes)).toBe(1);
  });

  it("a PDF proof appends every one of its pages (1 + n)", async () => {
    const proof = { bytes: await pdfWithPages(3), contentType: "application/pdf", fileName: "1730000000-bdo.pdf" };
    const r = await buildPayslipPdf({ page1Png: TINY_PNG, proof, paidOn: "2026-10-05" });
    expect(r.proofIncluded).toBe(true);
    expect(r.pageCount).toBe(4);
    expect(await pages(r.bytes)).toBe(4);
  });

  it("an image proof is one more page (2)", async () => {
    const proof = { bytes: TINY_PNG, contentType: "image/png", fileName: "1730000000-gcash.png" };
    const r = await buildPayslipPdf({ page1Png: TINY_PNG, proof, paidOn: "2026-10-05" });
    expect(r.proofIncluded).toBe(true);
    expect(await pages(r.bytes)).toBe(2);
  });

  it("a WebP/HEIC proof goes through the converter; one it cannot decode gets the fallback page", async () => {
    const proof = { bytes: new Uint8Array([1, 2, 3]), contentType: "image/heic", fileName: "IMG_0001.HEIC" };
    const r = await buildPayslipPdf({ page1Png: TINY_PNG, proof, paidOn: "2026-10-05", convertImage: async () => null });
    expect(r.proofIncluded).toBe(false);
    expect(await pages(r.bytes)).toBe(2);
  });

  it("a broken or encrypted PDF proof still delivers the PDF with the fallback page", async () => {
    const proof = { bytes: new TextEncoder().encode("%PDF-1.7 not really"), contentType: "application/pdf", fileName: "x.pdf" };
    const r = await buildPayslipPdf({ page1Png: TINY_PNG, proof, paidOn: "2026-10-05" });
    expect(r.proofIncluded).toBe(false);
    expect(await pages(r.bytes)).toBe(2);
    expect(proofFallbackNote("x.pdf")).toBe("Proof of payment could not be included — open it from the Hub: x.pdf");
  });

  it("a non-Latin file name does not break the caption", async () => {
    const proof = { bytes: TINY_PNG, contentType: "image/png", fileName: "振込明細.png" };
    const r = await buildPayslipPdf({ page1Png: TINY_PNG, proof, paidOn: "2026-10-05" });
    expect(r.proofIncluded).toBe(true);
    expect(winAnsiSafe("振込 — ok")).toBe("?? — ok");
  });

  it("helpers: kind, fit, file name", () => {
    expect(proofKind("", "a.PDF")).toBe("pdf");
    expect(proofKind("image/webp", "a.webp")).toBe("other-image");
    expect(proofKind("image/jpeg", "a")).toBe("jpeg");
    expect(proofKind("", "a.txt")).toBe("unknown");
    expect(fitInside(1000, 500, 500, 500)).toEqual({ width: 500, height: 250 });
    expect(payslipFileName("Gay Marie", "2026-09-01", "pdf")).toBe("Payslip_Gay_Marie_2026-09.pdf");
  });
});
