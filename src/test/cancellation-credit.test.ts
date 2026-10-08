import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { cancellationCreditSplit, jstDate, orderJapanDay, phtDate } from '@/lib/cancellation-credit';

// Mirrors development/sql/square-qa-refunds-credit-acceptance.sql "RULE" checks
// and development/sql/sqf01-cancellation-jst-acceptance.sql.
//
// D-SQF01 = A (owner 2026-10-08 23:38): the order day and the cancel day are
// both JAPAN days. order_date is still written as the PHT day; the creation
// instant restores the Japan day while order_date is untouched.
describe('cancellationCreditSplit — Japan-day rule (SQF01)', () => {
  // The reviewer's reproduction: ¥10,000, ordered 8 Oct 00:30 JST, cancelled 8 Oct 12:00 JST.
  // order_date was written as the PHT day of the order = 7 Oct.
  const orderAt = new Date('2026-10-07T15:30:00Z'); // 8 Oct 00:30 JST = 7 Oct 23:30 PHT
  it('SQF01: order 00:30 JST, cancel noon the same Japan day → 100 % (was 30 % charge)', () => {
    const s = cancellationCreditSplit('JPY', '2026-10-07', 10000, new Date('2026-10-08T03:00:00Z'), orderAt);
    expect(s).toMatchObject({ rule: 'same_day', kept: 0, credit: 10000, orderDay: '2026-10-08', cancelDay: '2026-10-08' });
  });
  it('same order, cancelled 9 Oct 00:00:01 JST → after order day, 30 % kept', () => {
    const s = cancellationCreditSplit('JPY', '2026-10-07', 10000, new Date('2026-10-08T15:00:01Z'), orderAt);
    expect(s).toMatchObject({ rule: 'after_order_day', kept: 3000, credit: 7000, orderDay: '2026-10-08', cancelDay: '2026-10-09' });
  });
  it('the other midnight: order 23:30 JST 7 Oct, cancel 00:30 JST 8 Oct → after order day (the terms say Japan day)', () => {
    const at7 = new Date('2026-10-07T14:30:00Z'); // 23:30 JST 7 Oct = 22:30 PHT 7 Oct → order_date 2026-10-07
    const s = cancellationCreditSplit('JPY', '2026-10-07', 10000, new Date('2026-10-07T15:30:00Z'), at7);
    expect(s).toMatchObject({ rule: 'after_order_day', orderDay: '2026-10-07', cancelDay: '2026-10-08' });
  });
  it('cancel 23:59:59 JST on the order day → same day; 00:00:00 JST next day → after', () => {
    const at = new Date('2026-10-08T01:00:00Z'); // 10:00 JST 8 Oct = 09:00 PHT 8 Oct
    expect(cancellationCreditSplit('JPY', '2026-10-08', 10000, new Date('2026-10-08T14:59:59Z'), at).rule).toBe('same_day');
    expect(cancellationCreditSplit('JPY', '2026-10-08', 10000, new Date('2026-10-08T15:00:00Z'), at).rule).toBe('after_order_day');
  });
  it('an admin-edited order_date (V10c) is read as a Japan day as it stands', () => {
    // created 8 Oct 10:00 JST, but order_date edited to 6 Oct → 6 Oct is the order day; a cancel on 8 Oct is after.
    const at = new Date('2026-10-08T01:00:00Z');
    expect(cancellationCreditSplit('JPY', '2026-10-06', 10000, new Date('2026-10-08T02:00:00Z'), at)).toMatchObject({ rule: 'after_order_day', orderDay: '2026-10-06' });
    // edited FORWARD to 9 Oct → a cancel on 8 Oct is on/before the order day → 100 %.
    expect(cancellationCreditSplit('JPY', '2026-10-09', 10000, new Date('2026-10-08T02:00:00Z'), at)).toMatchObject({ rule: 'same_day', orderDay: '2026-10-09' });
  });
  it('a typed Hub order (Page365 / live selling date, no matching instant) uses the typed date as a Japan day', () => {
    const created = new Date('2026-10-08T01:00:00Z'); // staff typed it on 8 Oct, order_date = 1 Oct (live selling)
    expect(cancellationCreditSplit('JPY', '2026-10-01', 40000, new Date('2026-10-08T02:00:00Z'), created)).toMatchObject({ kept: 12000, credit: 28000, orderDay: '2026-10-01' });
  });
  it('no creation instant (legacy caller) → the typed date is the Japan day; cancel day in JST', () => {
    expect(cancellationCreditSplit('JPY', '2026-10-08', 10000, new Date('2026-10-08T14:59:59Z')).rule).toBe('same_day');   // 23:59:59 JST
    expect(cancellationCreditSplit('JPY', '2026-10-08', 10000, new Date('2026-10-08T15:00:00Z')).rule).toBe('after_order_day'); // 00:00 JST 9 Oct
  });
  it('a creation instant whose PHT day is NOT order_date never overrides the typed date', () => {
    expect(orderJapanDay('2026-10-05', new Date('2026-10-07T15:30:00Z'))).toBe('2026-10-05');
    expect(orderJapanDay('2026-10-07', new Date('2026-10-07T15:30:00Z'))).toBe('2026-10-08');
    expect(orderJapanDay('2026-10-07', null)).toBe('2026-10-07');
    expect(orderJapanDay(null, new Date())).toBeNull();
    expect(orderJapanDay('2026-10-07', new Date('garbage'))).toBe('2026-10-07');
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
  it('phtDate / jstDate', () => {
    expect(phtDate(new Date('2026-10-08T15:59:59Z'))).toBe('2026-10-08');
    expect(phtDate(new Date('2026-10-08T16:00:00Z'))).toBe('2026-10-09');
    expect(jstDate(new Date('2026-10-08T14:59:59Z'))).toBe('2026-10-08');
    expect(jstDate(new Date('2026-10-08T15:00:00Z'))).toBe('2026-10-09');
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
