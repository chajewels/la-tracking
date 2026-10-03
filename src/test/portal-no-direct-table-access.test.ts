import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The customer portal never talks to a table directly (CLAUDE.md DOMAIN
 * ARCHITECTURE; Bug #165). Until 2026-10-03 CashOrdersSection read and
 * cancelled pending cash submissions through PostgREST with an
 * `x-portal-token` header and anon RLS policies — the one portal path a bare
 * link could still reach after the PIN moved to the server. The policies are
 * dropped (migration 20261029100000); this test keeps the header from coming
 * back anywhere under src/.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !p.includes('/src/test/')) out.push(p);
  }
  return out;
}

describe('portal never sends x-portal-token to PostgREST', () => {
  it('no file under src/ references the x-portal-token header', () => {
    const offenders = walk(join(process.cwd(), 'src')).filter((f) =>
      readFileSync(f, 'utf8').includes('x-portal-token'),
    );
    expect(offenders).toEqual([]);
  });
});
