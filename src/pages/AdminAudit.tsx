import { useMemo } from 'react';
import { Shield, Gavel, AlertTriangle, CheckCircle, XCircle, ShieldCheck } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { supabase } from '@/integrations/supabase/client';
import { getPHTToday } from '@/lib/date-utils';
import { useQuery } from '@tanstack/react-query';
import { daysOverdueFromToday, isEffectivelyPaid, getNextUnpaidDueDate } from '@/lib/business-rules';
import { Link } from 'react-router-dom';
import PenaltyCapAuditPanel from '@/components/dashboard/PenaltyCapAuditPanel';

// ── Penalty Audit ──
export function PenaltyAuditTab() {
  const { data: penalties, isLoading } = useQuery({
    queryKey: ['admin-penalty-audit'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('penalty_fees')
        .select('*, layaway_accounts!inner(invoice_number, currency, customers(full_name)), layaway_schedule(installment_number, due_date)')
        .filter('layaway_accounts.is_test', 'eq', false)
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
export function OverdueDebugTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin-overdue-debug'],
    queryFn: async () => {
      const { data: accounts, error } = await supabase
        .from('layaway_accounts')
        .select('*, customers(full_name), layaway_schedule(*), penalty_fees(*)')
        .eq('status', 'overdue')
        .filter('is_test', 'eq', false)
        .order('updated_at', { ascending: false })
        .limit(50);
      if (error) throw error;

      // Canonical per-row remaining from the view (DISPLAY RULES). Helpers below still use raw rows.
      const schedIds = (accounts || []).flatMap((a: any) => (a.layaway_schedule || []).map((s: any) => s.id));
      let remainingById: Record<string, number> = {};
      if (schedIds.length) {
        const { data: sva, error: e2 } = await supabase
          .from('schedule_with_actuals')
          .select('id, actual_remaining')
          .in('id', schedIds);
        if (e2) throw e2;
        remainingById = Object.fromEntries((sva || []).map((r: any) => [r.id, Number(r.actual_remaining ?? 0)]));
      }
      return { accounts: accounts || [], remainingById };
    },
  });

  if (isLoading) return <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}</div>;

  const accounts = data?.accounts || [];
  const remainingById = data?.remainingById || {};

  // Asia/Tokyo (JST, UTC+9) was wrong — canonical timezone is PHT (UTC+8).
  const phtToday = getPHTToday();

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{accounts.length} overdue account(s)</p>
      {accounts.map((acc: any) => {
        const schedules = (acc.layaway_schedule || [])
          .filter((s: any) => s.status !== 'cancelled')
          .sort((a: any, b: any) => Number(a.installment_number) - Number(b.installment_number));
        const penalties = acc.penalty_fees || [];
        const nextDue = getNextUnpaidDueDate(schedules);
        const overdueDays = nextDue ? daysOverdueFromToday(nextDue) : 0;
        const activePenalties = penalties.filter((p: any) => p.status !== 'waived');
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
                <p className="text-muted-foreground">Unpaid Penalties</p>
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
                const cache = Number(s.total_due_amount);
                const canonical = remainingById[s.id] ?? cache;
                const drift = cache - canonical;
                return (
                  <div key={s.id} className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${paid ? 'bg-success' : s.due_date < phtToday ? 'bg-destructive' : 'bg-muted-foreground'}`} />
                    <span>Inst #{s.installment_number}</span>
                    <span>{new Date(s.due_date + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                    <span>{formatCurrency(canonical, currency)}</span>
                    {!paid && Math.abs(drift) >= 0.01 && (
                      <span className="text-amber-500">cache {formatCurrency(cache, currency)} · drift {formatCurrency(drift, currency)}</span>
                    )}
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
export function WaiverAuditTab() {
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
        .select('id, invoice_number, currency, customers(full_name)')
        .in('id', accountIds)
        .filter('is_test', 'eq', false);
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
          const symbol         = (account as any)?.currency === 'JPY' ? '¥' : '₱';

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
                          {symbol}{Number(p.amount).toLocaleString()}
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
                    Total waived: <span className="font-semibold text-success">{symbol}{Number(details.total_waived).toLocaleString()}</span>
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

// ── Main Page ──
export default function AdminAudit() {
  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6 relative">
        <div className="absolute inset-0 -z-10 bg-zinc-950/90 backdrop-blur-sm rounded-xl pointer-events-none" />
        <div>
          <p className="text-xs font-semibold text-primary uppercase tracking-widest mb-1">Admin</p>
          <h1 className="text-2xl font-bold text-foreground font-display">Audit</h1>
          <p className="text-sm text-muted-foreground mt-1">Penalty cap audit, penalty audit, overdue diagnostics, and waiver history</p>
        </div>

        <Tabs defaultValue="penalty-cap" className="space-y-4">
          <TabsList className="bg-zinc-800 flex-wrap border border-zinc-700">
            <TabsTrigger value="penalty-cap" className="gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> Penalty Cap Audit</TabsTrigger>
            <TabsTrigger value="penalties" className="gap-1.5"><Gavel className="h-3.5 w-3.5" /> Penalty Audit</TabsTrigger>
            <TabsTrigger value="overdue" className="gap-1.5"><AlertTriangle className="h-3.5 w-3.5" /> Overdue Debug</TabsTrigger>
            <TabsTrigger value="waivers" className="gap-1.5"><Shield className="h-3.5 w-3.5" /> Waiver History</TabsTrigger>
          </TabsList>

          <TabsContent value="penalty-cap"><PenaltyCapAuditPanel /></TabsContent>
          <TabsContent value="penalties"><PenaltyAuditTab /></TabsContent>
          <TabsContent value="overdue"><OverdueDebugTab /></TabsContent>
          <TabsContent value="waivers"><WaiverAuditTab /></TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
