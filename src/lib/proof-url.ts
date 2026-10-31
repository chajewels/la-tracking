// Resolve a stored proof-of-payment reference to a viewable URL.
// Every viewer reads proofs through a short-lived signed URL minted on demand
// from the object path. (2026-10-31: the bucket is still PUBLIC in production —
// security audit H-01; it is made private only after every viewer signs.)
//
// Accepted inputs:
//   - bare object path (e.g. "user-id/file.jpg")
//   - legacy public URL (".../object/public/payment-proofs/<path>")
//   - legacy signed URL  (".../object/sign/payment-proofs/<path>?token=...")
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

const BUCKET = 'payment-proofs';
const SIGNED_TTL_SECONDS = 60 * 60; // 1 hour

export function extractProofPath(input: string): string {
  if (!input) return '';
  const m = input.match(/payment-proofs\/(.+?)(?:\?|$)/);
  if (m) return m[1];
  // Already a bare path
  return input;
}

export async function getProofSignedUrl(input: string, opts: { download?: boolean } = {}): Promise<string | null> {
  const path = extractProofPath(input);
  if (!path) return null;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_TTL_SECONDS, opts.download ? { download: true } : undefined);
  if (error || !data?.signedUrl) {
    console.error('createSignedUrl failed for', path, error?.message ?? error);
    return null;
  }
  return data.signedUrl;
}

/**
 * H-01 (security audit 2026-10-31): open a proof through a fresh signed link,
 * never through the stored public URL — so every staff screen keeps working
 * once the payment-proofs bucket is made private (the order the fix must
 * follow; Bug #166).
 *  - View: a tab is opened synchronously on the click (so no popup blocker
 *    stops it) and pointed at the signed link once it arrives.
 *  - Download: no tab — the signed link is served as an attachment by Storage
 *    and fetched through a temporary link, so no empty tab is left behind.
 * If no link can be made the tab closes, staff see an error, and the caller is
 * told (false).
 */
export async function openProof(input: string | null | undefined, opts: { download?: boolean } = {}): Promise<boolean> {
  if (!input || !input.trim()) {
    toast.error('No proof file is attached.');
    return false;
  }
  if (opts.download) {
    const url = await getProofSignedUrl(input, { download: true });
    if (!url) {
      toast.error('Could not download this proof. Please try again.');
      return false;
    }
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  }
  const tab = typeof window !== 'undefined' ? window.open('', '_blank') : null;
  if (tab) tab.opener = null;
  const url = await getProofSignedUrl(input);
  if (!url) {
    tab?.close();
    toast.error('Could not open this proof. Please try again.');
    return false;
  }
  if (tab) tab.location.href = url;
  else window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}
