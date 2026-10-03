import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPortalSession,
  getPortalSessionId,
  hasLegacyPinFlag,
  isPinRequiredError,
  pinScreenUrl,
  savePortalSession,
  setLegacyPinFlag,
} from '@/lib/portal-session';
import { portalAuthBody } from '@/lib/portal-auth';

/**
 * Portal PIN enforcement (owner 2026-10-03): a link token is never a login on
 * its own. The browser keeps the PIN session verify-portal-pin issued, sends
 * it on every call, and drops it when the server says pin_required.
 */
describe('portal PIN session', () => {
  beforeEach(() => sessionStorage.clear());

  it('has no session for a fresh link', () => {
    expect(getPortalSessionId('tok-a')).toBeNull();
    expect(portalAuthBody('tok-a')).toEqual({ portal_token: 'tok-a', token: 'tok-a' });
  });

  it('keeps the session per link token and sends it with the token', () => {
    savePortalSession('tok-a', 'sess-1', null);
    expect(getPortalSessionId('tok-a')).toBe('sess-1');
    expect(getPortalSessionId('tok-b')).toBeNull();
    expect(portalAuthBody('tok-a')).toEqual({ portal_token: 'tok-a', token: 'tok-a', session_id: 'sess-1' });
  });

  it('forgets an expired session', () => {
    savePortalSession('tok-a', 'sess-1', new Date(Date.now() - 1000).toISOString());
    expect(getPortalSessionId('tok-a')).toBeNull();
  });

  it('keeps a session that has not expired', () => {
    savePortalSession('tok-a', 'sess-1', new Date(Date.now() + 60_000).toISOString());
    expect(getPortalSessionId('tok-a')).toBe('sess-1');
  });

  it('clears both the session and the legacy flag', () => {
    setLegacyPinFlag('tok-a');
    savePortalSession('tok-a', 'sess-1', null);
    expect(hasLegacyPinFlag('tok-a')).toBe(false); // saving a session retires the flag
    clearPortalSession('tok-a');
    expect(getPortalSessionId('tok-a')).toBeNull();
    expect(hasLegacyPinFlag('tok-a')).toBe(false);
  });

  it('a signed-in (password) customer sends no token fields', () => {
    expect(portalAuthBody(null)).toEqual({});
    expect(portalAuthBody(undefined)).toEqual({});
  });

  it('tells a PIN prompt apart from a dead link', () => {
    expect(isPinRequiredError('pin_required')).toBe(true);
    expect(isPinRequiredError('Session expired')).toBe(true);
    expect(isPinRequiredError('Invalid or expired session')).toBe(true);
    expect(isPinRequiredError('Token expired')).toBe(false);
    expect(isPinRequiredError('Invalid token')).toBe(false);
    expect(isPinRequiredError('Token has been revoked')).toBe(false);
    expect(isPinRequiredError(undefined)).toBe(false);
  });

  it('builds the PIN screen url, with the loyalty return', () => {
    expect(pinScreenUrl('t 1')).toBe('/portal?token=t+1');
    expect(pinScreenUrl('abc', 'loyalty')).toBe('/portal?token=abc&next=loyalty');
  });
});
