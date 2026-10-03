import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Since the PIN moved to the server (2026-10-03) a bare link token is refused
 * by customer-portal with `pin_required`; only the PIN session id
 * (getPortalSessionId / portalAuthBody) authenticates a link customer.
 * RedemptionForm's order list still sent `?token=` alone, so the fetch failed
 * silently and "discount on a new order" could never be submitted
 * (docs/FIXED-BUGS.md 2026-10-03). This test keeps every customer-portal
 * caller under src/ that sends the token on the URL sending the session too.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !p.includes('/src/test/')) out.push(p);
  }
  return out;
}

describe('portal token calls also send the PIN session', () => {
  it('every file that puts ?token= on a customer-portal URL also sends session_id', () => {
    const offenders = walk(join(process.cwd(), 'src')).filter((f) => {
      const src = readFileSync(f, 'utf8');
      if (!src.includes('functions/v1/customer-portal')) return false;
      const sendsTokenOnUrl = src.includes("searchParams.set('token'") || src.includes('customer-portal?token=');
      return sendsTokenOnUrl && !src.includes('session_id');
    });
    expect(offenders).toEqual([]);
  });
});
