import { supabase } from "@/integrations/supabase/client";
import type { StylingProduct } from "@/components/website/ai-styling";

/**
 * Browser side of "Write description (AI)": the first product photo is
 * shrunk to a JPEG of at most 1 MB (the function's limit) and the request goes
 * to the read-only gemini-product-enhance edge function with the staff session.
 * Owner 2026-10-31: the first photo is included.
 */

export const IMAGE_MAX_BYTES = 1_048_576;
const MAX_SIDE = 1024;

const blobToBase64 = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error ?? new Error("Could not read the photo."));
    r.readAsDataURL(b);
  });

/** First photo as base64 JPEG <= 1 MB, or null when it cannot be read (the text is still sent). */
export async function photoForStyling(url: string | null | undefined): Promise<{ mime_type: string; data_base64: string } | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob());
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const q of [0.85, 0.7, 0.5]) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", q));
      if (blob && blob.size <= IMAGE_MAX_BYTES) return { mime_type: "image/jpeg", data_base64: await blobToBase64(blob) };
    }
    return null;
  } catch {
    return null;
  }
}

export interface StylingReply { text: string; usedPhoto: boolean }

/** One request, no retry. Throws a plain message on any failure. */
export async function requestStyling(product: StylingProduct, photoUrl: string | null | undefined): Promise<StylingReply> {
  const image = await photoForStyling(photoUrl);
  const { data, error } = await supabase.functions.invoke("gemini-product-enhance", {
    body: { product, ...(image ? { images: [image] } : {}) },
  });
  if (error) {
    const res = (error as { context?: Response }).context;
    const detail = res ? await res.json().catch(() => null) : null;
    throw new Error(detail?.message ?? detail?.error ?? error.message);
  }
  const body = (data ?? {}) as { ok?: boolean; addition?: unknown; message?: unknown; image_processed?: unknown };
  if (!body.ok) throw new Error(typeof body.message === "string" ? body.message : "The AI did not return a suggestion.");
  return { text: String(body.addition ?? ""), usedPhoto: body.image_processed === true };
}
