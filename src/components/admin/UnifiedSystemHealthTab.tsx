import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle, XCircle, Minus, RefreshCw, Loader2,
  ChevronDown, ChevronRight, Database, Bookmark, Cpu, AlertTriangle, Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';
import { Link } from 'react-router-dom';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { toast } from 'sonner';

// ── Types from system-health-v2 ────────────────────────────────────────────
interface V2Account { account_id: string; invoice_number: string; customer_name: string; detail: string; }
interface V2Check {
  id: number;
  section: 'data' | 'benchmark' | 'system';
  label: string;
  description: string;
  status: 'pass' | 'fail' | 'skip';
  affectedCount: number;
  affectedAccounts: V2Account[];
}
interface V2Data { checks: V2Check[]; summary: { total: number; passed: number; failed: number; skipped: number }; timestamp: string; }

// ── Types from system-health-check ────────────────────────────────────────
interface OpsAccount {
  account_id: string; invoice_number: string; customer_name: string;
  reason?: string; status?: string; currency?: string;
  next_due_date?: string; remaining_balance?: number; last_payment_date?: string;
  schedule_summary?: { paid: number; total: number };
  installment_number?: number; due_date?: string; current_status?: string;
  paid_amount?: number; base_installment_amount?: number; schedule_id?: string;
}
interface OpsCheck { status: 'pass' | 'fail' | 'error'; detail: string; affected_accounts?: OpsAccount[]; }
interface OpsData { overall: string; checks: Record<string, OpsCheck>; issues: string[]; timestamp: string; }

// ── Ops check metadata ─────────────────────────────────────────────────────
const OPS_META: Record<string, { label: string; description: string; section: 'data' | 'system'; fixAction: string }> = {
  duplicate_penalties: {
    label: 'Duplicate Penalties',
    description: 'Accounts with more than one active penalty on the same schedule row',
    section: 'data',
    fixAction: 'recalculate',
  },
  false_overdue: {
    label: 'False Overdue Accounts',
    description: 'Accounts marked OVERDUE when all past-due installments are actually paid',
    section: 'system',
    fixAction: 'fix_status',
  },
  schedule_mismatch: {
    label: 'Schedule Status Mismatches',
    description: 'Schedule rows whose status does not match their paid_amount vs base_installment_amount',
    section: 'system',
    fixAction: 'sync_schedule',
  },
};

// ── Section layout ─────────────────────────────────────────────────────────
// v2 check id=10 (Overdue Logic) is replaced by ops false_overdue → excluded
const V2_ID_EXCLUDED = new Set([10]);

const SECTION_META = {
  data:      { label: 'Data Integrity',        icon: Database,  color: 'text-primary' },
  benchmark: { label: 'Benchmark Verification', icon: Bookmark,  color: 'text-info' },
  system:    { label: 'System Checks',          icon: Cpu,       color: 'text-warning' },
} as const;

// ── Status helpers ─────────────────────────────────────────────────────────
function StatusIcon({ status }: { status: 'pass' | 'fail' | 'skip' | 'error' }) {
  if (status === 'pass') return <CheckCircle className="h-4 w-4 text-success flex-shrink-0" />;
  if (status === 'fail' || status === 'error') return <XCircle className="h-4 w-4 text-destructive flex-shrink-0" />;
  return <Minus className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
}

function statusBorder(status: string) {
  if (status === 'pass') return 'border-success/40';
  if (status === 'fail' || status === 'error') return 'border-destructive/40';
  return 'border-zinc-700';
}

// ── Read-only check row (system-health-v2 style) ───────────────────────────
function V2CheckRow({ check }: { check: V2Check }) {
  const [open, setOpen] = useState(false);
  const hasFailed = check.status === 'fail' && check.affectedAccounts.length > 0;
  return (
    <div className={`rounded-lg border bg-zinc-900 transition-colors ${statusBorder(check.status)}`}>
      <div
        className={`flex items-start gap-3 p-3 ${hasFailed ? 'cursor-pointer' : ''}`}
        onClick={() => hasFailed && setOpen(o => !o)}
      >
        <StatusIcon status={check.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-card-foreground">{check.label}</span>
            {check.status === 'fail' && (
              <Badge variant="outline" className="text-[9px] h-4 px-1.5 bg-zinc-900 text-destructive border-destructive/40">
                {check.affectedCount} affected
              </Badge>
            )}
            {check.status === 'skip' && (
              <Badge variant="outline" className="text-[9px] h-4 px-1.5 bg-zinc-700 text-muted-foreground border-zinc-600">skipped</Badge>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">{check.description}</p>
        </div>
        {hasFailed && (
          <div className="text-muted-foreground flex-shrink-0">
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </div>
        )}
      </div>
      {open && hasFailed && (
        <div className="border-t border-destructive/10 mx-3 mb-3">
          <div className="pt-2 space-y-1 max-h-48 overflow-y-auto">
            {check.affectedAccounts.slice(0, 50).map((acc, i) => (
              <div key={i} className="flex items-start gap-2 text-[11px] py-1 border-b border-border/30 last:border-0">
                <Link to={acc.account_id ? `/accounts/${acc.account_id}` : '#'} className="font-mono font-semibold text-primary hover:underline flex-shrink-0 w-16" onClick={e => e.stopPropagation()}>
                  #{acc.invoice_number}
                </Link>
                <span className="text-muted-foreground truncate flex-1">{acc.customer_name}</span>
                <span className="text-card-foreground text-right flex-shrink-0 max-w-[200px] truncate">{acc.detail}</span>
              </div>
            ))}
            {check.affectedAccounts.length > 50 && (
              <p className="text-[10px] text-muted-foreground pt-1">… and {check.affectedAccounts.length - 50} more</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Operational check row (system-health-check style, with fix buttons) ────
function OpsCheckRow({ opsKey, check, onFix, onBulkFix, fixingId }: {
  opsKey: string;
  check: OpsCheck;
  onFix: (action: string, accountId: string, scheduleId?: string) => void;
  onBulkFix: (action: string, accounts: OpsAccount[]) => void;
  fixingId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const meta = OPS_META[opsKey];
  const status = check.status === 'error' ? 'fail' : check.status;
  const affected = check.affected_accounts || [];
  const hasFailed = status === 'fail' && affected.length > 0;
  const filtered = search
    ? affected.filter(a => a.invoice_number?.toLowerCase().includes(search.toLowerCase()) || a.customer_name?.toLowerCase().includes(search.toLowerCase()))
    : affected;

  return (
    <div className={`rounded-lg border bg-zinc-900 transition-colors ${statusBorder(status)}`}>
      <div className={`flex items-start gap-3 p-3 ${hasFailed ? 'cursor-pointer' : ''}`} onClick={() => hasFailed && setOpen(o => !o)}>
        <StatusIcon status={status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-card-foreground">{meta.label}</span>
            {hasFailed && (
              <Badge variant="outline" className="text-[9px] h-4 px-1.5 bg-zinc-900 text-destructive border-destructive/40">
                {affected.length} affected
              </Badge>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">{check.detail || meta.description}</p>
        </div>
        {hasFailed && (
          <div className="text-muted-foreground flex-shrink-0">
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </div>
        )}
      </div>

      {open && hasFailed && (
        <div className="border-t border-zinc-700 mx-3 mb-3 pt-3 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="relative max-w-xs flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input placeholder="Search invoice or customer…" value={search} onChange={e => setSearch(e.target.value)} className="pl-8 h-8 text-xs bg-zinc-800 border-zinc-700" />
            </div>
            <Button variant="outline" size="sm" className="h-8 text-xs bg-zinc-800 border-zinc-700 hover:bg-zinc-700" onClick={e => { e.stopPropagation(); onBulkFix(meta.fixAction, affected); }}>
              <RefreshCw className="h-3 w-3 mr-1" /> Fix All ({affected.length})
            </Button>
          </div>

          <div className="rounded-lg border border-zinc-700 overflow-hidden max-h-80 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-zinc-800 border-b border-zinc-700">
                <tr>
                  <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Invoice</th>
                  <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Customer</th>
                  {opsKey === 'false_overdue' && <>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Status</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Balance</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Schedule</th>
                  </>}
                  {opsKey === 'schedule_mismatch' && <>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Inst#</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">DB Status</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Paid / Base</th>
                  </>}
                  <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Reason</th>
                  <th className="text-left px-3 py-2 text-xs font-semibold text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {filtered.map((acc, idx) => (
                  <tr key={`${acc.account_id}-${idx}`} className="hover:bg-zinc-800/60">
                    <td className="px-3 py-2">
                      <Link to={`/accounts/${acc.account_id}`} className="font-mono text-xs font-semibold text-primary hover:underline" onClick={e => e.stopPropagation()}>
                        #{acc.invoice_number}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs text-card-foreground max-w-[120px] truncate">{acc.customer_name}</td>
                    {opsKey === 'false_overdue' && <>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className="text-[9px] bg-zinc-900 text-destructive border-destructive/40">{acc.status}</Badge>
                      </td>
                      <td className="px-3 py-2 text-xs font-semibold tabular-nums text-card-foreground">
                        {formatCurrency(Number(acc.remaining_balance || 0), (acc.currency || 'PHP') as Currency)}
                      </td>
                      <td className="px-3 py-2 text-[10px] text-muted-foreground">
                        {acc.schedule_summary ? `${acc.schedule_summary.paid}/${acc.schedule_summary.total} paid` : '—'}
                      </td>
                    </>}
                    {opsKey === 'schedule_mismatch' && <>
                      <td className="px-3 py-2 text-xs text-card-foreground">#{acc.installment_number}</td>
                      <td className="px-3 py-2">
                        <Badge variant="outline" className="text-[9px] bg-zinc-900 text-warning border-warning/40">{acc.current_status}</Badge>
                      </td>
                      <td className="px-3 py-2 text-xs tabular-nums text-muted-foreground">
                        {formatCurrency(acc.paid_amount || 0, (acc.currency || 'PHP') as Currency)} / {formatCurrency(acc.base_installment_amount || 0, (acc.currency || 'PHP') as Currency)}
                      </td>
                    </>}
                    <td className="px-3 py-2 text-[10px] text-muted-foreground max-w-[160px] truncate">{acc.reason}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        <Button variant="outline" size="sm" className="h-6 text-[10px] px-2 bg-zinc-800 border-zinc-700" disabled={fixingId === acc.account_id}
                          onClick={e => { e.stopPropagation(); onFix(meta.fixAction, acc.account_id, acc.schedule_id); }}>
                          {fixingId === acc.account_id ? <Loader2 className="h-3 w-3 animate-spin" /> : meta.fixAction === 'fix_status' ? 'Fix Status' : meta.fixAction === 'sync_schedule' ? 'Sync' : 'Recalc'}
                        </Button>
                        <Link to={`/accounts/${acc.account_id}`} onClick={e => e.stopPropagation()}>
                          <Button variant="ghost" size="sm" className="h-6 text-[10px] px-2">View</Button>
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main unified component ─────────────────────────────────────────────────
export default function UnifiedSystemHealthTab() {
  const [loading, setLoading] = useState(false);
  const [fixingId, setFixingId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: v2Data, refetch: refetchV2 } = useQuery<V2Data>({
    queryKey: ['unified-health-v2'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('system-health-v2');
      if (error) throw error;
      return data as V2Data;
    },
  });

  const { data: opsData, refetch: refetchOps } = useQuery<OpsData>({
    queryKey: ['unified-health-ops'],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('system-health-check');
      if (error) throw error;
      return data as OpsData;
    },
  });

  const handleRerun = async () => {
    setLoading(true);
    await Promise.all([refetchV2(), refetchOps()]);
    setLoading(false);
    toast.success('Health checks completed');
  };

  const runFix = async (action: string, accountId: string, scheduleId?: string) => {
    setFixingId(accountId);
    try {
      const { data, error } = await supabase.functions.invoke('fix-account-status', {
        body: { action, account_id: accountId, schedule_id: scheduleId },
      });
      if (error) throw error;
      const realChanges = (data?.changes || []).filter((c: any) => c.from !== undefined);
      if (realChanges.length > 0) {
        toast.success(`Fixed: ${realChanges.map((c: any) => `${c.field}: ${c.from} → ${c.to}`).join(', ')}`);
      } else {
        toast.info('No changes needed — already correct');
      }
      await Promise.all([refetchV2(), refetchOps()]);
      queryClient.invalidateQueries({ queryKey: ['admin-overdue-debug'] });
    } catch (err: any) {
      toast.error(err.message || 'Fix failed');
    } finally {
      setFixingId(null);
    }
  };

  const runBulkFix = async (action: string, accounts: OpsAccount[]) => {
    setLoading(true);
    let fixed = 0;
    for (const acc of accounts) {
      try {
        await supabase.functions.invoke('fix-account-status', {
          body: { action, account_id: acc.account_id, schedule_id: acc.schedule_id },
        });
        fixed++;
      } catch {}
    }
    toast.success(`Bulk fix complete: ${fixed}/${accounts.length} processed`);
    await Promise.all([refetchV2(), refetchOps()]);
    queryClient.invalidateQueries({ queryKey: ['admin-overdue-debug'] });
    setLoading(false);
  };

  // Build unified counts — only count checks that are actually rendered
  const RENDERED_SECTIONS = new Set(['data', 'benchmark', 'system']);
  const v2Checks = (v2Data?.checks || []).filter(
    c => !V2_ID_EXCLUDED.has(c.id) && RENDERED_SECTIONS.has(c.section),
  );
  // Only include ops checks that have a known OPS_META entry — others are
  // returned by the edge function but not rendered, so must not be counted.
  const opsChecks = Object.entries(opsData?.checks || {}).filter(([key]) => key in OPS_META);

  const totalV2Skipped  = v2Checks.filter(c => c.status === 'skip').length;
  const totalV2Passed   = v2Checks.filter(c => c.status === 'pass').length;
  const totalV2Failed   = v2Checks.filter(c => c.status === 'fail').length;
  const totalOpsPassed  = opsChecks.filter(([, c]) => c.status === 'pass').length;
  const totalOpsFailed  = opsChecks.filter(([, c]) => c.status === 'fail' || c.status === 'error').length;

  const totalChecks   = v2Checks.length + opsChecks.length;
  const totalSkipped  = totalV2Skipped;
  const totalPassed   = totalV2Passed + totalOpsPassed;
  const totalFailed   = totalV2Failed + totalOpsFailed;
  // Skipped checks are excluded from the pass/fail denominator
  const activeChecks  = totalChecks - totalSkipped;
  const allGreen      = totalFailed === 0 && activeChecks > 0;

  const hasData = v2Data || opsData;
  const isInitialLoading = !hasData && loading;

  const sections = (['data', 'benchmark', 'system'] as const);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-base font-semibold text-card-foreground">System Health</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {activeChecks} active checks across data integrity, benchmarks, and system functions
            {totalSkipped > 0 && ` · ${totalSkipped} skipped`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {hasData && (
            <p className="text-[10px] text-muted-foreground">
              Last run: {new Date(v2Data?.timestamp || opsData?.timestamp || '').toLocaleTimeString()}
            </p>
          )}
          <Button onClick={handleRerun} disabled={loading} size="sm" className="gap-1.5">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {loading ? 'Running…' : hasData ? 'Re-run Checks' : 'Run All Checks'}
          </Button>
        </div>
      </div>

      {/* Summary banner */}
      {hasData && (
        <div className={`rounded-xl border p-4 bg-zinc-900 ${allGreen ? 'border-success/40' : 'border-destructive/40'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {allGreen ? <CheckCircle className="h-6 w-6 text-success" /> : <XCircle className="h-6 w-6 text-destructive" />}
              <div>
                <p className="text-lg font-bold text-card-foreground font-display">
                  {totalPassed}/{activeChecks} checks passed
                  {totalSkipped > 0 && (
                    <span className="text-sm font-normal text-muted-foreground ml-2">— {totalSkipped} skipped</span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {allGreen
                    ? `System healthy — no issues found${totalSkipped > 0 ? ` (${totalSkipped} check${totalSkipped > 1 ? 's' : ''} not applicable)` : ''}`
                    : `${totalFailed} issue${totalFailed > 1 ? 's' : ''} found — see details below`}
                </p>
              </div>
            </div>
            <div className="flex gap-4 text-center">
              <div>
                <p className="text-xl font-bold text-success">{totalPassed}</p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Passed</p>
              </div>
              {totalSkipped > 0 && (
                <div>
                  <p className="text-xl font-bold text-muted-foreground">{totalSkipped}</p>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Skipped</p>
                </div>
              )}
              <div>
                <p className={`text-xl font-bold ${totalFailed > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>{totalFailed}</p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Failed</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Loading state */}
      {isInitialLoading && (
        <div className="space-y-1.5">
          {Array.from({ length: 16 }).map((_, i) => (
            <div key={i} className="h-14 rounded-lg border border-zinc-700 bg-zinc-900 animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!hasData && !loading && (
        <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-12 text-center">
          <RefreshCw className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium text-card-foreground">No results yet</p>
          <p className="text-xs text-muted-foreground mt-1">Click "Run All Checks" to scan the system</p>
        </div>
      )}

      {/* Checks by section */}
      {hasData && sections.map(section => {
        const meta = SECTION_META[section];
        const Icon = meta.icon;

        // v2 checks for this section (excluding duplicates)
        const sectionV2 = v2Checks.filter(c => c.section === section);
        // ops checks for this section
        const sectionOps = opsChecks.filter(([key]) => OPS_META[key]?.section === section);

        if (sectionV2.length === 0 && sectionOps.length === 0) return null;

        const sectionFailed =
          sectionV2.filter(c => c.status === 'fail').length +
          sectionOps.filter(([, c]) => c.status === 'fail' || c.status === 'error').length;

        return (
          <div key={section} className="space-y-2">
            <div className="flex items-center gap-2">
              <Icon className={`h-3.5 w-3.5 ${meta.color}`} />
              <h3 className={`text-xs font-semibold uppercase tracking-wider ${meta.color}`}>{meta.label}</h3>
              {sectionFailed > 0 && (
                <Badge variant="outline" className="text-[9px] h-4 px-1.5 bg-zinc-900 text-destructive border-destructive/40">
                  {sectionFailed} failed
                </Badge>
              )}
            </div>
            <div className="space-y-1.5">
              {sectionV2.map(check => <V2CheckRow key={check.id} check={check} />)}
              {sectionOps.map(([key, check]) => (
                <OpsCheckRow
                  key={key}
                  opsKey={key}
                  check={check}
                  onFix={runFix}
                  onBulkFix={runBulkFix}
                  fixingId={fixingId}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
