/**
 * Google Sheets text-cell guard (formula injection).
 *
 * The Sheets API with valueInputOption=USER_ENTERED parses a cell that starts
 * with = + - @ (and TAB / CR) as a formula, exactly like Excel does with a
 * CSV. Customers type their own names and notes on the website, so a name of
 * "=HYPERLINK(...)" would become a live formula in the loyalty sheet
 * (Lovable scan 2026-10-03, "Anyone can put formulas in loyalty records").
 *
 * Same rule as csvEscape in src/lib/csv.ts: a TEXT value starting with one of
 * those characters gets a leading apostrophe, which Sheets shows as plain text.
 * Numbers are never passed here — they stay raw JS numbers so Sheets keeps
 * them numeric (signedNumberOrBlank, the 2026-06-13 "+500" lesson). Formulas
 * the Hub writes on purpose (=SUM(...)) are built separately and never go
 * through this helper.
 */
export function sheetText(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}
