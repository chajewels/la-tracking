import { describe, it, expect } from 'vitest';
import { buildTrackingUrl, normalizeTrackingNumber } from '@/lib/tracking-link';

// Backlog S4 #26 (2026-10-02): carriers want the bare number — Yamato's parcel
// page refuses "4725-7551-6733" and shows "472575516733".
const yamato = {
  tracking_url_template: 'https://member.kms.kuronekoyamato.co.jp/parcel/detail?pno={tracking_code}',
  supports_deeplink: true,
};

describe('tracking links', () => {
  it('strips spaces, full-width spaces and hyphens, keeps letters', () => {
    expect(normalizeTrackingNumber('4725-7551-6733')).toBe('472575516733');
    expect(normalizeTrackingNumber(' 4725 7551　6733 ')).toBe('472575516733');
    expect(normalizeTrackingNumber('EJ123456789JP')).toBe('EJ123456789JP');
  });

  it('fills the template with the normalized number', () => {
    expect(buildTrackingUrl(yamato, '4725-7551-6733')).toBe(
      'https://member.kms.kuronekoyamato.co.jp/parcel/detail?pno=472575516733',
    );
  });

  it('returns the landing page when the carrier has no deep link', () => {
    const landing = { tracking_url_template: 'https://example.test/track', supports_deeplink: false };
    expect(buildTrackingUrl(landing, '123')).toBe('https://example.test/track');
    // a deep-link flag without the placeholder is still a landing page
    expect(buildTrackingUrl({ ...landing, supports_deeplink: true }, '123')).toBe('https://example.test/track');
  });

  it('is null without a method or a number', () => {
    expect(buildTrackingUrl(null, '123')).toBeNull();
    expect(buildTrackingUrl(yamato, '')).toBeNull();
  });
});
