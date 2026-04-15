import { supabase } from '@/integrations/supabase/client';

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

/** Default PHP↔JPY rate if nothing else is available (matches currency-converter.ts). */
export const DEFAULT_PHP_JPY_RATE = 0.42;

/**
 * Fetch the live php_jpy_rate from system_settings. Falls back to the
 * default when the row is missing or the query fails. Value is stored
 * as a jsonb scalar (a bare number encoded as JSON), so it may come
 * back as a number or a JSON-encoded string — both are handled.
 *
 * Per CLAUDE.md:
 *   JPY = PHP ÷ rate
 *   PHP = JPY × rate
 */
export async function fetchPhpJpyRate(): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'php_jpy_rate')
      .maybeSingle();
    if (error || !data) return DEFAULT_PHP_JPY_RATE;
    const raw = (data as any).value;
    const num = typeof raw === 'number' ? raw : Number(JSON.parse(String(raw)));
    return Number.isFinite(num) && num > 0 ? num : DEFAULT_PHP_JPY_RATE;
  } catch {
    return DEFAULT_PHP_JPY_RATE;
  }
}

/** Format a price value with the appropriate currency symbol. */
export function formatPromoPrice(price: number, currency: 'PHP' | 'JPY'): string {
  if (currency === 'JPY') {
    return `¥${Math.round(price).toLocaleString()}`;
  }
  // PHP: show decimals only when non-zero
  const hasDecimals = Math.round(price * 100) % 100 !== 0;
  return `₱${price.toLocaleString(undefined, {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}
