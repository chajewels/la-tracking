import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { cancellationCreditSplit, phtDate } from '@/lib/cancellation-credit';

// Mirrors development/sql/square-qa-refunds-credit-acceptance.sql "RULE" checks.
describe('cancellationCreditSplit (owner rule 2026-10-08)', () => {
  it('same PHT day (how order_date is written) → 100%', () => {
    expect(cancellationCreditSplit('JPY', '2026-10-08', 10000, new Date('2026-10-08T15:59:59Z')).credit).toBe(10000);
    expect(cancellationCreditSplit('JPY', '2026-10-08', 10000, new Date('2026-10-08T15:59:59Z')).rule).toBe('same_day');
  });
  it('an order placed 00:30 JST (23:30 PHT, order_date = that PHT day) cancelled at 10:00 JST is still the same day', () => {
    // order_date written by the Hub as PHT 2026-10-08; cancel at 2026-10-09 01:00Z = 10:00 JST = 09:00 PHT 9 Oct → different PHT day.
    // Order placed 00:30 JST 9 Oct = 15:30Z 8 Oct = 23:30 PHT 8 Oct → order_date 2026-10-08. Cancelled 00:50 JST same night = 23:50 PHT → same day.
    expect(cancellationCreditSplit('JPY', '2026-10-08', 10000, new Date('2026-10-08T15:50:00Z')).rule).toBe('same_day');
  });
  it('00:00 PHT the next day → 70%', () => {
    const s = cancellationCreditSplit('JPY', '2026-10-08', 10000, new Date('2026-10-08T16:00:00Z'));
    expect(s).toMatchObject({ rule: 'after_order_day', kept: 3000, credit: 7000 });
  });
  it("owner's example: ¥40,000 paid → ¥12,000 kept, ¥28,000 credit", () => {
    expect(cancellationCreditSplit('JPY', '2026-10-01', 40000, new Date('2026-10-08T00:00:00Z'))).toMatchObject({ kept: 12000, credit: 28000 });
  });
  it('yen rounds half-up; pesos to 2 decimals', () => {
    expect(cancellationCreditSplit('JPY', '2026-10-01', 12345, new Date('2026-10-08T00:00:00Z')).kept).toBe(3704);
    expect(cancellationCreditSplit('PHP', '2026-10-01', 1000.55, new Date('2026-10-08T00:00:00Z')).kept).toBe(300.17);
  });
  it('missing order date → never charged', () => {
    expect(cancellationCreditSplit('JPY', null, 5000, new Date()).kept).toBe(0);
  });
  it('phtDate', () => {
    expect(phtDate(new Date('2026-10-08T15:59:59Z'))).toBe('2026-10-08');
    expect(phtDate(new Date('2026-10-08T16:00:00Z'))).toBe('2026-10-09');
  });
  it('pesos: many inputs match SQL round(x*0.30, 2)', () => {
    for (let c = 1; c < 5000; c += 7) {
      const money = c / 100;
      const sql = Math.round(Number((money * 30).toFixed(6))) / 100; // round(money*0.30,2)
      expect(cancellationCreditSplit('PHP', '2026-10-01', money, new Date('2026-10-08T00:00:00Z')).kept).toBe(sql);
    }
  });
  it('the edge-function twin is byte-identical below the header', () => {
    const strip = (s: string) => s.replace(/^\/\*\*[\s\S]*?\*\/\n/, '');
    expect(strip(readFileSync('supabase/functions/_shared/cancellation-credit.ts', 'utf8'))).toBe(strip(readFileSync('src/lib/cancellation-credit.ts', 'utf8')));
  });
});
