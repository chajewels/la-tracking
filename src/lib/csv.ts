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
 */
export function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
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
 * Hand the browser a CSV file named `<name>-YYYY-MM-DD.csv`.
 *
 * The object URL is revoked after the click — without it every export leaks a
 * blob for the life of the tab.
 */
export function downloadCsv(name: string, header: string[], rows: unknown[][]): void {
  const blob = new Blob([toCsv(header, rows)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
