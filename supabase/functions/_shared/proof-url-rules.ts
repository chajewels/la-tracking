// PROOF-OF-PAYMENT SAFETY (QC P1-1 / P2-4, 2026-10-06).
//
// A proof_url is customer-supplied on the portal and storefront paths and it
// is rendered as a link in the staff Hub. Every writer therefore accepts a
// proof_url ONLY when it points into this project's own `payment-proofs`
// bucket:
//
//   https://<this project's Supabase host>/storage/v1/object/(public|sign)/payment-proofs/<path>
//
// Every legitimate producer writes exactly that shape: upload-proof (portal
// and storefront), the Hub's staff dialogs and bulk import (getPublicUrl).
// Live inventory 2026-10-06: 4,672 of 4,672 stored proofs have it.
//
// PURE (no Deno APIs) so the Hub frontend can import it too; the env-bound
// wrapper isOwnProofUrl lives in proof-url.ts. Tests pass the host in.
// Old rows are not rewritten — only new writes are checked; the Hub renders
// stored links through safeHttpUrl() (src/lib/safe-url.ts).
//
// upload-proof also checks the FILE: an allow-listed claimed type whose magic
// bytes agree (sniffProofKind), stored under the sniffed canonical type.

export const PROOF_BUCKET = "payment-proofs";
const PATH_RE = /^\/storage\/v1\/object\/(public|sign)\/payment-proofs\/(.+)$/;

export interface ProofUrlCtx {
  /** The project's Supabase host, e.g. "abcd.supabase.co" (no scheme). */
  host: string;
}

/** True only for an https link into this project's payment-proofs bucket. */
export function isAllowedProofUrl(url: unknown, ctx: ProofUrlCtx): boolean {
  if (typeof url !== "string") return false;
  const raw = url.trim();
  if (!raw || raw.length > 2048) return false;
  // No control characters or backslashes anywhere in the raw string.
  // deno-lint-ignore no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return false;
  if (!/^https:\/\//i.test(raw)) return false;
  const expectedHost = (ctx?.host ?? "").trim().toLowerCase();
  if (!expectedHost) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password || u.port) return false;
  if (u.host.toLowerCase() !== expectedHost) return false;
  const m = PATH_RE.exec(u.pathname);
  if (!m) return false;
  const segs = m[2].split("/");
  for (const seg of segs) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return false;
    }
    if (seg === "" || decoded === "" || decoded === "." || decoded === ".." ||
      decoded.includes("/") || decoded.includes("\\")) return false;
  }
  return true;
}

/** The refusal every writer returns for a proof_url that fails the check. */
export const INVALID_PROOF_URL = {
  error: "invalid_proof_url",
  message: "Proof of payment must be a file uploaded through Cha Jewels.",
} as const;

// ── upload-proof: file type ──────────────────────────────────────────────

export type ProofKind = "jpeg" | "png" | "webp" | "heic" | "pdf";

export const CANONICAL_PROOF_TYPE: Record<ProofKind, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  pdf: "application/pdf",
};

const CLAIMED_TYPE_KIND: Record<string, ProofKind> = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/pjpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heic",
  "image/heic-sequence": "heic",
  "image/heif-sequence": "heic",
  "application/pdf": "pdf",
};

const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"]);

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < to && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** What the file's leading bytes say it is, or null when not an allowed kind. */
export function sniffProofKind(bytes: Uint8Array): ProofKind | null {
  if (!bytes || bytes.length < 4) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (ascii(bytes, 0, 4) === "%PDF") return "pdf";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp";
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp" && HEIF_BRANDS.has(ascii(bytes, 8, 12))) return "heic";
  return null;
}

/**
 * The type to store the object under, or null to refuse (400
 * unsupported_file). The bytes decide; a claimed type must be on the allow-list
 * and agree with them. A blank / octet-stream claim (some phones send that for
 * HEIC) is judged by the bytes alone.
 */
export function acceptedProofType(claimedType: string | null | undefined, bytes: Uint8Array): string | null {
  const kind = sniffProofKind(bytes);
  if (!kind) return null;
  const claimed = (claimedType ?? "").split(";")[0].trim().toLowerCase();
  if (claimed && claimed !== "application/octet-stream") {
    const claimedKind = CLAIMED_TYPE_KIND[claimed];
    if (!claimedKind || claimedKind !== kind) return null;
  }
  return CANONICAL_PROOF_TYPE[kind];
}
