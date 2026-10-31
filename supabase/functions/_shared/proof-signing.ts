// H-01 (security audit 2026-10-31): payment proofs are viewed through
// short-lived SIGNED links, never through the stored public URL.
//
// Why: the payment-proofs bucket is public today (live check 2026-10-31:
// public = true, 4,663 files), so anyone holding a proof link can open the bank
// slip without signing in. Making the bucket private is the fix, but it must
// come AFTER every viewer signs its links — flipping first broke production
// once (docs/FIXED-BUGS.md Bug #166). This module is the server-side half of
// "sign first": customer-portal returns `proof_view_url` (signed, 1 hour) next
// to each submission's stored proof_url.
//
// The stored proof_url is unchanged: writers keep storing the
// /object/public/payment-proofs/<path> shape that the database guard
// (trg_guard_payment_submission_proof_url) and isAllowedProofUrl require; it is
// now an identifier, and the object path is read from it here.
//
// proofObjectPath is PURE (no Deno APIs) and unit-tested.

import { PROOF_BUCKET } from "./proof-url-rules.ts";

export const PROOF_VIEW_TTL_SECONDS = 60 * 60; // 1 hour

const PATH_RE = /\/storage\/v1\/object\/(?:public|sign)\/payment-proofs\/([^?#]+)/;

/**
 * The storage object path inside payment-proofs for a stored proof link, or
 * null when the value is not a link into that bucket. Percent-encoding is
 * decoded per segment (storage object names are stored decoded); a segment
 * that is empty, "." or ".." is refused.
 */
export function proofObjectPath(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const m = PATH_RE.exec(url.trim());
  if (!m) return null;
  const segs = m[1].split("/");
  const out: string[] = [];
  for (const seg of segs) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (decoded === "" || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) return null;
    out.push(decoded);
  }
  return out.join("/");
}

// deno-lint-ignore no-explicit-any
type StorageClient = { storage: { from: (bucket: string) => any } };

/**
 * Signed view links for a batch of stored proof links, keyed by the stored
 * value. A link that cannot be signed (not in the bucket, object missing,
 * storage error) is simply absent from the map — callers fall back to showing
 * no link, never to a broken or foreign one.
 */
export async function signProofUrls(
  supabase: StorageClient,
  storedUrls: Array<string | null | undefined>,
  ttlSeconds: number = PROOF_VIEW_TTL_SECONDS,
): Promise<Map<string, string>> {
  const byPath = new Map<string, string[]>();
  for (const stored of storedUrls) {
    if (typeof stored !== "string") continue;
    const path = proofObjectPath(stored);
    if (!path) continue;
    const list = byPath.get(path) ?? [];
    if (!list.includes(stored)) list.push(stored);
    byPath.set(path, list);
  }
  const out = new Map<string, string>();
  if (byPath.size === 0) return out;
  try {
    const { data, error } = await supabase.storage.from(PROOF_BUCKET).createSignedUrls([...byPath.keys()], ttlSeconds);
    if (error || !Array.isArray(data)) {
      console.warn("[proof-signing] createSignedUrls failed:", error?.message ?? "no data");
      return out;
    }
    for (const row of data as Array<{ path?: string | null; signedUrl?: string | null; error?: string | null }>) {
      if (!row?.path || !row.signedUrl || row.error) continue;
      for (const stored of byPath.get(row.path) ?? []) out.set(stored, row.signedUrl);
    }
  } catch (e) {
    console.warn("[proof-signing] createSignedUrls threw:", (e as Error)?.message ?? String(e));
  }
  return out;
}
