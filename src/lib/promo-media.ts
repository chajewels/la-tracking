/**
 * Parse a promotion's media_url for image-type promos.
 *
 * The column stores a JSON array of image URLs once multi-image support
 * landed. Older rows may contain a single plain-URL string — those are
 * returned as a one-element array for backward compatibility.
 */
export function parseImageUrls(mediaUrl: string | null | undefined): string[] {
  if (!mediaUrl) return [];
  try {
    const parsed = JSON.parse(mediaUrl);
    if (Array.isArray(parsed)) {
      return parsed.filter((u): u is string => typeof u === 'string' && u.length > 0);
    }
    if (typeof parsed === 'string' && parsed.length > 0) return [parsed];
    return [];
  } catch {
    // Not JSON → legacy single URL
    return typeof mediaUrl === 'string' && mediaUrl.length > 0 ? [mediaUrl] : [];
  }
}
