import { describe, it, expect } from 'vitest';
import { FALLBACK, REQUIRED, isValidLine } from '@/lib/message-lines';
import {
  ALL_POOLS, REVIEW_POOL, allowedPlaceholders, requiredPlaceholders, lineProblem, previewLine, splitPool, isLockedLine,
} from '@/lib/message-lines-admin';

describe('message-lines-admin', () => {
  it('the editor lists exactly the pools the code reads (37 + review invite)', () => {
    const codePools = Object.keys(FALLBACK).sort();
    const editorPools = ALL_POOLS.filter((p) => p !== REVIEW_POOL).sort();
    expect(editorPools).toEqual(codePools);
    expect(ALL_POOLS).toContain(REVIEW_POOL);
    expect(new Set(ALL_POOLS).size).toBe(ALL_POOLS.length);
  });

  it('required placeholders match the readers', () => {
    for (const p of Object.keys(FALLBACK)) expect(requiredPlaceholders(p)).toEqual(REQUIRED[p] ?? []);
    expect(requiredPlaceholders(REVIEW_POOL)).toEqual(['link']);
    expect(allowedPlaceholders(REVIEW_POOL)).toEqual(['first_name', 'piece', 'link']);
  });

  it('every fallback line is valid in the editor', () => {
    for (const [p, body] of Object.entries(FALLBACK)) expect(lineProblem(p, body)).toBeNull();
  });

  it('agrees with isValidLine on every Copy Message pool', () => {
    const samples = [
      'Hi {name}!',
      'Hi {nam}!',
      'INV #{invoice} due {due_date}',
      'INV #{invoice} due {due_date} ({days_ago})',
      '{invoice} {invoice} {due_date}',
      'stray { brace',
      'Link: {link}',
      '',
    ];
    for (const p of Object.keys(FALLBACK)) {
      for (const s of samples) {
        const editorOk = lineProblem(p, s) === null;
        const readerOk = s.trim().length > 0 && isValidLine(s, REQUIRED[p] ?? []);
        expect(editorOk, `${p} :: ${JSON.stringify(s)}`).toBe(readerOk);
      }
    }
  });

  it('names the problem', () => {
    expect(lineProblem('payment_received:opening', '')).toMatch(/empty/);
    expect(lineProblem('payment_received:opening', 'Hi {piece}')).toMatch(/Unknown placeholder \{piece\}/);
    expect(lineProblem('reminder_upcoming:opening', 'Hi {name}, INV #{invoice}')).toMatch(/\{due_date\} is required/);
    expect(lineProblem('reminder_upcoming:opening', '#{invoice} #{invoice} {due_date}')).toMatch(/only once/);
    expect(lineProblem('thanks_trust:closing', 'Thanks }')).toMatch(/stray/);
    expect(lineProblem(REVIEW_POOL, 'Hi {first_name}, review {piece}')).toMatch(/\{link\} is required/);
    expect(lineProblem(REVIEW_POOL, 'Hi {first_name}, review {piece}: {link}')).toBeNull();
  });

  it('previews with sample values', () => {
    expect(previewLine('reminder_due_today:opening', FALLBACK['reminder_due_today:opening'])).toBe(
      'Hi Maria Santos 💎\n\nYour layaway payment for Invoice #19500 is due TODAY, Oct 05, 2026.',
    );
    expect(previewLine(REVIEW_POOL, 'Hi {first_name}, {piece}: {link}')).toBe(
      'Hi Maria, K18 Akoya pearl necklace: https://portal.chajewelsjp.com/portal',
    );
  });

  it('splits pool keys and locks line 1', () => {
    expect(splitPool('penalty_p3:closing')).toEqual({ message_type: 'penalty_p3', part: 'closing' });
    expect(isLockedLine(1)).toBe(true);
    expect(isLockedLine(2)).toBe(false);
  });
});
