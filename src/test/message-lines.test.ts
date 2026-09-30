import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { createElement } from 'react';
import { render } from '@testing-library/react';
import { FALLBACK, REQUIRED, pickLine, fillLine, firstName, isValidLine, useStablePicker, type MessagePools } from '@/lib/message-lines';
import { generateReminderMessage, type AlertItem } from '@/components/monitoring/ReminderCard';

// Line sort=1 of every seed pool, parsed from the seed file.
const seed = readFileSync('docs/sql/20261001100000_message_lines_seed.sql', 'utf8');
const unesc = (b: string) => b.replace(/\\n/g, '\n').replace(/\\'/g, "'");
const line1 = new Map<string, string>();
for (const m of seed.matchAll(/\('([a-z0-9_]+)', '([a-z]+)', E'((?:[^'\\]|\\.)*)', (\d+)\)/g)) {
  if (m[4] === '1') line1.set(`${m[1]}:${m[2]}`, unesc(m[3]));
}

describe('message-lines', () => {
  it('fallbacks equal line 1 of each pool (today\'s text)', () => {
    expect(line1.size).toBe(37);
    expect(Object.keys(FALLBACK).sort()).toEqual([...line1.keys()].sort());
    for (const [k, v] of line1) expect(FALLBACK[k]).toBe(v);
  });

  it('empty or missing pools → fallback', () => {
    for (const k of Object.keys(FALLBACK)) {
      const [t, p] = k.split(':');
      expect(pickLine(undefined, t, p)).toBe(FALLBACK[k]);
      expect(pickLine({}, t, p)).toBe(FALLBACK[k]);
    }
  });

  it('reminder with no pools is today\'s text', () => {
    const a: AlertItem = {
      type: 'upcoming', bucket: 'due_7_days' as AlertItem['bucket'], customer: 'Maria Santos', invoice: '19001',
      dueDate: '2026-10-01', amount: 7000, remainingBalance: 14000, currency: 'PHP', daysOverdue: -7,
      accountId: 'a', scheduleId: 's', customerId: 'c',
    };
    expect(generateReminderMessage(a)).toMatch(/^Hi Maria Santos! 👋\n\nThis is a friendly heads-up from Cha Jewels — your next layaway payment for INV #19001 is coming up on /);
    expect(generateReminderMessage(a).endsWith('Thank you for staying on track! 💎')).toBe(true);
  });

  it('never picks invalid lines', () => {
    const pools: MessagePools = {
      'reminder_overdue:opening': ['Hi {name} INV #{invoice} {due_date}', 'Hi {invoice} {invoice} {due_date} {days_ago}', 'x {invoice} {due_date} {days_ago} {oops}'],
      'thanks_trust:closing': ['Bad {unknown}'],
    };
    for (let i = 0; i < 50; i++) {
      expect(pickLine(pools, 'reminder_overdue', 'opening')).toBe(FALLBACK['reminder_overdue:opening']);
      expect(pickLine(pools, 'thanks_trust', 'closing')).toBe(FALLBACK['thanks_trust:closing']);
    }
    expect(isValidLine('Hi {first_name}! {link}', REQUIRED['portal_link_share:full'])).toBe(true);
    expect(isValidLine('Hi {first_name}!', REQUIRED['portal_link_share:full'])).toBe(false);
  });

  it('fillLine fills all placeholders; first_name fallback "there"', () => {
    expect(fillLine('{name}|{first_name}|{invoice}|{due_date}|{days_ago}|{link}', {
      name: 'Maria Santos', invoice: '1', due_date: 'D', days_ago: '3 days ago', link: 'L',
    })).toBe('Maria Santos|Maria|1|D|3 days ago|L');
    expect(firstName('')).toBe('there');
    expect(firstName(null)).toBe('there');
    expect(fillLine('Hi {first_name}', { name: '  ' })).toBe('Hi there');
  });

  it('stable picker does not re-roll on re-render', () => {
    const pools: MessagePools = { 'thanks_trust:closing': ['A', 'B', 'C', 'D', 'E', 'F'] };
    const seen: string[] = [];
    const C = ({ n }: { n: number }) => {
      const pick = useStablePicker(pools);
      seen.push(pick('thanks_trust', 'closing'));
      return createElement('span', null, String(n));
    };
    const r = render(createElement(C, { n: 0 }));
    for (let i = 1; i < 20; i++) r.rerender(createElement(C, { n: i }));
    expect(new Set(seen).size).toBe(1);
  });
});
