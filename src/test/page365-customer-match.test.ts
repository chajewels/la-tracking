import { describe, it, expect } from 'vitest';
import {
  digitsOnly, samePhone, matchFields, suggestCustomers, searchCustomers,
  NAME_SUGGESTION_LIMIT, type MatchableCustomer,
} from '@/lib/page365-customer-match';

const cust = (over: Partial<MatchableCustomer> & { id: string }): MatchableCustomer => ({
  full_name: null, facebook_name: null, mobile_number: null, email: null, customer_code: null, ...over,
});

describe('samePhone — identical digits always match, whatever separates them', () => {
  it.each([
    ['555-123-4567', '5551234567'],
    ['555-123-4567', '555-123-4567'],
    ['555 123 4567', '(555) 123-4567'],
    ['555.123.4567', '555/123/4567'],
    ['+63 917 123 4567', '09171234567'],
    ['+81 90-1234-5678', '090 1234 5678'],
    ['123-4567', '1234567'],
  ])('%s = %s', (a, b) => {
    expect(samePhone(a, b)).toBe(true);
  });

  it('different numbers do not match', () => {
    expect(samePhone('555-123-4567', '555-123-4568')).toBe(false);
    expect(samePhone('1234567', '7654321')).toBe(false);
  });

  it('too few digits is not a phone', () => {
    expect(samePhone('12-34', '1234')).toBe(false);
    expect(samePhone(null, '5551234567')).toBe(false);
  });

  it('digitsOnly drops every non-digit character', () => {
    expect(digitsOnly('+(63) 917-123.4567 ext')).toBe('639171234567');
  });
});

describe('matchFields — the 19794 case', () => {
  // Hub record under her real name, Facebook name saved, phone stored WITH dashes;
  // Page365 sends the Facebook name and the phone.
  const venus = cust({ id: 'v', full_name: 'Real Name', facebook_name: 'Ako Si Test', mobile_number: '555-247-9913' });

  it('matches on Facebook name and on phone despite the dashes', () => {
    expect(matchFields(venus, 'Ako Si Test', '555-247-9913')).toEqual(['facebook name', 'phone']);
    expect(matchFields(venus, 'Ako Si Test', '5552479913')).toEqual(['facebook name', 'phone']);
  });

  it('phone alone still finds her when Page365 sends another name', () => {
    expect(matchFields(venus, 'Someone Else', '(555) 247 9913')).toEqual(['phone']);
  });

  it('name comparison ignores case and extra spaces', () => {
    expect(matchFields(venus, '  ako   si TEST ', null)).toEqual(['facebook name']);
    expect(matchFields(venus, 'real name', null)).toEqual(['name']);
  });

  it('no match returns nothing', () => {
    expect(matchFields(venus, 'Nobody', '000-000-0000')).toEqual([]);
  });
});

describe('suggestCustomers', () => {
  it('phone matches come first and are never cut off by the name limit', () => {
    const many = Array.from({ length: NAME_SUGGESTION_LIMIT + 5 }, (_, i) =>
      cust({ id: `m${i}`, full_name: `Maria ${String(i).padStart(2, '0')}` }));
    const phoneOne = cust({ id: 'p', full_name: 'Zed Last', mobile_number: '555-247-9913' });
    const out = suggestCustomers([...many, phoneOne], 'Maria', '5552479913');
    expect(out[0].customer.id).toBe('p');
    expect(out[0].basis).toEqual(['phone']);
    expect(out.filter((s) => !s.basis.includes('phone'))).toHaveLength(NAME_SUGGESTION_LIMIT);
  });

  it('a name with commas or brackets is just text — no crash, still matches', () => {
    const c = cust({ id: 'b', facebook_name: 'Maria (Mhia), Cruz' });
    expect(suggestCustomers([c], 'Maria (Mhia), Cruz', null)).toHaveLength(1);
  });
});

describe('searchCustomers', () => {
  const list = [
    cust({ id: '1', full_name: 'Real Name', facebook_name: 'Ako Si Test', mobile_number: '555-247-9913', email: 'real@example.com', customer_code: 'CJ-0001' }),
    cust({ id: '2', full_name: 'Other Person', mobile_number: '090 1111 2222' }),
  ];

  it.each(['ako si', 'REAL NAME', 'real@example', 'cj-0001', '5552479913', '555 247', '247-9913'])(
    'finds customer 1 by %s', (term) => {
      expect(searchCustomers(list, term).map((c) => c.id)).toContain('1');
    });

  it('finds a spaced phone by its digits', () => {
    expect(searchCustomers(list, '09011112222').map((c) => c.id)).toEqual(['2']);
  });

  it('needs at least 2 characters', () => {
    expect(searchCustomers(list, 'a')).toEqual([]);
  });
});
