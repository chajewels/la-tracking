import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import AppLayout from '@/components/layout/AppLayout';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { usePermissions } from '@/contexts/PermissionsContext';
import {
  Search,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Vault,
} from 'lucide-react';
import { formatCurrency } from '@/lib/calculations';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

// ── Types ──────────────────────────────────────────────────────────────────

interface VaultCustomer {
  invoice_number: string;
  customer_name: string;
  payment_count: number;
  currency: string;
}

interface VaultEntry {
  id: string;
  payment_id: string | null;
  account_id: string | null;
  invoice_number: string;
  customer_name: string | null;
  amount: number;
  currency: string;
  payment_date: string;
  payment_method: string | null;
  submission_type: string | null;
  notes: string | null;
  status: string | null;
  event_type: string | null;
  voided_at: string | null;
  void_reason: string | null;
  backed_up_at: string | null;
}

interface RevalidateResult {
  vault_total: number;
  live_total: number;
  drift_amount: number;
  remaining_balance: number;
  vault_matches_live: boolean;
  remaining_balance_correct: boolean;
  has_voided_payments: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function monthLabel(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function typePill(type: string | null, isVoided: boolean) {
  if (isVoided) return <Badge variant="outline" className="text-xs text-muted-foreground border-muted-foreground/30">Voided</Badge>;
  const t = (type || '').toLowerCase();
  if (t.includes('down') || t === 'dp') return <Badge className="text-xs bg-blue-500/20 text-blue-400 border-blue-500/30 hover:bg-blue-500/20">Downpayment</Badge>;
  if (t.includes('penalty')) return <Badge className="text-xs bg-red-500/20 text-red-400 border-red-500/30 hover:bg-red-500/20">Penalty</Badge>;
  if (t.includes('install') || t === 'installment') return <Badge className="text-xs bg-emerald-500/20 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20">Installment</Badge>;
  return <Badge variant="outline" className="text-xs">{type || 'Payment'}</Badge>;
}

// ── Left panel: customer/invoice list ─────────────────────────────────────

function CustomerList({
  items,
  search,
  onSearch,
  selected,
  onSelect,
  loading,
}: {
  items: VaultCustomer[];
  search: string;
  onSearch: (v: string) => void;
  selected: string | null;
  onSelect: (inv: string) => void;
  loading: boolean;
}) {
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.customer_name.toLowerCase().includes(q) ||
        i.invoice_number.toLowerCase().includes(q)
    );
  }, [items, search]);

  return (
    <div className="flex h-full flex-col border-r border-border">
      <div className="p-3 border-b border-border">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search name or invoice…"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
      </div>
      <ScrollArea className="flex-1">
        {loading ? (
          <div className="space-y-1 p-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-md" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground text-center">No records found</p>
        ) : (
          <div className="p-2 space-y-0.5">
            {filtered.map((item) => (
              <button
                key={item.invoice_number}
                onClick={() => onSelect(item.invoice_number)}
                className={cn(
                  'w-full rounded-md px-3 py-2.5 text-left text-sm transition-colors',
                  selected === item.invoice_number
                    ? 'bg-primary/15 border border-primary/30 text-primary'
                    : 'hover:bg-muted/50 text-foreground'
                )}
              >
                <div className="font-medium truncate">{item.customer_name}</div>
                <div className="flex items-center justify-between mt-0.5">
                  <span className="text-xs text-muted-foreground">Inv #{item.invoice_number}</span>
                  <span className="text-xs text-muted-foreground">{item.payment_count} payments</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

// ── Revalidate result display ──────────────────────────────────────────────

function RevalidatePanel({ result }: { result: RevalidateResult }) {
  const currency = 'PHP'; // vault amounts are in stored currency; display as-is
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Vault total</span>
          <span className="font-mono font-medium">{formatCurrency(result.vault_total, currency)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Live total</span>
          <span className="font-mono font-medium">{formatCurrency(result.live_total, currency)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Drift</span>
          <span className={cn('font-mono font-medium', result.drift_amount !== 0 && 'text-destructive')}>
            {formatCurrency(result.drift_amount, currency)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Remaining balance</span>
          <span className="font-mono font-medium">{formatCurrency(result.remaining_balance, currency)}</span>
        </div>
      </div>
      <div className="border-t border-border pt-3 flex flex-wrap gap-4">
        <CheckItem label="Vault matches live" ok={result.vault_matches_live} />
        <CheckItem label="Balance correct" ok={result.remaining_balance_correct} />
        <WarningItem label="Has voided payments" warn={result.has_voided_payments} />
      </div>
    </div>
  );
}

function CheckItem({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-sm">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
      ) : (
        <XCircle className="h-4 w-4 text-destructive" />
      )}
      <span className={ok ? 'text-emerald-500' : 'text-destructive'}>{label}</span>
    </div>
  );
}

function WarningItem({ label, warn }: { label: string; warn: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-sm">
      {warn ? (
        <AlertTriangle className="h-4 w-4 text-amber-500" />
      ) : (
        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
      )}
      <span className={warn ? 'text-amber-500' : 'text-emerald-500'}>{label}</span>
    </div>
  );
}

// ── Right panel: vault detail for selected invoice ─────────────────────────

function VaultDetail({
  invoiceNumber,
  customerName,
  accountStatus,
  planType,
  currency,
  entries,
  loadingEntries,
}: {
  invoiceNumber: string;
  customerName: string;
  accountStatus: string | null;
  planType: string | null;
  currency: string;
  entries: VaultEntry[];
  loadingEntries: boolean;
}) {
  const [revalidating, setRevalidating] = useState(false);
  const [revalidateResult, setRevalidateResult] = useState<RevalidateResult | null>(null);

  const handleRevalidate = async () => {
    setRevalidating(true);
    setRevalidateResult(null);
    try {
      const { data, error } = await supabase.rpc(
        'revalidate_account_from_vault' as any,
        { invoice_number: invoiceNumber } as any
      );
      if (error) throw error;
      setRevalidateResult(data as unknown as RevalidateResult);
    } catch (err: any) {
      toast.error(err.message || 'Revalidation failed');
    } finally {
      setRevalidating(false);
    }
  };

  const activeEntries = entries.filter((e) => !e.voided_at);
  const voidedEntries = entries.filter((e) => !!e.voided_at);

  const vaultTotal = activeEntries.reduce((s, e) => s + Number(e.amount), 0);
  const liveTotal = revalidateResult?.live_total ?? null;
  const remainingBalance = revalidateResult?.remaining_balance ?? null;

  // Group entries by month (newest first)
  const grouped = useMemo(() => {
    const map = new Map<string, VaultEntry[]>();
    const sorted = [...entries].sort(
      (a, b) => new Date(b.payment_date).getTime() - new Date(a.payment_date).getTime()
    );
    for (const e of sorted) {
      const key = monthLabel(e.payment_date);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return map;
  }, [entries]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-start justify-between px-5 py-4 border-b border-border shrink-0">
        <div>
          <h2 className="text-base font-semibold text-foreground">{customerName}</h2>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="text-sm text-muted-foreground">Inv #{invoiceNumber}</span>
            {planType && (
              <Badge variant="outline" className="text-xs">{planType}</Badge>
            )}
            {accountStatus && (
              <Badge
                variant="outline"
                className={cn(
                  'text-xs',
                  accountStatus === 'completed' && 'border-emerald-500/40 text-emerald-400',
                  accountStatus === 'active' && 'border-blue-500/40 text-blue-400',
                  accountStatus === 'overdue' && 'border-amber-500/40 text-amber-400',
                  accountStatus === 'forfeited' && 'border-red-500/40 text-red-400',
                )}
              >
                {accountStatus}
              </Badge>
            )}
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={revalidating}
          onClick={handleRevalidate}
          className="shrink-0"
        >
          <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', revalidating && 'animate-spin')} />
          {revalidating ? 'Checking…' : 'Revalidate'}
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="px-5 py-4 space-y-5">
          {/* Revalidate result */}
          {revalidateResult && <RevalidatePanel result={revalidateResult} />}

          {/* Stat cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label="Vault Total Paid"
              value={formatCurrency(vaultTotal, currency)}
              sub="active payments"
            />
            <StatCard
              label="Live Total Paid"
              value={liveTotal !== null ? formatCurrency(liveTotal, currency) : '—'}
              sub="from DB"
              muted={liveTotal === null}
            />
            <StatCard
              label="Remaining Balance"
              value={remainingBalance !== null ? formatCurrency(remainingBalance, currency) : '—'}
              sub="after revalidate"
              muted={remainingBalance === null}
            />
            <StatCard
              label="Voided"
              value={String(voidedEntries.length)}
              sub={voidedEntries.length === 1 ? 'payment' : 'payments'}
              warn={voidedEntries.length > 0}
            />
          </div>

          {/* Payment list grouped by month */}
          {loadingEntries ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full rounded" />
              ))}
            </div>
          ) : entries.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No vault records found</p>
          ) : (
            Array.from(grouped.entries()).map(([month, rows]) => (
              <div key={month}>
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  {month}
                </div>
                <div className="rounded-lg border border-border overflow-hidden">
                  {rows.map((row, idx) => {
                    const isVoided = !!row.voided_at;
                    return (
                      <div
                        key={row.id}
                        className={cn(
                          'flex items-center gap-3 px-4 py-2.5 text-sm',
                          idx !== rows.length - 1 && 'border-b border-border',
                          isVoided && 'opacity-50'
                        )}
                      >
                        {/* Lock dot */}
                        <div
                          className={cn(
                            'h-2 w-2 rounded-full shrink-0',
                            isVoided ? 'bg-destructive' : 'bg-emerald-500'
                          )}
                        />
                        {/* Description */}
                        <span className={cn('flex-1 truncate text-foreground', isVoided && 'line-through text-muted-foreground')}>
                          {row.notes || `Payment ${idx + 1}`}
                        </span>
                        {/* Type pill */}
                        <div className="shrink-0">{typePill(row.submission_type, isVoided)}</div>
                        {/* Method */}
                        {row.payment_method && (
                          <span className="text-xs text-muted-foreground shrink-0 hidden sm:inline">
                            {row.payment_method}
                          </span>
                        )}
                        {/* Amount */}
                        <span
                          className={cn(
                            'font-mono text-sm font-medium shrink-0 tabular-nums',
                            isVoided ? 'line-through text-muted-foreground' : 'text-foreground'
                          )}
                        >
                          {formatCurrency(Number(row.amount), row.currency || currency)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  muted,
  warn,
}: {
  label: string;
  value: string;
  sub?: string;
  muted?: boolean;
  warn?: boolean;
}) {
  return (
    <Card className="bg-card border-border">
      <CardContent className="px-4 py-3">
        <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">{label}</p>
        <p className={cn('text-lg font-semibold tabular-nums', muted && 'text-muted-foreground', warn && 'text-amber-500')}>
          {value}
        </p>
        {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function PaymentVault() {
  const { can } = usePermissions();
  const [search, setSearch] = useState('');
  const [selectedInvoice, setSelectedInvoice] = useState<string | null>(null);

  // Fetch all vault entries to build customer list
  const { data: allEntries = [], isLoading: loadingAll } = useQuery({
    queryKey: ['payment-vault-all'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payment_history_backup' as any)
        .select('id, payment_id, account_id, invoice_number, customer_name, amount, currency, payment_date, payment_method, submission_type, notes, status, event_type, voided_at, void_reason, backed_up_at')
        .order('payment_date', { ascending: false });
      if (error) throw error;
      return (data || []) as any[];
    },
  });

  // Build customer list (one row per invoice_number, name from first row)
  const customerList: VaultCustomer[] = useMemo(() => {
    const map = new Map<string, VaultCustomer>();
    for (const e of allEntries) {
      const inv = e.invoice_number as string;
      if (!map.has(inv)) {
        map.set(inv, {
          invoice_number: inv,
          customer_name: e.customer_name || inv,
          payment_count: 0,
          currency: e.currency || 'PHP',
        });
      }
      map.get(inv)!.payment_count++;
    }
    return Array.from(map.values()).sort((a, b) => a.customer_name.localeCompare(b.customer_name));
  }, [allEntries]);

  // Entries for selected invoice
  const selectedEntries: VaultEntry[] = useMemo(() => {
    if (!selectedInvoice) return [];
    return allEntries.filter((e) => e.invoice_number === selectedInvoice);
  }, [allEntries, selectedInvoice]);

  const selectedCustomer = customerList.find((c) => c.invoice_number === selectedInvoice);

  if (!can('admin_settings')) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-64 text-muted-foreground">
          Access denied — admin only
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="flex flex-col h-[calc(100vh-4rem)]">
        {/* Page header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border shrink-0">
          <Vault className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-lg font-semibold text-foreground">Payment Vault</h1>
            <p className="text-xs text-muted-foreground">Historical payment backup records</p>
          </div>
          <Badge variant="outline" className="ml-auto text-xs">
            {customerList.length} accounts
          </Badge>
        </div>

        {/* Two-panel layout */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left — customer list */}
          <div className="w-72 shrink-0 overflow-hidden">
            <CustomerList
              items={customerList}
              search={search}
              onSearch={setSearch}
              selected={selectedInvoice}
              onSelect={setSelectedInvoice}
              loading={loadingAll}
            />
          </div>

          {/* Right — detail */}
          <div className="flex-1 overflow-hidden">
            {!selectedInvoice ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
                <Vault className="h-10 w-10 opacity-20" />
                <p className="text-sm">Select an account to view vault records</p>
              </div>
            ) : (
              <VaultDetail
                invoiceNumber={selectedInvoice}
                customerName={selectedCustomer?.customer_name ?? selectedInvoice}
                accountStatus={null}
                planType={null}
                currency={selectedCustomer?.currency ?? 'PHP'}
                entries={selectedEntries}
                loadingEntries={loadingAll}
              />
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
