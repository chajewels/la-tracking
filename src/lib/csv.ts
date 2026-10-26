/**
 * CSV export, shared.
 *
 * Extracted from DataTable's own `exportCsv` so a screen that needs a
 * DIFFERENT export than "the visible columns of the visible rows" can produce
 * one without hand-rolling the escaping and the download, and without the two
 * drifting apart. DataTable now calls `downloadCsv` too, so there is one
 * escaping rule and one filename shape in the app.
 */

/**
 * RFC 4180 escaping: a field containing a quote, comma or newline is wrapped
 * in quotes and its own quotes are doubled. null and undefined become empty.
 *
 * FORMULA GUARD (OWASP CSV injection; Lovable scan 2026-10-01): a TEXT cell
 * starting with = + - @ TAB or CR is opened by Excel / Sheets as a formula, and
 * customers choose their own names on the website. Such a cell gets a leading
 * apostrophe so the spreadsheet shows it as text. Real numbers (typeof number,
 * e.g. a negative balance) are never touched; a phone number stored as text
 * ("+81…") does get the apostrophe — that is intended.
 */
export function csvEscape(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Build the CSV text for a header row and its rows. Exported separately from
 * the download so it can be asserted on in a test without a DOM.
 */
export function toCsv(header: string[], rows: unknown[][]): string {
  const lines = rows.map(cells => cells.map(csvEscape).join(','));
  return [header.map(csvEscape).join(','), ...lines].join('\n');
}

/**
 * UTF-8 byte-order mark. Excel on Japanese Windows opens a plain UTF-8 CSV as
 * Shift-JIS and shows 勘定科目 names as mojibake; with the BOM it reads UTF-8.
 * Opted into per export (Phase 7 statements) — adding it everywhere would change
 * the first header cell of every existing export for tools that keep the BOM.
 */
export const CSV_BOM = '﻿';

export type CsvOptions = {
  /** Prefix the file with a UTF-8 BOM (for Excel + Japanese text). */
  bom?: boolean;
  /** Use `name` as the full file name (".csv" appended) instead of `<name>-YYYY-MM-DD.csv`. */
  exactName?: boolean;
};

/** The CSV text with the optional BOM — split out so a test can assert on it without a DOM. */
export function csvText(header: string[], rows: unknown[][], options: CsvOptions = {}): string {
  return (options.bom ? CSV_BOM : '') + toCsv(header, rows);
}

/**
 * Hand the browser a CSV file named `<name>-YYYY-MM-DD.csv` (or `<name>.csv`
 * with `exactName`, for exports whose name already carries the period).
 *
 * The object URL is revoked after the click — without it every export leaks a
 * blob for the life of the tab.
 */
export function downloadCsv(name: string, header: string[], rows: unknown[][], options: CsvOptions = {}): void {
  const blob = new Blob([csvText(header, rows, options)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = options.exactName ? `${name}.csv` : `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
