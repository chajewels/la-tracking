import { useState, useMemo } from 'react';
import { Shield, Activity, Gavel, AlertTriangle, CheckCircle, XCircle, Clock, RefreshCw, Loader2, DollarSign, Search, Filter, ShieldCheck } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { daysOverdueFromToday, isEffectivelyPaid, getNextUnpaidDueDate } from '@/lib/business-rules';
import { Link } from 'react-router-dom';
import PenaltyCapAuditPanel from '@/components/dashboard/PenaltyCapAuditPanel';

// ── System Health ──
function SystemHealthTab() {
  const [running, setRunning] = useState(false);
  const { data: health, isLoading, refetch } = useQuery({
    queryKey: ['admin-system-health'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('system-health-check');
      if (error) throw error;
      return data as { overall: string; checks: Record<string, { status: string; detail?: string }>; issues: string[]; timestamp: string };
    },
  });

  const runCheck = async () => {
    setRunning(true);
    await refetch();
    setRunning(false);
    toast.success('Health check completed');
  };

  if (isLoading) return <div className="space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>;

  const checks = health?.checks || {};
  const statusColor = (s: string) => s === 'pass' ? 'text-success' : s === 'fail' ? 'text-destructive' : s === 'error' ? 'text-destructive' : 'text-muted-foreground';
  const statusBg = (s: string) => s === 'pass' ? 'bg-success/10' : s === 'fail' ? 'bg-destructive/10' : 'bg-muted/30';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={health?.overall === 'HEALTHY' ? 'bg-success/10 text-success border-success/20' : 'bg-destructive/10 text-destructive border-destructive/20'}>
            {health?.overall === 'HEALTHY' ? <CheckCircle className="h-3 w-3 mr-1" /> : <XCircle className="h-3 w-3 mr-1" />}
            {health?.overall || 'Unknown'}
          </Badge>
          {health?.timestamp && <span className="text-[10px] text-muted-foreground">Last: {new Date(health.timestamp).toLocaleString()}</span>}
        </div>
        <Button variant="outline" size="sm" onClick={runCheck} disabled={running}>
          {running ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
          Run Check
        </Button>
      </div>

      {(health?.issues || []).length > 0 && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 space-y-1">
          <p className="text-xs font-semibold text-destructive">Issues Found</p>
          {health!.issues.map((issue, i) => <p key={i} className="text-xs text-destructive/80">• {issue}</p>)}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {Object.entries(checks).map(([key, check]) => (
          <div key={key} className={`rounded-lg border border-border p-4 ${statusBg(check.status)}`}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-card-foreground capitalize">{key.replace(/_/g, ' ')}</span>
              <Badge variant="outline" className={`text-[10px] ${statusColor(check.status)}`}>{check.status.toUpperCase()}</Badge>
            </div>
            <p className="text-[11px] text-muted-foreground">{check.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Penalty Audit ──
function PenaltyAuditTab() {
  const { data: penalties, isLoading } = useQuery({
    queryKey: ['admin-penalty-audit'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('penalty_fees')
        .select('*, layaway_accounts(invoice_number, currency, customers(full_name)), layaway_schedule(installment_number, due_date)')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
  });

  const penaltyIds = (penalties || []).map(p => p.id);
  const { data: linkedWaivers } = useQuery({
    queryKey: ['admin-penalty-waivers', penaltyIds.slice(0, 20).join(',')],
    enabled: penaltyIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('penalty_waiver_requests')
        .select('penalty_fee_id, id, status')
        .in('penalty_fee_id', penaltyIds.slice(0, 100));
      if (error) throw error;
      return data;
    },
  });

  const waiverMap = new Map((linkedWaivers || []).map(w => [w.penalty_fee_id, w]));

  if (isLoading) return <div className="space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>;

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Invoice</th>
              <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Customer</th>
              <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Inst#</th>
              <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Due Date</th>
              <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Stage</th>
              <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Cycle</th>
              <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Amount</th>
              <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Status</th>
              <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Waiver</th>
              <th className="text-left px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Applied</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {(penalties || []).map((p: any) => {
              const acc = p.layaway_accounts;
              const sched = p.layaway_schedule;
              const currency = (acc?.currency || 'PHP') as Currency;
              const waiver = waiverMap.get(p.id);
              return (
                <tr key={p.id} className="hover:bg-muted/10">
                  <td className="px-3 py-2">
                    <Link to={`/accounts/${p.account_id}`} className="font-mono text-xs font-semibold text-primary hover:underline">
                      #{acc?.invoice_number}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs text-card-foreground">{acc?.customers?.full_name || '—'}</td>
                  <td className="px-3 py-2 text-xs text-card-foreground">{sched?.installment_number || '—'}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{sched?.due_date ? new Date(sched.due_date + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '—'}</td>
                  <td className="px-3 py-2 text-xs text-card-foreground">{p.penalty_stage}</td>
                  <td className="px-3 py-2 text-xs text-card-foreground">{p.penalty_cycle}</td>
                  <td className="px-3 py-2 text-xs font-semibold text-destructive tabular-nums">{formatCurrency(Number(p.penalty_amount), currency)}</td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className={`text-[10px] ${p.status === 'waived' ? 'bg-muted text-muted-foreground' : p.status === 'paid' ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'}`}>
                      {p.status}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {waiver ? (
                      <Badge variant="outline" className={`text-[10px] ${waiver.status === 'approved' ? 'bg-success/10 text-success' : waiver.status === 'rejected' ? 'bg-destructive/10 text-destructive' : 'bg-warning/10 text-warning'}`}>
                        {waiver.status}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-[10px] text-muted-foreground whitespace-nowrap">
                    {new Date(p.penalty_date + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Overdue Debug ──
function OverdueDebugTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin-overdue-debug'],
    queryFn: async () => {
      const { data: accounts, error } = await supabase
        .from('layaway_accounts')
        .select('*, customers(full_name), layaway_schedule(*), penalty_fees(*)')
        .eq('status', 'overdue')
        .order('updated_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return accounts;
    },
  });

  if (isLoading) return <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}</div>;

  const accounts = data || [];

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{accounts.length} overdue account(s)</p>
      {accounts.map((acc: any) => {
        const schedules = (acc.layaway_schedule || []).filter((s: any) => s.status !== 'cancelled');
        const penalties = acc.penalty_fees || [];
        const nextDue = getNextUnpaidDueDate(schedules);
        const overdueDays = nextDue ? daysOverdueFromToday(nextDue) : 0;
        const unpaidPenalties = penalties.filter((p: any) => p.status === 'unpaid');
        const waivedPenalties = penalties.filter((p: any) => p.status === 'waived');
        const currency = acc.currency as Currency;

        return (
          <div key={acc.id} className="rounded-xl border border-destructive/20 bg-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <Link to={`/accounts/${acc.id}`} className="font-mono font-semibold text-primary hover:underline">
                  #{acc.invoice_number}
                </Link>
                <span className="text-sm text-card-foreground ml-2">{acc.customers?.full_name}</span>
              </div>
              <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20 text-[10px]">
                {overdueDays > 0 ? `${overdueDays} days overdue` : 'Overdue'}
              </Badge>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div className="rounded-lg bg-muted/30 p-2">
                <p className="text-muted-foreground">Next Due</p>
                <p className="font-semibold text-card-foreground">{nextDue ? new Date(nextDue + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Fully paid'}</p>
              </div>
              <div className="rounded-lg bg-muted/30 p-2">
                <p className="text-muted-foreground">Remaining</p>
                <p className="font-semibold text-card-foreground">{formatCurrency(Number(acc.remaining_balance), currency)}</p>
              </div>
              <div className="rounded-lg bg-muted/30 p-2">
                <p className="text-muted-foreground">Active Penalties</p>
                <p className="font-semibold text-destructive">{unpaidPenalties.length} ({formatCurrency(unpaidPenalties.reduce((s: number, p: any) => s + Number(p.penalty_amount), 0), currency)})</p>
              </div>
              <div className="rounded-lg bg-muted/30 p-2">
                <p className="text-muted-foreground">Waived</p>
                <p className="font-semibold text-muted-foreground">{waivedPenalties.length}</p>
              </div>
            </div>

            <div className="text-[10px] text-muted-foreground space-y-0.5">
              {schedules.slice(0, 8).map((s: any) => {
                const paid = isEffectivelyPaid(s);
                return (
                  <div key={s.id} className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${paid ? 'bg-success' : s.due_date < new Date().toISOString().split('T')[0] ? 'bg-destructive' : 'bg-muted-foreground'}`} />
                    <span>Inst #{s.installment_number}</span>
                    <span>{new Date(s.due_date + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                    <span>{formatCurrency(Number(s.total_due_amount), currency)}</span>
                    <span className={paid ? 'text-success' : 'text-destructive'}>{paid ? 'Paid' : s.status}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Waiver Audit Log ──
function WaiverAuditTab() {
  const { data: auditLogs, isLoading } = useQuery({
    queryKey: ['admin-waiver-audit-logs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('*')
        .in('action', ['waiver_approved', 'waiver_rejected', 'batch_waiver_approved', 'batch_waiver_rejected'])
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data;
    },
  });

  if (isLoading) return <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>;

  return (
    <div className="space-y-3">
      {(auditLogs || []).length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">No waiver audit entries yet</p>
        </div>
      ) : (
        (auditLogs || []).map((log: any) => {
          const details = log.new_value_json || {};
          const isApproval = log.action.includes('approved');
          const isBatch = log.action.startsWith('batch_');
          const penaltiesWaived = details.penalties_waived || [];
          return (
            <div key={log.id} className={`rounded-lg border p-4 space-y-2 ${isApproval ? 'border-success/20 bg-success/5' : 'border-destructive/20 bg-destructive/5'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {isApproval ? <CheckCircle className="h-3.5 w-3.5 text-success" /> : <XCircle className="h-3.5 w-3.5 text-destructive" />}
                  <span className="text-xs font-semibold text-card-foreground">
                    {isBatch ? `Batch ${isApproval ? 'Approval' : 'Rejection'}` : isApproval ? 'Approved' : 'Rejected'}
                  </span>
                  {isBatch && <Badge variant="outline" className="text-[10px]">{details.waiver_ids?.length || details.count || 1} penalties</Badge>}
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(log.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              {penaltiesWaived.length > 0 && (
                <div className="text-[10px] text-muted-foreground space-y-0.5">
                  {penaltiesWaived.map((p: any, i: number) => (
                    <span key={i} className="inline-block mr-2 px-1.5 py-0.5 rounded bg-muted">
                      {p.stage} C{p.cycle}: {typeof p.amount === 'number' ? `₱${p.amount.toLocaleString()}` : p.amount}
                    </span>
                  ))}
                </div>
              )}
              {details.total_waived && (
                <p className="text-xs text-card-foreground">Total waived: <span className="font-semibold text-success">₱{Number(details.total_waived).toLocaleString()}</span></p>
              )}
              {details.notes && <p className="text-[10px] text-muted-foreground italic">"{details.notes}"</p>}
            </div>
          );
        })
      )}
    </div>
  );
}

// ── Finance Reconciliation ──
interface ReconcException {
  account_id: string;
  invoice_number: string;
  customer_name: string;
  currency: string;
  type: string;
  detail: string;
  expected?: number;
  actual?: number;
  difference?: number;
}

interface ReconcData {
  summary: {
    total_accounts: number;
    clean_accounts: number;
    exception_accounts: number;
    total_exceptions: number;
    penalty_exceptions: number;
    waiver_exceptions: number;
    balance_exceptions: number;
    payment_exceptions: number;
    reference_invoices: Record<string, string>;
    timestamp: string;
  };
  exceptions: ReconcException[];
}

function ReconciliationTab() {
  const [running, setRunning] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery<ReconcData>({
    queryKey: ['admin-reconciliation'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('finance-reconciliation');
      if (error) throw error;
      return data as ReconcData;
    },
  });

  const runReconciliation = async () => {
    setRunning(true);
    await refetch();
    setRunning(false);
    toast.success('Reconciliation completed');
  };

  const filteredExceptions = useMemo(() => {
    if (!data?.exceptions) return [];
    return data.exceptions.filter(e => {
      if (typeFilter !== 'all' && e.type !== typeFilter) return false;
      if (searchTerm) {
        const q = searchTerm.toLowerCase();
        return e.invoice_number.toLowerCase().includes(q) || e.customer_name.toLowerCase().includes(q);
      }
      return true;
    });
  }, [data?.exceptions, searchTerm, typeFilter]);

  const exceptionTypes = useMemo(() => {
    if (!data?.exceptions) return [];
    return [...new Set(data.exceptions.map(e => e.type))];
  }, [data?.exceptions]);

  if (isLoading) return <div className="space-y-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>;

  const s = data?.summary;
  const typeColors: Record<string, string> = {
    balance_mismatch: 'bg-destructive/10 text-destructive border-destructive/20',
    negative_balance: 'bg-destructive/10 text-destructive border-destructive/20',
    overcap_penalty: 'bg-warning/10 text-warning border-warning/20',
    chronology_break: 'bg-destructive/10 text-destructive border-destructive/20',
    legacy_year: 'bg-muted text-muted-foreground border-border',
    paid_marked_unpaid: 'bg-warning/10 text-warning border-warning/20',
  };

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          {s && (
            <Badge variant="outline" className={s.exception_accounts === 0 ? 'bg-success/10 text-success border-success/20' : 'bg-warning/10 text-warning border-warning/20'}>
              {s.exception_accounts === 0 ? <CheckCircle className="h-3 w-3 mr-1" /> : <AlertTriangle className="h-3 w-3 mr-1" />}
              {s.exception_accounts === 0 ? 'ALL CLEAR' : `${s.exception_accounts} exceptions`}
            </Badge>
          )}
          {s?.timestamp && <span className="text-[10px] text-muted-foreground">Run: {new Date(s.timestamp).toLocaleString()}</span>}
        </div>
        <Button variant="outline" size="sm" onClick={runReconciliation} disabled={running}>
          {running ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
          Run Reconciliation
        </Button>
      </div>

      {/* Summary Cards */}
      {s && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Accounts Checked</p>
            <p className="text-lg font-bold text-card-foreground tabular-nums">{s.total_accounts}</p>
          </div>
          <div className="rounded-lg border border-success/20 bg-success/5 p-3">
            <p className="text-[10px] text-success uppercase tracking-wider">Clean</p>
            <p className="text-lg font-bold text-success tabular-nums">{s.clean_accounts}</p>
          </div>
          <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3">
            <p className="text-[10px] text-destructive uppercase tracking-wider">Exceptions</p>
            <p className="text-lg font-bold text-destructive tabular-nums">{s.exception_accounts}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Balance Issues</p>
            <p className="text-lg font-bold text-card-foreground tabular-nums">{s.balance_exceptions}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Penalty Issues</p>
            <p className="text-lg font-bold text-card-foreground tabular-nums">{s.penalty_exceptions}</p>
          </div>
        </div>
      )}

      {/* Reference Invoice Status */}
      {s?.reference_invoices && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-semibold text-card-foreground mb-2">Reference Invoice Validation</p>
          <div className="flex gap-3 flex-wrap">
            {Object.entries(s.reference_invoices).map(([inv, status]) => (
              <div key={inv} className="flex items-center gap-1.5">
                {status === 'CLEAN' ? <CheckCircle className="h-3.5 w-3.5 text-success" /> : status === 'EXCEPTION' ? <XCircle className="h-3.5 w-3.5 text-destructive" /> : <Clock className="h-3.5 w-3.5 text-muted-foreground" />}
                <span className="text-xs font-mono font-semibold text-card-foreground">#{inv}</span>
                <Badge variant="outline" className={`text-[10px] ${status === 'CLEAN' ? 'bg-success/10 text-success' : status === 'EXCEPTION' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`}>
                  {status}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      {(data?.exceptions || []).length > 0 && (
        <>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-xs">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search invoice or customer..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-8 h-8 text-xs"
              />
            </div>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-[180px] h-8 text-xs">
                <Filter className="h-3 w-3 mr-1.5" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {exceptionTypes.map(t => (
                  <SelectItem key={t} value={t}>{t.replace(/_/g, ' ')}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[10px] text-muted-foreground">{filteredExceptions.length} exception(s)</span>
          </div>

          {/* Exception List */}
          <div className="space-y-2">
            {filteredExceptions.slice(0, 50).map((ex, idx) => (
              <div
                key={`${ex.account_id}-${ex.type}-${idx}`}
                className="rounded-lg border border-border bg-card p-3 cursor-pointer hover:border-primary/30 transition-colors"
                onClick={() => setExpandedId(expandedId === `${ex.account_id}-${idx}` ? null : `${ex.account_id}-${idx}`)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/accounts/${ex.account_id}`}
                      className="font-mono text-xs font-semibold text-primary hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      #{ex.invoice_number}
                    </Link>
                    <span className="text-xs text-card-foreground">{ex.customer_name}</span>
                  </div>
                  <Badge variant="outline" className={`text-[10px] ${typeColors[ex.type] || 'bg-muted text-muted-foreground border-border'}`}>
                    {ex.type.replace(/_/g, ' ')}
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">{ex.detail}</p>

                {expandedId === `${ex.account_id}-${idx}` && ex.expected !== undefined && (
                  <div className="mt-2 pt-2 border-t border-border grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <p className="text-muted-foreground">Expected</p>
                      <p className="font-semibold text-card-foreground tabular-nums">
                        {formatCurrency(ex.expected, ex.currency as Currency)}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Stored</p>
                      <p className="font-semibold text-card-foreground tabular-nums">
                        {formatCurrency(ex.actual ?? 0, ex.currency as Currency)}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Difference</p>
                      <p className={`font-semibold tabular-nums ${(ex.difference ?? 0) !== 0 ? 'text-destructive' : 'text-success'}`}>
                        {formatCurrency(ex.difference ?? 0, ex.currency as Currency)}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {(data?.exceptions || []).length === 0 && s && (
        <div className="rounded-xl border border-success/20 bg-success/5 p-8 text-center">
          <CheckCircle className="h-8 w-8 text-success mx-auto mb-2" />
          <p className="text-sm font-semibold text-success">All {s.total_accounts} accounts pass reconciliation</p>
          <p className="text-xs text-muted-foreground mt-1">No balance mismatches, over-cap penalties, or chronology issues found</p>
        </div>
      )}
    </div>
  );
}

// ── Main Page ──
export default function AdminAudit() {
  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div>
          <p className="text-xs font-semibold text-primary uppercase tracking-widest mb-1">Admin</p>
          <h1 className="text-2xl font-bold text-foreground font-display">Audit & Monitoring</h1>
          <p className="text-sm text-muted-foreground mt-1">System health, finance reconciliation, penalty audit, overdue diagnostics, and waiver history</p>
        </div>

        <Tabs defaultValue="reconciliation" className="space-y-4">
          <TabsList className="bg-muted/50 flex-wrap">
            <TabsTrigger value="reconciliation" className="gap-1.5"><DollarSign className="h-3.5 w-3.5" /> Reconciliation</TabsTrigger>
            <TabsTrigger value="penalty-cap" className="gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> Penalty Cap Audit</TabsTrigger>
            <TabsTrigger value="health" className="gap-1.5"><Activity className="h-3.5 w-3.5" /> System Health</TabsTrigger>
            <TabsTrigger value="penalties" className="gap-1.5"><Gavel className="h-3.5 w-3.5" /> Penalty Audit</TabsTrigger>
            <TabsTrigger value="overdue" className="gap-1.5"><AlertTriangle className="h-3.5 w-3.5" /> Overdue Debug</TabsTrigger>
            <TabsTrigger value="waivers" className="gap-1.5"><Shield className="h-3.5 w-3.5" /> Waiver History</TabsTrigger>
          </TabsList>

          <TabsContent value="reconciliation"><ReconciliationTab /></TabsContent>
          <TabsContent value="penalty-cap"><PenaltyCapAuditPanel /></TabsContent>
          <TabsContent value="health"><SystemHealthTab /></TabsContent>
          <TabsContent value="penalties"><PenaltyAuditTab /></TabsContent>
          <TabsContent value="overdue"><OverdueDebugTab /></TabsContent>
          <TabsContent value="waivers"><WaiverAuditTab /></TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
