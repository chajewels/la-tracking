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
import UnifiedSystemHealthTab from '@/components/admin/UnifiedSystemHealthTab';

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
    <div className="rounded-xl border border-zinc-700 bg-zinc-900 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-zinc-800">
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
                <tr key={p.id} className="hover:bg-zinc-800/60">
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
          <div key={acc.id} className="rounded-xl border border-destructive/20 bg-zinc-900 p-4 space-y-3">
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
              <div className="rounded-lg bg-zinc-800 p-2">
                <p className="text-muted-foreground">Next Due</p>
                <p className="font-semibold text-card-foreground">{nextDue ? new Date(nextDue + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Fully paid'}</p>
              </div>
              <div className="rounded-lg bg-zinc-800 p-2">
                <p className="text-muted-foreground">Remaining</p>
                <p className="font-semibold text-card-foreground">{formatCurrency(Number(acc.remaining_balance), currency)}</p>
              </div>
              <div className="rounded-lg bg-zinc-800 p-2">
                <p className="text-muted-foreground">Active Penalties</p>
                <p className="font-semibold text-destructive">{unpaidPenalties.length} ({formatCurrency(unpaidPenalties.reduce((s: number, p: any) => s + Number(p.penalty_amount), 0), currency)})</p>
              </div>
              <div className="rounded-lg bg-zinc-800 p-2">
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
  const { data: auditLogs, isLoading: logsLoading } = useQuery({
    queryKey: ['admin-waiver-audit-logs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('*')
        .in('action', ['waiver_approved', 'waiver_rejected', 'batch_waiver_approved', 'batch_waiver_rejected'])
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data || []) as any[];
    },
  });

  const accountIds = useMemo(
    () => [...new Set((auditLogs || []).map((l: any) => l.entity_id).filter(Boolean))] as string[],
    [auditLogs],
  );
  const userIds = useMemo(
    () => [...new Set((auditLogs || []).map((l: any) => l.performed_by_user_id).filter(Boolean))] as string[],
    [auditLogs],
  );
  const penaltyFeeIds = useMemo(() => {
    const ids: string[] = [];
    for (const log of (auditLogs || [])) {
      for (const p of (log.new_value_json?.penalties_waived || [])) {
        if (p.penalty_fee_id) ids.push(p.penalty_fee_id);
      }
    }
    return [...new Set(ids)];
  }, [auditLogs]);

  const { data: accounts } = useQuery({
    queryKey: ['waiver-audit-accounts', accountIds.join(',')],
    enabled: accountIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from('layaway_accounts')
        .select('id, invoice_number, customers(full_name)')
        .in('id', accountIds)
        .not('invoice_number', 'ilike', 'TEST-%');
      return (data || []) as any[];
    },
  });

  const { data: waiverProfiles } = useQuery({
    queryKey: ['waiver-audit-profiles', userIds.join(',')],
    enabled: userIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles')
        .select('user_id, full_name')
        .in('user_id', userIds);
      return (data || []) as any[];
    },
  });

  const { data: penaltyFees } = useQuery({
    queryKey: ['waiver-audit-penalty-fees', penaltyFeeIds.join(',')],
    enabled: penaltyFeeIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from('penalty_fees')
        .select('id, penalty_date, penalty_stage, penalty_cycle')
        .in('id', penaltyFeeIds);
      return (data || []) as any[];
    },
  });

  const accountMap  = useMemo(() => new Map((accounts      || []).map((a: any) => [a.id,       a])), [accounts]);
  const profileMap  = useMemo(() => new Map((waiverProfiles|| []).map((p: any) => [p.user_id,  p])), [waiverProfiles]);
  const penaltyMap  = useMemo(() => new Map((penaltyFees   || []).map((pf: any) => [pf.id,     pf])), [penaltyFees]);

  if (logsLoading) return <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}</div>;

  return (
    <div className="space-y-3">
      {(auditLogs || []).length === 0 ? (
        <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-8 text-center">
          <p className="text-sm text-zinc-400">No waiver audit entries yet</p>
        </div>
      ) : (
        (auditLogs || [])
          .filter((log: any) => accounts === undefined || accountMap.has(log.entity_id))
          .map((log: any) => {
          const details        = log.new_value_json || {};
          const isApproval     = log.action.includes('approved');
          const penaltiesWaived: any[] = details.penalties_waived || [];
          const account        = accountMap.get(log.entity_id);
          const approver       = profileMap.get(log.performed_by_user_id);
          const customerName   = (account as any)?.customers?.full_name;

          return (
            <div key={log.id} className={`rounded-lg border p-4 space-y-3 ${isApproval ? 'border-success/40 bg-zinc-900' : 'border-destructive/40 bg-zinc-900'}`}>

              {/* ── Header row ── */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {isApproval
                    ? <CheckCircle className="h-3.5 w-3.5 text-success" />
                    : <XCircle    className="h-3.5 w-3.5 text-destructive" />}
                  <span className="text-xs font-semibold text-card-foreground">
                    {isApproval ? 'Approved' : 'Rejected'}
                  </span>
                  {penaltiesWaived.length > 1 && (
                    <Badge variant="outline" className="text-[10px]">{penaltiesWaived.length} penalties</Badge>
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(log.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>

              {/* ── Account + approver meta ── */}
              <div className="flex items-center gap-3 flex-wrap">
                {account ? (
                  <Link
                    to={`/accounts/${log.entity_id}`}
                    className="font-mono text-xs font-semibold text-primary hover:underline"
                  >
                    #{(account as any).invoice_number}
                  </Link>
                ) : log.entity_id ? (
                  <span className="font-mono text-xs text-muted-foreground">{log.entity_id.slice(0, 8)}…</span>
                ) : null}
                {customerName && (
                  <span className="text-xs text-card-foreground">{customerName}</span>
                )}
                {approver && (
                  <span className="text-[10px] text-zinc-500 ml-auto">
                    by {approver.full_name || approver.user_id?.slice(0, 8)}
                  </span>
                )}
              </div>

              {/* ── Per-penalty rows ── */}
              {penaltiesWaived.length > 0 && (
                <div className="space-y-1">
                  {penaltiesWaived.map((p: any, i: number) => {
                    const pf = penaltyMap.get(p.penalty_fee_id);
                    const stage = p.stage || pf?.penalty_stage || '—';
                    const cycle = p.cycle ?? pf?.penalty_cycle ?? '';
                    const date  = pf?.penalty_date;
                    return (
                      <div key={i} className="flex items-center gap-3 rounded bg-zinc-800/60 px-3 py-1.5 text-xs">
                        <Badge variant="outline" className="text-[10px] bg-zinc-700 border-zinc-600 text-zinc-300 shrink-0">
                          {stage}{cycle !== '' ? ` C${cycle}` : ''}
                        </Badge>
                        {date && (
                          <span className="text-zinc-400 tabular-nums">
                            {new Date(date + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                        )}
                        <span className="font-semibold text-destructive tabular-nums ml-auto">
                          ₱{Number(p.amount).toLocaleString()}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── Total + notes ── */}
              <div className="flex items-center gap-4 flex-wrap">
                {details.total_waived != null && (
                  <p className="text-xs text-card-foreground">
                    Total waived: <span className="font-semibold text-success">₱{Number(details.total_waived).toLocaleString()}</span>
                  </p>
                )}
                {details.notes && (
                  <p className="text-[10px] text-muted-foreground italic">"{details.notes}"</p>
                )}
              </div>
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
    closed_accounts_excluded?: number;
    reference_invoices: Record<string, string>;
    timestamp: string;
  };
  exceptions: ReconcException[];
}

type Severity = 'critical' | 'warning' | 'minor';

const ISSUE_META: Record<string, { severity: Severity; label: string; fixInstruction: string; recommendedAction: string; fixAction: string }> = {
  balance_mismatch: { severity: 'critical', label: 'BALANCE MISMATCH', fixInstruction: 'Stored remaining balance does not match computed balance. Recalculation required.', recommendedAction: 'Recalculate Totals', fixAction: 'recalculate' },
  negative_balance: { severity: 'critical', label: 'NEGATIVE BALANCE', fixInstruction: 'Remaining balance is negative. Recalculate from actual payments.', recommendedAction: 'Recalculate Totals', fixAction: 'recalculate' },
  overcap_penalty: { severity: 'warning', label: 'PENALTY OVER-CAP', fixInstruction: 'Penalty exceeds the allowed cap for this installment range. Review penalties.', recommendedAction: 'Review Penalties', fixAction: 'recalculate' },
  chronology_break: { severity: 'critical', label: 'CHRONOLOGY BREAK', fixInstruction: 'Installment due dates are out of order. Schedule sync required.', recommendedAction: 'Sync Schedule', fixAction: 'sync_schedule' },
  legacy_year: { severity: 'minor', label: 'LEGACY YEAR', fixInstruction: 'Payment date still has year 2024. Review payment record.', recommendedAction: 'Review Payments', fixAction: 'recalculate' },
  paid_marked_unpaid: { severity: 'warning', label: 'PAID MARKED UNPAID', fixInstruction: 'Installment is fully paid but status is not "paid". Sync schedule required.', recommendedAction: 'Sync Schedule', fixAction: 'sync_schedule' },
};

const SEVERITY_STYLES: Record<Severity, string> = {
  critical: 'bg-zinc-900 text-destructive border-destructive/40',
  warning: 'bg-zinc-900 text-warning border-warning/40',
  minor: 'bg-zinc-900 text-zinc-400 border-zinc-700',
};

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, minor: 2 };

function ReconciliationTab() {
  const [running, setRunning] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [fixingId, setFixingId] = useState<string | null>(null);
  const [bulkFixType, setBulkFixType] = useState<string | null>(null);
  const queryClient = useQueryClient();

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

  const runFix = async (action: string, accountId: string) => {
    setFixingId(accountId);
    try {
      const { data: result, error } = await supabase.functions.invoke('fix-account-status', {
        body: { action, account_id: accountId },
      });
      if (error) throw error;
      const changes = result?.changes || [];
      const realChanges = changes.filter((c: any) => c.from !== undefined);
      if (realChanges.length > 0) {
        toast.success(`Fixed: ${realChanges.map((c: any) => `${c.field}: ${c.from} → ${c.to}`).join(', ')}`);
      } else {
        toast.info('No changes needed — already correct');
      }
      await refetch();
      queryClient.invalidateQueries({ queryKey: ['admin-system-health'] });
      queryClient.invalidateQueries({ queryKey: ['admin-overdue-debug'] });
    } catch (err: any) {
      toast.error(err.message || 'Fix failed');
    } finally {
      setFixingId(null);
    }
  };

  const runBulkFix = async (issueType: string) => {
    if (!data?.exceptions) return;
    const targets = data.exceptions.filter(e => e.type === issueType);
    const action = ISSUE_META[issueType]?.fixAction || 'recalculate';
    const uniqueAccounts = [...new Map(targets.map(t => [t.account_id, t])).values()];
    setBulkFixType(issueType);
    let fixed = 0;
    for (const acc of uniqueAccounts) {
      try {
        await supabase.functions.invoke('fix-account-status', {
          body: { action, account_id: acc.account_id },
        });
        fixed++;
      } catch {}
    }
    toast.success(`Bulk fix complete: ${fixed}/${uniqueAccounts.length} accounts processed`);
    await refetch();
    queryClient.invalidateQueries({ queryKey: ['admin-system-health'] });
    queryClient.invalidateQueries({ queryKey: ['admin-overdue-debug'] });
    setBulkFixType(null);
  };

  const filteredExceptions = useMemo(() => {
    if (!data?.exceptions) return [];
    const sorted = [...data.exceptions].sort((a, b) => {
      const sa = SEVERITY_ORDER[ISSUE_META[a.type]?.severity || 'minor'];
      const sb = SEVERITY_ORDER[ISSUE_META[b.type]?.severity || 'minor'];
      return sa - sb;
    });
    return sorted.filter(e => {
      if (typeFilter !== 'all' && e.type !== typeFilter) return false;
      if (searchTerm) {
        const q = searchTerm.toLowerCase();
        return e.invoice_number.toLowerCase().includes(q) || e.customer_name.toLowerCase().includes(q);
      }
      return true;
    });
  }, [data?.exceptions, searchTerm, typeFilter]);

  const typeBreakdown = useMemo(() => {
    if (!data?.exceptions) return [];
    const counts: Record<string, number> = {};
    for (const e of data.exceptions) {
      counts[e.type] = (counts[e.type] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([type, count]) => ({ type, count, meta: ISSUE_META[type] }))
      .sort((a, b) => SEVERITY_ORDER[a.meta?.severity || 'minor'] - SEVERITY_ORDER[b.meta?.severity || 'minor']);
  }, [data?.exceptions]);

  const exceptionTypes = useMemo(() => {
    if (!data?.exceptions) return [];
    return [...new Set(data.exceptions.map(e => e.type))];
  }, [data?.exceptions]);

  if (isLoading) return <div className="space-y-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>;

  const s = data?.summary;

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          {s && (
            <Badge variant="outline" className={s.exception_accounts === 0 ? 'bg-success/10 text-success border-success/20' : 'bg-warning/10 text-warning border-warning/20'}>
              {s.exception_accounts === 0 ? <CheckCircle className="h-3 w-3 mr-1" /> : <AlertTriangle className="h-3 w-3 mr-1" />}
              {s.exception_accounts === 0 ? 'ALL CLEAR' : `${s.exception_accounts} exception accounts`}
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
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Active Accounts</p>
            <p className="text-lg font-bold text-card-foreground tabular-nums">{s.total_accounts}</p>
          </div>
          <div className="rounded-lg border border-success/40 bg-zinc-900 p-3">
            <p className="text-[10px] text-success uppercase tracking-wider">Clean</p>
            <p className="text-lg font-bold text-success tabular-nums">{s.clean_accounts}</p>
          </div>
          <div className="rounded-lg border border-destructive/40 bg-zinc-900 p-3">
            <p className="text-[10px] text-destructive uppercase tracking-wider">Exceptions</p>
            <p className="text-lg font-bold text-destructive tabular-nums">{s.exception_accounts}</p>
          </div>
          <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Balance Issues</p>
            <p className="text-lg font-bold text-card-foreground tabular-nums">{s.balance_exceptions}</p>
          </div>
          <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Penalty Issues</p>
            <p className="text-lg font-bold text-card-foreground tabular-nums">{s.penalty_exceptions}</p>
          </div>
          <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3">
            <p className="text-[10px] text-zinc-400 uppercase tracking-wider">Closed (Excluded)</p>
            <p className="text-lg font-bold text-zinc-400 tabular-nums">{s.closed_accounts_excluded ?? 0}</p>
          </div>
        </div>
      )}

      {/* Issue Type Breakdown with Bulk Actions */}
      {typeBreakdown.length > 0 && (
        <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-4 space-y-3">
          <p className="text-xs font-semibold text-card-foreground">Issue Breakdown</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {typeBreakdown.map(({ type, count, meta }) => (
              <div
                key={type}
                className={`rounded-lg border p-3 flex items-center justify-between cursor-pointer hover:ring-1 hover:ring-primary/30 transition-all ${typeFilter === type ? 'ring-2 ring-primary/40' : ''} ${SEVERITY_STYLES[meta?.severity || 'minor']}`}
                onClick={() => setTypeFilter(typeFilter === type ? 'all' : type)}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${meta?.severity === 'critical' ? 'bg-destructive' : meta?.severity === 'warning' ? 'bg-warning' : 'bg-muted-foreground'}`} />
                  <div>
                    <p className="text-xs font-semibold">{meta?.label || type.replace(/_/g, ' ').toUpperCase()}</p>
                    <p className="text-[10px] opacity-70">{count} issue{count !== 1 ? 's' : ''}</p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-[10px] px-2"
                  disabled={bulkFixType === type}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Fix all ${count} ${meta?.label || type} issues? This will ${meta?.recommendedAction?.toLowerCase() || 'recalculate'} for affected accounts.`)) {
                      runBulkFix(type);
                    }
                  }}
                >
                  {bulkFixType === type ? <Loader2 className="h-3 w-3 animate-spin" /> : <>Fix All ({count})</>}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reference Invoice Status */}
      {s?.reference_invoices && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4">
          <p className="text-xs font-semibold text-card-foreground mb-2">Reference Invoice Validation</p>
          <div className="flex gap-3 flex-wrap">
            {Object.entries(s.reference_invoices).map(([inv, status]) => (
              <div key={inv} className="flex items-center gap-1.5">
                {status === 'CLEAN' ? <CheckCircle className="h-3.5 w-3.5 text-success" /> : status === 'EXCEPTION' ? <XCircle className="h-3.5 w-3.5 text-destructive" /> : <Clock className="h-3.5 w-3.5 text-muted-foreground" />}
                <span className="text-xs font-mono font-semibold text-card-foreground">#{inv}</span>
                <Badge variant="outline" className={`text-[10px] ${status === 'CLEAN' ? 'bg-zinc-900 text-success border-success/30' : status === 'EXCEPTION' ? 'bg-zinc-900 text-destructive border-destructive/30' : 'bg-zinc-700 text-zinc-400'}`}>
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
                  <SelectItem key={t} value={t}>{ISSUE_META[t]?.label || t.replace(/_/g, ' ')}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-[10px] text-muted-foreground">{filteredExceptions.length} exception(s)</span>
          </div>

          {/* Exception Table */}
          <div className="rounded-xl border border-zinc-700 bg-zinc-900 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-zinc-800">
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Invoice</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Customer</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Severity</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Issue Type</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">What to Fix</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Expected</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Stored</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Diff</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredExceptions.slice(0, 100).map((ex, idx) => {
                    const meta = ISSUE_META[ex.type];
                    const severity = meta?.severity || 'minor';
                    const cur = ex.currency as Currency;
                    return (
                      <tr key={`${ex.account_id}-${ex.type}-${idx}`} className="hover:bg-zinc-800/60">
                        <td className="px-3 py-2">
                          <Link to={`/accounts/${ex.account_id}`} className="font-mono text-xs font-semibold text-primary hover:underline">
                            #{ex.invoice_number}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-xs text-card-foreground">{ex.customer_name}</td>
                        <td className="px-3 py-2">
                          <Badge variant="outline" className={`text-[10px] font-bold ${SEVERITY_STYLES[severity]}`}>
                            {severity === 'critical' ? '🔴' : severity === 'warning' ? '🟠' : '🟡'} {severity.toUpperCase()}
                          </Badge>
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant="outline" className={`text-[10px] ${SEVERITY_STYLES[severity]}`}>
                            {meta?.label || ex.type.replace(/_/g, ' ')}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-[10px] text-muted-foreground max-w-[220px]">
                          {meta?.fixInstruction || ex.detail}
                        </td>
                        <td className="px-3 py-2 text-xs font-semibold text-card-foreground tabular-nums">
                          {ex.expected !== undefined ? formatCurrency(ex.expected, cur) : '—'}
                        </td>
                        <td className="px-3 py-2 text-xs font-semibold text-card-foreground tabular-nums">
                          {ex.actual !== undefined ? formatCurrency(ex.actual, cur) : '—'}
                        </td>
                        <td className="px-3 py-2">
                          {ex.difference !== undefined && ex.difference !== 0 ? (
                            <span className="text-xs font-semibold text-destructive tabular-nums">{formatCurrency(ex.difference, cur)}</span>
                          ) : <span className="text-xs text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 text-[10px] px-2"
                              disabled={fixingId === `${ex.account_id}-${idx}`}
                              onClick={() => {
                                setFixingId(`${ex.account_id}-${idx}`);
                                runFix(meta?.fixAction || 'recalculate', ex.account_id).finally(() => setFixingId(null));
                              }}
                            >
                              {fixingId === `${ex.account_id}-${idx}` ? <Loader2 className="h-3 w-3 animate-spin" /> : (meta?.recommendedAction || 'Fix')}
                            </Button>
                            <Link to={`/accounts/${ex.account_id}`}>
                              <Button variant="ghost" size="sm" className="h-6 text-[10px] px-2">View</Button>
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {(data?.exceptions || []).length === 0 && s && (
        <div className="rounded-xl border border-success/40 bg-zinc-900 p-8 text-center">
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
      <div className="animate-fade-in space-y-6 relative">
        <div className="absolute inset-0 -z-10 bg-zinc-950/90 backdrop-blur-sm rounded-xl pointer-events-none" />
        <div>
          <p className="text-xs font-semibold text-primary uppercase tracking-widest mb-1">Admin</p>
          <h1 className="text-2xl font-bold text-foreground font-display">Audit & Monitoring</h1>
          <p className="text-sm text-muted-foreground mt-1">System health, finance reconciliation, penalty audit, overdue diagnostics, and waiver history</p>
        </div>

        <Tabs defaultValue="reconciliation" className="space-y-4">
          <TabsList className="bg-zinc-800 flex-wrap border border-zinc-700">
            <TabsTrigger value="reconciliation" className="gap-1.5"><DollarSign className="h-3.5 w-3.5" /> Reconciliation</TabsTrigger>
            <TabsTrigger value="penalty-cap" className="gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> Penalty Cap Audit</TabsTrigger>
            <TabsTrigger value="health" className="gap-1.5"><Activity className="h-3.5 w-3.5" /> System Health</TabsTrigger>
            <TabsTrigger value="penalties" className="gap-1.5"><Gavel className="h-3.5 w-3.5" /> Penalty Audit</TabsTrigger>
            <TabsTrigger value="overdue" className="gap-1.5"><AlertTriangle className="h-3.5 w-3.5" /> Overdue Debug</TabsTrigger>
            <TabsTrigger value="waivers" className="gap-1.5"><Shield className="h-3.5 w-3.5" /> Waiver History</TabsTrigger>
          </TabsList>

          <TabsContent value="reconciliation"><ReconciliationTab /></TabsContent>
          <TabsContent value="penalty-cap"><PenaltyCapAuditPanel /></TabsContent>
          <TabsContent value="health"><UnifiedSystemHealthTab /></TabsContent>
          <TabsContent value="penalties"><PenaltyAuditTab /></TabsContent>
          <TabsContent value="overdue"><OverdueDebugTab /></TabsContent>
          <TabsContent value="waivers"><WaiverAuditTab /></TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
