import { describe, expect, it } from 'vitest';
import { csvEscape, toCsv } from '@/lib/csv';

/**
 * Lovable scan 2026-10-01 (LOV.IN.SPREADSHEET_FORMULA_NEUTRALIZATION): customer
 * names are typed by customers on the website and land in the Cash orders and
 * Layaway accounts exports. A text cell that opens with a formula trigger must
 * reach the spreadsheet as text.
 */
describe('csvEscape formula guard', () => {
  it.each(['=HYPERLINK("http://x","y")', '+1+1', '-2+3', '@SUM(A1)', '\tx', '\rx'])(
    'prefixes an apostrophe to text starting with a formula trigger: %s',
    (v) => {
      const out = csvEscape(v);
      const unquoted = out.startsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out;
      expect(unquoted.startsWith("'")).toBe(true);
      expect(unquoted.slice(1)).toBe(v);
    },
  );

  it('leaves real numbers untouched, including negatives', () => {
    expect(csvEscape(-500)).toBe('-500');
    expect(csvEscape(0)).toBe('0');
    expect(csvEscape(12345.5)).toBe('12345.5');
  });

  it('leaves ordinary text untouched', () => {
    expect(csvEscape('Maria Santos')).toBe('Maria Santos');
    expect(csvEscape('19144')).toBe('19144');
    expect(csvEscape('')).toBe('');
    expect(csvEscape(null)).toBe('');
  });

  it('still applies RFC 4180 quoting after the guard', () => {
    expect(csvEscape('=1,2')).toBe(`"'=1,2"`);
    expect(csvEscape('a "b"')).toBe('"a ""b"""');
  });

  it('guards every row of a built file', () => {
    expect(toCsv(['Customer', 'Balance'], [['=cmd()', -10]])).toBe("Customer,Balance\n'=cmd(),-10");
  });
});
