// QC P1-1 (2026-10-06): a stored proof_url may be customer-supplied (older
// rows were never validated), so the Hub never puts one in an href or
// window.open unchecked. safeHttpUrl returns the URL only for http(s) links;
// anything else (javascript:, data:, blank, unparseable) gives null and the
// caller renders no link.
import { isAllowedProofUrl } from '../../supabase/functions/_shared/proof-url-rules.ts';

export function safeHttpUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return raw;
  } catch {
    return null;
  }
}

/** Open a proof link in a new tab only when safeHttpUrl accepts it. */
export function openSafeUrl(url: string | null | undefined): void {
  const safe = safeHttpUrl(url);
  if (safe) window.open(safe, '_blank', 'noopener,noreferrer');
}

/** The Hub's own Supabase host (from the build env), lower-case, or null. */
export function ownSupabaseHost(base: string | undefined = import.meta.env.VITE_SUPABASE_URL): string | null {
  if (!base) return null;
  try {
    return new URL(base).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Same rule the edge writers apply: a file in our own payment-proofs bucket. */
export function isOwnProofUrl(url: string | null | undefined, host: string | null = ownSupabaseHost()): boolean {
  if (!host) return false;
  return isAllowedProofUrl(url, { host });
}
