// Shared loyalty-images storage path helper for Phase 3.5 / 3.5.1.
//
// Extracts the object key from a public Supabase Storage URL that
// points at the loyalty-images bucket. Returns null when the URL
// is missing, empty, or points elsewhere — used to scope deletes
// to URLs we own and avoid touching legacy paste-only externals.
//
// Twin file in src/lib/loyalty-images-path.ts must be kept in
// sync — same regex, different runtimes (Deno vs Vite).
//
// Consumers:
//   - cleanup-loyalty-images edge function (Phase 3.5.1)
//   - ImageUploadField.tsx via the src/lib twin (Phase 3.5)

export const LOYALTY_IMAGES_BUCKET = 'loyalty-images';

const PATH_REGEX = /\/storage\/v1\/object\/public\/loyalty-images\/(.+)$/;

/**
 * Returns the object key inside the loyalty-images bucket, or null
 * if the URL is empty, malformed, or points outside the bucket.
 */
export function loyaltyImagesPath(
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  const match = url.match(PATH_REGEX);
  return match ? match[1] : null;
}
