import { supabase } from "@/integrations/supabase/client";

/**
 * review_invites / product_reviews / message_lines are not in the generated
 * types until the PR-R1 migration is applied and types.ts regenerates.
 * types.ts is never hand-edited (CLAUDE.md), so cast at the call site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const reviewDb = supabase as unknown as { from: (table: string) => any };

export const REVIEW_LINK_BASE = "https://www.chajewelsjp.com/review/";

export type ReviewStatus = "pending" | "approved" | "rejected" | "hidden";

export interface ProductReviewRow {
  id: string;
  invite_id: string;
  customer_id: string;
  cash_order_id: string | null;
  layaway_account_id: string | null;
  website_product_id: string | null;
  piece_name: string;
  rating: number;
  body_original: string;
  original_language: "en" | "ja" | "tl" | "mixed" | null;
  body_en: string | null;
  body_ja: string | null;
  display_name: string;
  upload_paths: string[];
  photo_urls: string[];
  status: ReviewStatus;
  reject_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

/** 32 random bytes, base64url, no padding. */
export function newReviewToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function fillReviewMessage(template: string, v: { first_name: string; piece: string; link: string }): string {
  return template
    .replace("{first_name}", v.first_name)
    .replace("{piece}", v.piece)
    .replace("{link}", v.link);
}
