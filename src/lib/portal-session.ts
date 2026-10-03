/**
 * Portal PIN session — owner decision 2026-10-03 ("Enforce PIN on the server").
 *
 * A link token (`/portal?token=…`, `/loyalty?token=…`) is no longer a login.
 * The server refuses it with `pin_required` everywhere except
 * verify-portal-pin, which checks the PIN and returns a session_id valid for
 * 12 hours. The browser keeps that id in sessionStorage, so it ends when the
 * tab closes or after 12 hours, whichever comes first, and sends it as
 * `session_id` on every portal call.
 *
 * Keyed by the link token: two links opened in one tab never share a session.
 * Every storage access is wrapped — private mode / quota simply means the PIN
 * is asked again.
 */

const SESSION_PREFIX = 'portal_session_';
// The flag the browser-only PIN gate used before 2026-10-03. Read only so a
// visit that started before the server change keeps working until the new
// edge functions are deployed; nothing sets it once a session_id comes back.
const LEGACY_PREFIX = 'portal_pin_verified_';

interface StoredSession {
  id: string;
  exp: string | null;
}

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* private mode / quota — the PIN is simply asked again */
  }
}

/** The live session id for this link token, or null (none, unreadable or expired). */
export function getPortalSessionId(token: string | null | undefined): string | null {
  if (!token) return null;
  const raw = read(SESSION_PREFIX + token);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as StoredSession;
    if (!s?.id) return null;
    if (s.exp && new Date(s.exp).getTime() <= Date.now()) {
      write(SESSION_PREFIX + token, null);
      return null;
    }
    return s.id;
  } catch {
    write(SESSION_PREFIX + token, null);
    return null;
  }
}

export function savePortalSession(token: string, id: string, expiresAt: string | null): void {
  write(SESSION_PREFIX + token, JSON.stringify({ id, exp: expiresAt } satisfies StoredSession));
  write(LEGACY_PREFIX + token, null);
}

/** Forget both the session and the legacy flag: the next screen is the PIN screen. */
export function clearPortalSession(token: string | null | undefined): void {
  if (!token) return;
  write(SESSION_PREFIX + token, null);
  write(LEGACY_PREFIX + token, null);
}

/** Pre-2026-10-03 browser flag. True only until the server change is deployed. */
export function hasLegacyPinFlag(token: string | null | undefined): boolean {
  return !!token && read(LEGACY_PREFIX + token) === '1';
}

export function setLegacyPinFlag(token: string): void {
  write(LEGACY_PREFIX + token, '1');
}

/**
 * True when the server answer means "enter the PIN (again)": the bare link was
 * refused, or the PIN session ended / is unknown. Token-class errors ('Invalid
 * token', 'Token expired', 'Token has been revoked') are NOT included — those
 * are a dead link and keep their own screen.
 */
export function isPinRequiredError(message: unknown): boolean {
  if (typeof message !== 'string') return false;
  const m = message.toLowerCase();
  return m === 'pin_required' || m === 'session expired' || m === 'invalid or expired session';
}

/** Where to send a link-token visitor who has no session: the PIN screen. */
export function pinScreenUrl(token: string, next?: 'loyalty'): string {
  const q = new URLSearchParams({ token });
  if (next) q.set('next', next);
  return `/portal?${q.toString()}`;
}
