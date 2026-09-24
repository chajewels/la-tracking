import { describe, expect, it } from 'vitest';
import { initialsOf } from '@/lib/initials';

describe('initialsOf (header monogram)', () => {
  it('uses the first and last word', () => {
    expect(initialsOf('Juan Miguel Bautista')).toBe('JB');
    expect(initialsOf('Maria Consolación Villanueva-Dela Cruz')).toBe('MC');
  });
  it('ignores a parenthesised reading so scripts are not mixed', () => {
    expect(initialsOf('Bernadette （たかはし みさきこ）')).toBe('B');
    expect(initialsOf('髙橋 美咲子 （たかはし みさきこ）')).toBe('髙美');
  });
  it('skips leading punctuation and falls back to CJ', () => {
    expect(initialsOf('（nickname）')).toBe('N');
    expect(initialsOf('"Bea" Santos')).toBe('BS');
    expect(initialsOf('')).toBe('CJ');
    expect(initialsOf(null)).toBe('CJ');
  });
});
