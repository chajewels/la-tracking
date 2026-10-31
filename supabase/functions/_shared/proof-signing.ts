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
export type StorageClient = { storage: { from: (bucket: string) => any } };

/**
 * Signed view links for a batch of stored proof links, keyed by the stored
 * value. A link that cannot be signed (not in the bucket, object missing,
 * storage error) is simply absent from the map — callers fall back to showing
 * no link, never to a broken or foreign one.
 *
 * `allowedFirstSegments` (customer-facing callers): only an object whose first
 * path segment is one of these ids is signed. Proofs are stored under the
 * account / cash order they were uploaded for (upload-proof:
 * `${accountId}/${name}`; live 2026-10-31: every id-prefixed proof belongs to
 * the submission's own customer), so a customer who stores another account's
 * path in her own submission never gets a signed link to it once the bucket
 * is private.
 */
export async function signProofUrls(
  supabase: StorageClient,
  storedUrls: Array<string | null | undefined>,
  ttlSeconds: number = PROOF_VIEW_TTL_SECONDS,
  allowedFirstSegments?: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const byPath = new Map<string, string[]>();
  for (const stored of storedUrls) {
    if (typeof stored !== "string") continue;
    const path = proofObjectPath(stored);
    if (!path) continue;
    if (allowedFirstSegments && !allowedFirstSegments.has(path.split("/")[0])) continue;
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

// ── Cash Receipt images (H-01 step 3, owner decision D-02 = (a), 2026-11-01) ──
//
// The invoice sheets' Cash Receipt tab shows each proof with
// =IMAGE("<link>", 1). Google fetches that link WITHOUT signing in, so once the
// bucket is private a stored /object/public/… link shows a broken image. The
// receipt writers therefore embed a SIGNED link instead, valid for 10 years so
// receipts kept as records keep their images. Limits (docs/SECURITY-HARDENING.md
// H-01): such a link cannot be withdrawn file by file — only by rotating the
// project's storage keys, after which "Rebuild cash receipts" must be run again
// — so the invoice sheets must stay shared with the team only.

/** 10 years, in seconds (365-day years; a few days short of 10 calendar years). */
export const RECEIPT_IMAGE_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

/**
 * Replace each slot's stored proof link with a 10-year signed link. A slot
 * whose payment-proofs link cannot be signed KEEPS its stored link (it still
 * opens while the bucket is public) and is counted in `unsigned`; callers
 * report the count, and the bucket must not be switched to private while any
 * receipt is unsigned. A link that is not in payment-proofs at all is kept and
 * NOT counted: the switch does not affect it (there are none today — every
 * writer validates proof_url into this bucket).
 * Never throws: signProofUrls already swallows storage errors.
 */
export async function signReceiptProofs<T extends { proof_url: string }>(
  supabase: StorageClient,
  slots: T[],
): Promise<{ slots: T[]; unsigned: number }> {
  if (slots.length === 0) return { slots, unsigned: 0 };
  const signed = await signProofUrls(supabase, slots.map((s) => s.proof_url), RECEIPT_IMAGE_TTL_SECONDS);
  let unsigned = 0;
  const out = slots.map((s) => {
    const url = signed.get(s.proof_url);
    if (url) return { ...s, proof_url: url };
    // Counted when the link points into payment-proofs, even if its path is
    // one the signer refuses ("..", an encoded "/"): such a link would still
    // break once the bucket is private, so "0 unsigned" must not hide it.
    if (proofObjectPath(s.proof_url) !== null || /\/payment-proofs\//.test(s.proof_url)) unsigned++;
    return s;
  });
  if (unsigned > 0) {
    console.error(`[proof-signing] ${unsigned} of ${slots.length} receipt image(s) could not be signed; their stored link was kept`);
  }
  return { slots: out, unsigned };
}
