// Resolve a stored proof-of-payment reference to a viewable URL.
// The payment-proofs bucket is private — public URLs no longer work, so we
// extract the object path and mint a short-lived signed URL on demand.
//
// Accepted inputs:
//   - bare object path (e.g. "user-id/file.jpg")
//   - legacy public URL (".../object/public/payment-proofs/<path>")
//   - legacy signed URL  (".../object/sign/payment-proofs/<path>?token=...")
import { supabase } from '@/integrations/supabase/client';

const BUCKET = 'payment-proofs';
const SIGNED_TTL_SECONDS = 60 * 60; // 1 hour

export function extractProofPath(input: string): string {
  if (!input) return '';
  const m = input.match(/payment-proofs\/(.+?)(?:\?|$)/);
  if (m) return m[1];
  // Already a bare path
  return input;
}

export async function getProofSignedUrl(input: string): Promise<string | null> {
  const path = extractProofPath(input);
  if (!path) return null;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    console.error('createSignedUrl failed for', path, error);
    return null;
  }
  return data.signedUrl;
}
