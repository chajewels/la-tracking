import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Migration 20261215100000 (2026-10-15): the Page365 14-day cleanup and the
 * quick plan timed out on every scheduled run (Lovable issue; docs/FIXED-BUGS.md).
 * Keeps the fix in place: the two missing indexes, a bounded batch per call,
 * and the unchanged keep-what-was-applied rules.
 */
const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261215100000_page365_inventory_retention_batched.sql'), 'utf8');
const code = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

describe('page365 retention: batched + indexed', () => {
  it('starts from the live body it was written against (Bug #280)', () => {
    expect(code).toContain("<> '35b0a06941fcd1690d7093e72a98c52b' THEN");
  });

  it('indexes the cascade column and the quick-plan lookup', () => {
    expect(code).toMatch(/ON public\.page365_inventory_items \(inventory_product_id\)/);
    expect(code).toMatch(/ON public\.page365_inventory_items \(page365_product_id, code, run_id\)\s+WHERE kind = 'page365'/);
    expect(code).toMatch(/ON public\.page365_landings \(item_id\)/);
  });

  it('works through a bounded batch of the oldest runs per call', () => {
    expect(code).toContain('v_batch       constant integer := 25;');
    expect(code).toMatch(/ORDER BY r\.created_at\s+LIMIT v_batch\);/);
    expect(code).toContain("'remaining', v_remaining");
  });

  it('keeps the old rules: applied rows stay, the latest ready run and a fetching run are never touched', () => {
    expect(code).not.toMatch(/audit_logs/);
    expect(code).toContain("i.status = 'applied' OR i.applied_at IS NOT NULL");
    expect(code).toContain("r.status <> 'fetching'");
    expect(code).toContain('r.id IS DISTINCT FROM v_latest');
    expect(code).toContain('greatest(coalesce(p_keep_days, 14), 7)');
  });

  it('stays service-role only', () => {
    expect(code).toContain('REVOKE ALL ON FUNCTION public.page365_inventory_retention(integer) FROM PUBLIC, anon, authenticated;');
    expect(code).toContain('GRANT EXECUTE ON FUNCTION public.page365_inventory_retention(integer) TO service_role;');
  });
});
