import { supabase } from "@/integrations/supabase/client";
import { MEDIA_BUCKET, MEDIA_PREFIX } from "@/components/website/HeroImageField";

/**
 * Product video (D2-1, owner 2026-09-29: "ready it for next time"). One MP4
 * per product — the owner's 360° turntable clip, shown as-is in the website
 * gallery (never converted to 3D). Staff upload only the MP4; the still the
 * website shows before it plays (the poster) is taken from the clip here, in
 * the browser, so there is nothing else to prepare.
 *
 * Stored like product photos: the public media bucket, URL on the product row
 * (website_products.video_url / video_poster_url). Removing clears the URLs
 * only; the file stays, as photos do.
 */

/** MP4 only: every browser plays H.264 MP4, the website's <video> expects it. */
export const VIDEO_MIME = "video/mp4";
/** Well under the platform upload ceiling; a few-second turntable clip is far smaller. */
export const VIDEO_MAX_BYTES = 45 * 1024 * 1024;
/** The frame used for the poster (seconds), clamped into short clips. */
const POSTER_AT_S = 0.5;

export type VideoCheck = { ok: true } | { ok: false; reason: string };

export function checkVideoFile(file: Pick<File, "type" | "size" | "name">): VideoCheck {
  const isMp4 = file.type === VIDEO_MIME || (!file.type && /\.mp4$/i.test(file.name));
  if (!isMp4) return { ok: false, reason: "Only MP4 videos can be uploaded." };
  if (file.size <= 0) return { ok: false, reason: "This file is empty." };
  if (file.size > VIDEO_MAX_BYTES) {
    const mb = Math.round(file.size / 1024 / 1024);
    return { ok: false, reason: `This video is ${mb} MB; the limit is ${Math.round(VIDEO_MAX_BYTES / 1024 / 1024)} MB. Export a shorter or smaller clip.` };
  }
  return { ok: true };
}

/** One frame of the clip as a JPEG, or null when the browser cannot decode it. */
export function capturePoster(file: Blob, timeoutMs = 15000): Promise<Blob | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let done = false;
    const finish = (b: Blob | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      resolve(b);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.onerror = () => finish(null);
    video.onloadedmetadata = () => {
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      video.currentTime = d > 0 ? Math.min(POSTER_AT_S, d / 2) : 0;
    };
    video.onseeked = () => {
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return finish(null);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return finish(null);
      ctx.drawImage(video, 0, 0, w, h);
      canvas.toBlob((b) => finish(b), "image/jpeg", 0.85);
    };
    video.src = url;
  });
}

/**
 * Uploads the MP4 and its poster. The poster is best effort: a clip the
 * browser cannot decode still uploads, and the website then shows the video
 * without a still (it plays on request under reduced motion).
 */
export async function uploadProductVideo(file: File): Promise<{ video_url: string; video_poster_url: string | null }> {
  const check = checkVideoFile(file);
  if (!check.ok) throw new Error(check.reason);
  const id = crypto.randomUUID();
  const base = `${MEDIA_PREFIX}/video/${id}`;
  const bucket = supabase.storage.from(MEDIA_BUCKET);

  const { error } = await bucket.upload(`${base}.mp4`, file, { upsert: false, contentType: VIDEO_MIME });
  if (error) throw error;
  const video_url = bucket.getPublicUrl(`${base}.mp4`).data.publicUrl;

  let video_poster_url: string | null = null;
  const poster = await capturePoster(file);
  if (poster) {
    const { error: pErr } = await bucket.upload(`${base}-poster.jpg`, poster, { upsert: false, contentType: "image/jpeg" });
    if (!pErr) video_poster_url = bucket.getPublicUrl(`${base}-poster.jpg`).data.publicUrl;
  }
  return { video_url, video_poster_url };
}
