import { describe, it, expect } from 'vitest';
import { formatPHTDateOrTime, formatPHTDisplay } from '@/lib/date-utils';

describe('formatPHTDateOrTime', () => {
  it('shows a date-only value as its calendar day, with no time', () => {
    expect(formatPHTDateOrTime('2026-09-30')).toBe('Sep 30, 2026');
    expect(formatPHTDateOrTime('2026-09-30')).not.toMatch(/AM|PM|PHT/);
  });
  it('shows a timestamp as the usual PHT display', () => {
    const ts = '2026-09-30T01:05:00Z';
    expect(formatPHTDateOrTime(ts)).toBe(formatPHTDisplay(ts));
    expect(formatPHTDateOrTime(ts)).toMatch(/9:05 AM PHT$/);
  });
});
