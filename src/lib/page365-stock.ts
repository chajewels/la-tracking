/**
 * Page365 stock — words and chip tones for the Hub screens.
 *
 * The rules are in SQL (migration 20260926120000_page365_stock_sync.sql) and
 * the edge helper (supabase/functions/_shared/page365-stock.ts). This file only
 * turns what they recorded into the chip a CSR reads. It decides nothing.
 *
 *   previewChip  Page365 review screen, BEFORE import: what WILL happen, from
 *                the stock_match stored on the draft at fetch time.
 *   ledgerChip   order pages and the Page365 stock tab, AFTER import: what DID
 *                happen, from page365_stock_lines.
 *
 * Two import behaviours (system_settings.page365_stock_mode, migration
 * 20260928100000_page365_inventory_pr2):
 *   inventory_sync  Page365 is the stock master. An import records and flags
 *                   each line but never changes website stock; the Page365
 *                   inventory fetch does. Live since PR 2.
 *   invoice         the #195 behaviour: an import takes stock. The rollback.
 * A product switched to "Don't sync with Page365" never has its stock moved by
 * an import in either mode.
 */

export type ChipTone = 'take' | 'flag' | 'skip' | 'returned' | 'record' | 'unknown';

export type Page365StockMode = 'inventory_sync' | 'invoice';

/** Twin of the SQL rule: only an explicit 'invoice' is the #195 behaviour;
 *  anything else — including a draft fetched before PR 2 — is inventory_sync,
 *  because the import reads the live mode, and PR 2's SQL ships first. */
export const stockModeFrom = (v: unknown): Page365StockMode => (v === 'invoice' ? 'invoice' : 'inventory_sync');

export interface Page365StockMatch {
  first_word: string | null;
  result: 'matched' | 'unmatched' | 'ambiguous_sku' | 'no_variant' | 'ambiguous_variant' | 'service';
  stock_qty: number | null;
  checked_at?: string;
  /** PR 2: the matched website variant. */
  variant_id?: string | null;
  /** PR 2: the matched product is switched to "Don't sync with Page365". */
  sync_disabled?: boolean | null;
}

export type Page365StockFlag =
  | 'unmatched' | 'ambiguous_sku' | 'no_variant' | 'ambiguous_variant'
  | 'insufficient_stock' | 'rehold_failed';

export interface Page365StockLine {
  id: string;
  page365_no: number;
  line_no: number;
  cash_order_id: string | null;
  account_id: string | null;
  line_name: string;
  first_word: string | null;
  quantity: number;
  match_result: string;
  /** page365_master / absorbed: PR 2 (see the header). */
  stock_state: 'none' | 'held' | 'released' | 'page365_master' | 'absorbed';
  flag: Page365StockFlag | null;
  stock_seen: number | null;
  held_at: string | null;
  released_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
}

/** Owner's four reasons, in the owner's words. */
export const FLAG_REASON: Record<Page365StockFlag, string> = {
  unmatched: 'No product code',
  ambiguous_sku: 'Several products',
  no_variant: 'Product has no variant',
  ambiguous_variant: 'Several sizes',
  insufficient_stock: 'Not enough stock',
  rehold_failed: 'Sold while the order was closed',
};

/** What staff should do about each flag. Stock never moves on resolve. */
export const FLAG_ADVICE: Record<Page365StockFlag, string> = {
  unmatched: 'The first word of the line is not a website product code. If it is a website piece, reduce its stock in Catalog by hand.',
  ambiguous_sku: 'More than one website product answers to this code. Fix the duplicate code in Catalog, then adjust stock by hand.',
  no_variant: 'The product has no variant, so it has no stock to reduce. Add the variant in Catalog if it is sold on the website.',
  ambiguous_variant: 'The product has several sizes or stones, and the Hub never guesses which one sold. Reduce the right variant in Catalog.',
  insufficient_stock: 'Already reserved or sold on the website. Adjust Page365’s own stock; the website reservation stands.',
  rehold_failed: 'The order was revived, but the piece sold on the website in the meantime. Sort it out on Page365.',
};

export function flagReason(flag: string | null | undefined): string {
  return flag && flag in FLAG_REASON ? FLAG_REASON[flag as Page365StockFlag] : 'Needs a look';
}

/** Review screen, before import. `kind` is the CSR's current Product/Service
 *  choice, which beats the stored preview (the CSR can move a line). `mode` is
 *  the draft's stock_mode (stockModeFrom). */
export function previewChip(
  match: Page365StockMatch | null | undefined,
  quantity: number,
  kind: 'product' | 'service',
  mode: Page365StockMode = 'inventory_sync',
): { tone: ChipTone; label: string } {
  if (kind === 'service') return { tone: 'skip', label: 'Service — skipped' };
  if (!match) return { tone: 'unknown', label: 'Stock not checked' };
  switch (match.result) {
    case 'service':
      // Page365's line reads as a resize/service fee. The server skips it even
      // if the CSR books it as a product here: stock follows the invoice.
      return { tone: 'skip', label: 'Service line — skipped' };
    case 'matched': {
      if (match.sync_disabled) {
        return { tone: 'skip', label: `Not synced with Page365 · ${match.first_word} — stock never changed` };
      }
      if (mode === 'inventory_sync') {
        return { tone: 'record', label: `Matched · ${match.first_word} — stock follows the Page365 inventory fetch` };
      }
      const have = match.stock_qty ?? 0;
      return have >= quantity
        ? { tone: 'take', label: `Will take stock · ${match.first_word} (${have} in stock)` }
        : { tone: 'flag', label: `Will flag · ${match.first_word} reserved or sold on website` };
    }
    case 'unmatched':
      return { tone: 'flag', label: 'Will flag · no product code' };
    case 'ambiguous_sku':
      return { tone: 'flag', label: `Will flag · several products for ${match.first_word}` };
    case 'no_variant':
      return { tone: 'flag', label: `Will flag · ${match.first_word} has no variant` };
    case 'ambiguous_variant':
      return { tone: 'flag', label: `Will flag · ${match.first_word} has several sizes` };
    default:
      return { tone: 'unknown', label: 'Stock not checked' };
  }
}

/** Order pages and the stock tab, after import. */
export function ledgerChip(line: Pick<Page365StockLine, 'match_result' | 'stock_state' | 'flag' | 'resolved_at'>): {
  tone: ChipTone; label: string;
} {
  if (line.flag && !line.resolved_at) return { tone: 'flag', label: `Flagged · ${flagReason(line.flag)}` };
  if (line.stock_state === 'held') return { tone: 'take', label: 'Stock taken' };
  if (line.stock_state === 'released') return { tone: 'returned', label: 'Stock returned' };
  if (line.stock_state === 'page365_master') return { tone: 'record', label: 'Matched — stock follows Page365' };
  if (line.stock_state === 'absorbed') return { tone: 'record', label: 'Stock taken — now in Page365’s count' };
  if (line.match_result === 'not_a_product') return { tone: 'skip', label: 'Service — skipped' };
  if (line.flag && line.resolved_at) return { tone: 'skip', label: `Resolved · ${flagReason(line.flag)}` };
  return { tone: 'unknown', label: 'No stock moved' };
}

/** Tailwind classes per tone, on the Hub's semantic tokens (Deco Ledger). */
export const CHIP_CLASS: Record<ChipTone, string> = {
  take: 'border-success/40 bg-success/10 text-success',
  flag: 'border-warning/40 bg-warning/10 text-warning',
  skip: 'border-border bg-muted text-muted-foreground',
  returned: 'border-info/40 bg-info/10 text-info',
  record: 'border-info/40 bg-info/5 text-info',
  unknown: 'border-border bg-background text-muted-foreground',
};

export interface ImportStockResult {
  held: number;
  flagged: number;
  /** PR 2 */
  mode?: Page365StockMode;
  recorded?: number;
  sync_off?: number;
}

const lines = (n: number) => `${n} line${n === 1 ? '' : 's'}`;

/** The one-line toast after an import. */
export function importSummary(r: ImportStockResult | null | undefined): string | null {
  if (!r) return null;
  const parts: string[] = [];
  if (r.held > 0) parts.push(`${lines(r.held)} took website stock`);
  if ((r.recorded ?? 0) > 0) parts.push(`${lines(r.recorded!)} matched — stock follows the Page365 inventory fetch`);
  if ((r.sync_off ?? 0) > 0) parts.push(`${lines(r.sync_off!)} not synced with Page365`);
  if (r.flagged > 0) parts.push(`${r.flagged} flagged for staff`);
  return parts.length ? parts.join(' · ') : null;
}

/** The warning toast title when lines were flagged, in the words of the mode. */
export const flaggedTitle = (mode: Page365StockMode | undefined) =>
  stockModeFrom(mode) === 'invoice' ? 'Some lines did not reduce website stock' : 'Some lines did not match one website product';
