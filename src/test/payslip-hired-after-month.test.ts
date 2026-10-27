import { describe, it, expect } from 'vitest';
import { hiredAfterMonth, type Payslip } from '@/lib/payslips';

const slip = (status: string) => ({ status } as unknown as Payslip);

describe('hiredAfterMonth — staff not on a month before they joined (owner 2026-10-28)', () => {
  it('hides a June hire in April and May', () => {
    expect(hiredAfterMonth('2026-06-01', '2026-04', null)).toBe(true);
    expect(hiredAfterMonth('2026-06-01', '2026-05', null)).toBe(true);
  });
  it('shows them from the hire month on', () => {
    expect(hiredAfterMonth('2026-06-01', '2026-06', null)).toBe(false);
    expect(hiredAfterMonth('2026-06-15', '2026-07', null)).toBe(false);
  });
  it('a voided payslip does not keep them on the month', () => {
    expect(hiredAfterMonth('2026-06-01', '2026-04', slip('void'))).toBe(true);
  });
  it('a live payslip keeps them on the month', () => {
    expect(hiredAfterMonth('2026-06-01', '2026-04', slip('finalized'))).toBe(false);
  });
  it('no hire date: always shown', () => {
    expect(hiredAfterMonth(null, '2026-04', null)).toBe(false);
  });
});
