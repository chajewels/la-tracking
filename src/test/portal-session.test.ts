import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPortalSession,
  getPortalSessionId,
  hasLegacyPinFlag,
  isDeadLinkError,
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

/**
 * Expired link on the PIN screen (Lovable issue, fixed 2026-10-15): a dead-link
 * answer from verify-portal-pin must leave the PIN screen for the link-expired
 * screen; a wrong PIN must not.
 */
describe('isDeadLinkError', () => {
  it('recognises every token-class message from portal-auth', () => {
    for (const m of ['Token expired', 'Invalid token', 'Token has been revoked',
      'Source token has been revoked', 'Source token not found', 'Invalid portal token']) {
      expect(isDeadLinkError(m), m).toBe(true);
    }
  });
  it('never treats a PIN problem or a session problem as a dead link', () => {
    for (const m of ['Incorrect PIN. 2 attempts remaining.', 'Too many incorrect attempts. Account locked for 30 minutes.',
      'Account locked. Try again after 12:30.', 'pin_required', 'Session expired', 'Invalid or expired session',
      'Something went wrong. Please try again.', '', undefined, null, 42]) {
      expect(isDeadLinkError(m as unknown), String(m)).toBe(false);
    }
  });
});

describe('CustomerPortal hands a dead link to the expired screen', () => {
  it('routes isDeadLinkError to setError and keeps the PIN gate closed while an error is set', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(`${process.cwd()}/src/pages/CustomerPortal.tsx`, 'utf8');
    expect(src).toMatch(/if \(isDeadLinkError\(payload\?\.error\)\) \{[\s\S]{0,400}setError\(payload\.error\);/);
    expect(src).toContain("if (authMode === 'token' && !pinVerified && !error) {");
  });
});
