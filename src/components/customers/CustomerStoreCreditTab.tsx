import { memo, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Wallet, Plus, Ban } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { usePermissions } from '@/contexts/PermissionsContext';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import IssueStoreCreditDialog from '@/components/customers/IssueStoreCreditDialog';

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

// Confirm + reason dialog for voiding a lot's UNSPENT remainder. Two-step,
// mirroring IssueStoreCreditDialog.
function VoidStoreCreditDialog({
  lot,
  open,
  onOpenChange,
  onVoided,
}: {
  lot: LotRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onVoided: () => void;
}) {
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const reasonTrim = reason.trim();
  const valid = reasonTrim.length >= 3;

  const close = () => {
    setReason('');
    setConfirming(false);
    setSubmitting(false);
    onOpenChange(false);
  };

  if (!lot) return null;

  const currency = lot.currency as Currency;
  const original = Number(lot.original_amount);
  const remaining = Number(lot.remaining_amount);
  const alreadyApplied = original - remaining;

  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('void-store-credit-lot', {
        body: { lot_id: lot.id, reason: reasonTrim },
      });
      if (error) {
        let msg = error.message || 'Failed to void store credit';
        try {
          if ('context' in error && (error as any).context?.body) {
            const b = await new Response((error as any).context.body).json();
            if (b?.error) msg = b.error;
          }
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      if ((data as any)?.error) throw new Error((data as any).error);
      const voided = Number((data as any)?.voided_amount ?? remaining);
      toast.success(`Voided ${formatCurrency(voided, currency)} of store credit`);
      onVoided();
      close();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to void store credit');
      setSubmitting(false);
      setConfirming(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-w-md border-border bg-card">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display text-card-foreground">
            <Ban className="h-5 w-5 text-destructive" />
            Void Store Credit
          </DialogTitle>
        </DialogHeader>

        {!confirming ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-background p-3 space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Original amount</span>
                <span className="tabular-nums text-card-foreground">{formatCurrency(original, currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Remaining (unspent)</span>
                <span className="tabular-nums text-card-foreground font-semibold">{formatCurrency(remaining, currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Expires</span>
                <span className="text-card-foreground">{fmtDate(lot.expires_at)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Source</span>
                <span className="text-card-foreground">{humanizeSource(lot.source_type)}</span>
              </div>
            </div>

            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-1">
              <p className="text-xs text-destructive">
                This will cancel the unspent {formatCurrency(remaining, currency)} of this lot.
              </p>
              {alreadyApplied > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  The {formatCurrency(alreadyApplied, currency)} already applied to orders will NOT be reversed.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="void-reason" className="text-xs">Reason (required)</Label>
              <Textarea
                id="void-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="Why is this store credit being voided? (audit-logged)"
                className="bg-background border-border resize-none text-sm"
              />
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={close}>Cancel</Button>
              <Button
                variant="destructive"
                disabled={!valid}
                onClick={() => setConfirming(true)}
              >
                Continue
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-card-foreground">
              You are about to void{' '}
              <span className="font-semibold">{formatCurrency(remaining, currency)}</span>{' '}
              of store credit. This cannot be undone.
            </p>
            <p className="text-xs text-muted-foreground">Reason: {reasonTrim}</p>
            <DialogFooter className="gap-2">
              <Button variant="outline" disabled={submitting} onClick={() => setConfirming(false)}>Back</Button>
              <Button variant="destructive" disabled={submitting} onClick={submit}>
                {submitting ? 'Voiding…' : 'Confirm Void'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default memo(function CustomerStoreCreditTab({ customerId }: { customerId: string }) {
  const { data: lots, isLoading: lotsLoading, isError: lotsError } = useStoreCreditLots(customerId);
  const { data: txns, isLoading: txnsLoading, isError: txnsError } = useStoreCreditTxns(customerId);
  const { can } = usePermissions();
  const qc = useQueryClient();
  const canIssue = can('issue_store_credit');
  const canVoid = can('void_store_credit');
  const [issueOpen, setIssueOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<LotRow | null>(null);

  const handleIssued = () => {
    qc.invalidateQueries({ queryKey: ['store-credit-lots', customerId] });
    qc.invalidateQueries({ queryKey: ['store-credit-txns', customerId] });
  };

  const handleVoided = () => {
    qc.invalidateQueries({ queryKey: ['store-credit-lots', customerId] });
    qc.invalidateQueries({ queryKey: ['store-credit-txns', customerId] });
  };

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

  const now = Date.now();

  // Header (title + admin-only Issue button) — rendered in BOTH the empty and
  // populated states so an admin can issue the first lot.
  const headerRow = (
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg gold-gradient">
          <Wallet className="h-4 w-4 text-primary-foreground" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-foreground font-display">Store Credit</h3>
          <p className="text-xs text-muted-foreground">Read-only overview</p>
        </div>
      </div>
      {canIssue && (
        <Button
          onClick={() => setIssueOpen(true)}
          className="gold-gradient text-primary-foreground font-medium shadow"
        >
          <Plus className="h-4 w-4 mr-1.5" /> Issue Store Credit
        </Button>
      )}
    </div>
  );

  const issueDialog = (
    <IssueStoreCreditDialog
      open={issueOpen}
      onOpenChange={setIssueOpen}
      customerId={customerId}
      onIssued={handleIssued}
    />
  );

  if (!hasLots && !hasTxns) {
    return (
      <div className="space-y-6">
        {headerRow}
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <Wallet className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
          <p className="text-sm text-muted-foreground">No store credit for this customer.</p>
        </div>
        {issueDialog}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {headerRow}

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
                  {canVoid && <TableHead className="text-right">Actions</TableHead>}
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
                      {canVoid && (
                        <TableCell className="text-right">
                          {lot.status === 'active' && Number(lot.remaining_amount) > 0 ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                              onClick={() => setVoidTarget(lot)}
                            >
                              <Ban className="h-3.5 w-3.5 mr-1" /> Void
                            </Button>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </TableCell>
                      )}
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

      {issueDialog}
      <VoidStoreCreditDialog
        key={voidTarget?.id ?? 'none'}
        lot={voidTarget}
        open={!!voidTarget}
        onOpenChange={(o) => { if (!o) setVoidTarget(null); }}
        onVoided={handleVoided}
      />
    </div>
  );
});
