/**
 * The one builder for a carrier's "Track parcel" link (ShipmentTrackingCard in
 * the Hub, PortalTrackingRow in the customer portal).
 *
 * Carrier pages want the bare number: Yamato's parcel page answers a system
 * error to "4725-7551-6733" and shows the parcel for "472575516733"
 * (verified 2026-10-02); Japan Post and LBC accept either. Staff type numbers
 * the way the slip prints them, hyphens and all, so the spaces and hyphens are
 * stripped here, once, before the template is filled. Letters stay (EMS codes
 * are EJ…JP). A template without the placeholder is a landing page: returned
 * as is, and the number is shown on screen for manual entry.
 */
export const TRACKING_PLACEHOLDER = '{tracking_code}';

export function normalizeTrackingNumber(raw: string): string {
  return raw.replace(/[\s\u3000-]/g, '').trim();
}

export function buildTrackingUrl(
  method: { tracking_url_template: string | null; supports_deeplink: boolean | null } | null | undefined,
  trackingNumber: string | null | undefined,
): string | null {
  if (!method || !trackingNumber || !method.tracking_url_template) return null;
  if (!method.supports_deeplink || !method.tracking_url_template.includes(TRACKING_PLACEHOLDER)) {
    return method.tracking_url_template;
  }
  return method.tracking_url_template.replace(
    TRACKING_PLACEHOLDER,
    encodeURIComponent(normalizeTrackingNumber(trackingNumber)),
  );
}
