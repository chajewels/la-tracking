import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The split lump sum on New Account was RETIRED on 2026-10-08 (owner). It let
 * create-layaway-account insert a payment straight into ANOTHER account — no
 * proof, no reviewer Confirm, no allocate_payment_atomic — and the server never
 * checked the target belonged to the same customer (Lovable scan finding
 * "Some actions can reach other users' records"). docs/FIXED-BUGS.md.
 *
 * These checks keep it gone: the function refuses the field before any write
 * and never writes a payment row, and the page no longer offers it.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('split lump sum stays retired', () => {
  const fn = read('supabase/functions/create-layaway-account/index.ts');
  const page = read('src/pages/NewAccount.tsx');

  it('create-layaway-account refuses split_allocations', () => {
    expect(fn).toContain('error: "split_payment_retired"');
  });

  it('create-layaway-account never inserts a payment or allocation', () => {
    expect(fn).not.toMatch(/from\(["']payments["']\)\s*\.insert/);
    expect(fn).not.toMatch(/from\(["']payment_allocations["']\)\s*\.insert/);
  });

  it('the refusal runs before the account is created', () => {
    const refuse = fn.indexOf('error: "split_payment_retired"');
    const insertAccount = fn.indexOf('from("layaway_accounts")\n      .insert');
    const anyAccountInsert = insertAccount >= 0 ? insertAccount : fn.search(/from\(["']layaway_accounts["']\)\s*\.insert/);
    expect(refuse).toBeGreaterThan(0);
    expect(anyAccountInsert).toBeGreaterThan(refuse);
  });

  it('New Account no longer sends or shows the split', () => {
    expect(page).not.toContain('split_allocations');
    expect(page).not.toContain('Split Lump Sum Payment');
  });
});
