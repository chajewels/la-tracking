import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ledgerTable } from '@/lib/page365-stock-table';
import { CHIP_CLASS, ledgerChip, type Page365StockLine } from '@/lib/page365-stock';

/**
 * What a Page365 import did to website stock, line by line, on the order page:
 * Stock taken / Flagged / Stock returned / Service — skipped. Read from the
 * page365_stock_lines ledger (migration 20260926120000_page365_stock_sync).
 *
 * Renders nothing for an order with no ledger rows — every hand-typed order,
 * every Page365 order imported before stock sync, and every order while the
 * migration has not been run.
 */
export default function Page365StockPanel({ kind, orderId }: { kind: 'cash' | 'layaway'; orderId: string | undefined }) {
  const { data: lines } = useQuery({
    queryKey: ['page365-stock-lines', kind, orderId],
    enabled: !!orderId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await ledgerTable()
        .select('id, page365_no, line_no, cash_order_id, account_id, line_name, first_word, quantity, match_result, stock_state, flag, stock_seen, held_at, released_at, resolved_at, resolution_note, created_at')
        .eq(kind === 'cash' ? 'cash_order_id' : 'account_id', orderId!)
        .order('line_no', { ascending: true });
      // A missing table (SQL not run yet) is not this page's problem.
      if (error) return [] as Page365StockLine[];
      return (data ?? []) as unknown as Page365StockLine[];
    },
  });

  if (!lines || lines.length === 0) return null;
  const open = lines.filter((l) => l.flag && !l.resolved_at).length;

  return (
    <div className="rounded-xl border border-border bg-card p-5" data-testid="page365-stock-panel">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-card-foreground">Website stock (Page365 {lines[0].page365_no})</h3>
        {open > 0 && (
          <Link to="/website?tab=page365-stock" className="text-xs text-primary hover:underline">
            {open} flagged — open Page365 stock
          </Link>
        )}
      </div>
      <div className="space-y-2">
        {lines.map((l) => {
          const chip = ledgerChip(l);
          return (
            <div key={l.id} className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-card-foreground" title={l.line_name}>{l.line_name}</div>
                <div className="text-[11px] text-muted-foreground tabular-nums">
                  Line {l.line_no} · qty {l.quantity}{l.first_word ? ` · code ${l.first_word}` : ''}
                </div>
              </div>
              <span className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${CHIP_CLASS[chip.tone]}`}>
                {chip.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
