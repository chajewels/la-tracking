import { memo, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Wallet } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';

type LotStatus = 'active' | 'consumed' | 'expired' | 'voided';
type SourceType = 'cancelled_layaway' | 'cancelled_cash' | 'manual_admin' | string;
type TxnType = 'issued' | 'redeemed' | 'expired' | 'voided' | 'adjusted' | string;

interface LotRow {
  id: string;
  customer_id: string;
  currency: Currency;
  original_amount: number;
  remaining_amount: number;
  status: LotStatus;
  source_type: SourceType;
  source_account_id: string | null;
  source_cash_order_id: string | null;
  notes: string | null;
  issued_at: string;
  expires_at: string | null;
  created_at: string;
}

interface TxnRow {
  id: string;
  customer_id: string;
  lot_id: string | null;
  txn_type: TxnType;
  amount: number;
  currency: Currency;
  account_id: string | null;
  cash_order_id: string | null;
  balance_after: number | null;
  notes: string | null;
  created_at: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function humanizeSource(s: SourceType) {
  switch (s) {
    case 'cancelled_layaway': return 'Cancelled Layaway';
    case 'cancelled_cash': return 'Cancelled Cash Order';
    case 'manual_admin': return 'Manual (Admin)';
    default: return s;
  }
}

function humanizeTxnType(t: TxnType) {
  switch (t) {
    case 'issued': return 'Issued';
    case 'redeemed': return 'Redeemed';
    case 'expired': return 'Expired';
    case 'voided': return 'Voided';
    case 'adjusted': return 'Adjusted';
    default: return t;
  }
}

const LOT_STATUS_STYLES: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  consumed: 'bg-muted text-muted-foreground border-border',
  expired: 'bg-muted text-muted-foreground border-border',
  voided: 'bg-muted text-muted-foreground border-border',
};

// A negative-direction transaction reduces available credit.
const NEGATIVE_TXN = new Set(['redeemed', 'expired', 'voided']);

function useStoreCreditLots(customerId: string | undefined) {
  return useQuery({
    queryKey: ['store-credit-lots', customerId],
    enabled: !!customerId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('store_credit_lots')
        .select('*')
        .eq('customer_id', customerId!)
        .order('expires_at', { ascending: true });
      if (error) throw error;
      return ((data || []) as unknown as LotRow[]);
    },
  });
}

function useStoreCreditTxns(customerId: string | undefined) {
  return useQuery({
    queryKey: ['store-credit-txns', customerId],
    enabled: !!customerId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('store_credit_transactions')
        .select('*')
        .eq('customer_id', customerId!)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return ((data || []) as unknown as TxnRow[]);
    },
  });
}

export default memo(function CustomerStoreCreditTab({ customerId }: { customerId: string }) {
  const { data: lots, isLoading: lotsLoading, isError: lotsError } = useStoreCreditLots(customerId);
  const { data: txns, isLoading: txnsLoading, isError: txnsError } = useStoreCreditTxns(customerId);

  // Available balance per currency — active, non-expired lots only. JPY and PHP
  // are SEPARATE: never converted or summed together.
  const balancesByCurrency = useMemo(() => {
    const now = Date.now();
    const map = new Map<Currency, number>();
    for (const lot of lots || []) {
      if (lot.status !== 'active') continue;
      if (!lot.expires_at || new Date(lot.expires_at).getTime() <= now) continue;
      map.set(lot.currency, (map.get(lot.currency) || 0) + Number(lot.remaining_amount));
    }
    return Array.from(map.entries());
  }, [lots]);

  if (lotsLoading || txnsLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }

  if (lotsError || txnsError) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-center">
        <p className="text-sm text-muted-foreground">Could not load store credit.</p>
      </div>
    );
  }

  const hasLots = (lots?.length ?? 0) > 0;
  const hasTxns = (txns?.length ?? 0) > 0;

  if (!hasLots && !hasTxns) {
    return (
      <div className="rounded-xl border border-border bg-card p-10 text-center">
        <Wallet className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
        <p className="text-sm text-muted-foreground">No store credit for this customer.</p>
      </div>
    );
  }

  const now = Date.now();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg gold-gradient">
          <Wallet className="h-4 w-4 text-primary-foreground" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-foreground font-display">Store Credit</h3>
          <p className="text-xs text-muted-foreground">Read-only overview</p>
        </div>
      </div>

      {/* Balance summary — one card per currency (never combined) */}
      {balancesByCurrency.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {balancesByCurrency.map(([currency, amount]) => (
            <div key={currency} className="rounded-xl border border-border bg-card p-5">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                Available Balance ({currency})
              </p>
              <p className="mt-1 text-2xl font-bold text-foreground font-display tabular-nums">
                {formatCurrency(amount, currency)}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Credit Lots */}
      {hasLots && (
        <div className="space-y-2">
          <p className="text-sm font-semibold text-foreground">Credit Lots</p>
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Issued</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Remaining</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(lots || []).map((lot) => {
                  const currency = lot.currency as Currency;
                  const expTime = lot.expires_at ? new Date(lot.expires_at).getTime() : null;
                  const isActive = lot.status === 'active';
                  const expiringSoon = isActive && expTime != null && expTime > now && (expTime - now) <= THIRTY_DAYS_MS;
                  const muted = lot.status !== 'active';
                  return (
                    <TableRow
                      key={lot.id}
                      className={`${expiringSoon ? 'bg-amber-500/5' : ''} ${muted ? 'opacity-60' : ''}`}
                    >
                      <TableCell className="text-xs">{fmtDate(lot.issued_at)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {formatCurrency(Number(lot.original_amount), currency)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums font-semibold">
                        {formatCurrency(Number(lot.remaining_amount), currency)}
                      </TableCell>
                      <TableCell className={`text-xs ${expiringSoon ? 'text-amber-600 font-medium' : ''}`}>
                        {fmtDate(lot.expires_at)}
                        {expiringSoon && <span className="ml-1 text-[10px]">(soon)</span>}
                      </TableCell>
                      <TableCell className="text-xs">{humanizeSource(lot.source_type)}</TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                            LOT_STATUS_STYLES[lot.status] ?? LOT_STATUS_STYLES.consumed
                          }`}
                        >
                          {lot.status}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* History */}
      {hasTxns && (
        <div className="space-y-2">
          <p className="text-sm font-semibold text-foreground">History</p>
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Balance After</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(txns || []).map((tx) => {
                  const currency = tx.currency as Currency;
                  const negative = NEGATIVE_TXN.has(tx.txn_type);
                  const amt = formatCurrency(Number(tx.amount), currency);
                  return (
                    <TableRow key={tx.id}>
                      <TableCell className="text-xs">{fmtDate(tx.created_at)}</TableCell>
                      <TableCell className="text-xs">{humanizeTxnType(tx.txn_type)}</TableCell>
                      <TableCell
                        className={`text-right text-xs tabular-nums font-medium ${
                          negative ? 'text-destructive' : 'text-success'
                        }`}
                      >
                        {negative ? `−${amt}` : `+${amt}`}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                        {tx.balance_after != null ? formatCurrency(Number(tx.balance_after), currency) : '—'}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[220px] truncate">
                        {tx.notes || '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
});
