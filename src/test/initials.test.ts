import { describe, expect, it } from 'vitest';
import { initialsOf } from '@/lib/initials';

describe('initialsOf (header monogram)', () => {
  it('uses the first and last word', () => {
    expect(initialsOf('Juan Miguel Bautista')).toBe('JB');
    expect(initialsOf('Maria Consolación Villanueva-Dela Cruz')).toBe('MC');
  });
  it('ignores a parenthesised reading so scripts are not mixed', () => {
    expect(initialsOf('Bernadette （たかはし みさきこ）')).toBe('B');
    expect(initialsOf('Angelica 高橋（たかはし）')).toBe('A');
  });
  it('skips leading punctuation and falls back to CJ', () => {
    expect(initialsOf('（nickname）')).toBe('N');
    expect(initialsOf('"Bea" Santos')).toBe('BS');
    expect(initialsOf('')).toBe('CJ');
    expect(initialsOf(null)).toBe('CJ');
  });
  it('mixed Latin + Japanese names use the Latin initial(s) only', () => {
    expect(initialsOf('Angel ペイブ')).toBe('A');
    expect(initialsOf('ペイブ Angel')).toBe('A');
    expect(initialsOf('Maria 高橋 Santos')).toBe('MS');
  });
  it('an all-Japanese name uses its first character', () => {
    expect(initialsOf('髙橋 美咲子 （たかはし みさきこ）')).toBe('髙');
    expect(initialsOf('ペイブ')).toBe('ペ');
  });
  it('never splits a character: decomposed kana and accents stay whole', () => {
    // ペ written as ヘ + combining handakuten (NFD) must not come out as ヘ or a bare mark.
    expect(initialsOf('ペイブ')).toBe('ペ');
    expect(initialsOf('Angel ペイブ')).toBe('A');
    expect(initialsOf('Émile Zola')).toBe('ÉZ');
  });
});
