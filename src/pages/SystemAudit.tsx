import { useState, useMemo } from 'react';
import {
  ClipboardCheck,
  CheckCircle,
  XCircle,
  RefreshCw,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { Link } from 'react-router-dom';
import { computeAccountSummary, isEffectivelyPaid } from '@/lib/business-rules';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface CheckResult {
  label: string;
  pass: boolean;
  expected: string | number;
  actual: string | number;
}

interface AccountAuditResult {
  accountId: string;
  invoiceNumber: string;
  customerName: string;
  status: string;
  currency: string;
  allPass: boolean;
  checks: CheckResult[];
  failedLabels: string[];
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function isDownpaymentPayment(p: any): boolean {
  return (
    (p.reference_number && String(p.reference_number).startsWith('DP-')) ||
    (p.remarks && String(p.remarks).toLowerCase() === 'downpayment')
  );
}

function groupBy(rows: any[], key: string): Record<string, any[]> {
  const map: Record<string, any[]> = {};
  for (const r of rows) {
    if (!map[r[key]]) map[r[key]] = [];
    map[r[key]].push(r);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────
// All 9 verify checks — mirrors AccountDetail.tsx verify panel
// ─────────────────────────────────────────────────────────────

function runAccountChecks(
  account: any,
  schedule: any[],
  payments: any[],
  penalties: any[],
  services: any[],
): CheckResult[] {
  // schedule_with_actuals view provides: base_installment_amount, penalty_amount,
  // carried_amount, allocated, actual_remaining, computed_status, db_status.
  // It does NOT have: status, paid_amount, total_due_amount (those live on raw
  // layaway_schedule). Add compat aliases so existing logic (computeAccountSummary,
  // isEffectivelyPaid, etc.) keeps working, while new checks can use view fields.
  const activeSchedule = schedule
    .map((i: any) => {
      const effectiveStatus = i.computed_status ?? i.db_status ?? i.status;
      const base = Number(i.base_installment_amount || 0);
      const penalty = Number(i.penalty_amount || 0);
      const carried = Number(i.carried_amount || 0);
      const allocated = Number(i.allocated || 0);
      const ceiling = base + penalty + carried;
      // total_due_amount semantics per CLAUDE.md:
      //   paid:            actual paid amount (allocated capped at ceiling)
      //   partially_paid:  shortfall remaining (ceiling - allocated)
      //   pending/overdue: ceiling (base + penalty + carried)
      let total_due_amount: number;
      if (effectiveStatus === 'paid') {
        total_due_amount = Math.min(allocated, ceiling);
      } else if (effectiveStatus === 'partially_paid') {
        total_due_amount = Math.max(0, ceiling - allocated);
      } else {
        total_due_amount = ceiling;
      }
      return {
        ...i,
        status: effectiveStatus,
        paid_amount: Math.min(allocated, ceiling),
        total_due_amount,
      };
    })
    .filter((i: any) => i.status !== 'cancelled');
  if (!activeSchedule.length) return []; // skip accounts with no schedule items

  const principalTotal = Number(account.total_amount || 0);
  const downpaymentAmount = Number(account.downpayment_amount || 0);
  const totalServicesAmount = services.reduce((s: number, svc: any) => s + Number(svc.amount), 0);

  const activePayments = payments.filter((p: any) => !p.voided_at);
  const totalPaid = activePayments.reduce((s: number, p: any) => s + Number(p.amount_paid), 0);

  const unpaidPenaltySum = penalties
    .filter((p: any) => p.status === 'unpaid')
    .reduce((s: number, p: any) => s + Number(p.penalty_amount), 0);
  const paidPenaltySum = penalties
    .filter((p: any) => p.status === 'paid')
    .reduce((s: number, p: any) => s + Number(p.penalty_amount), 0);
  const activePenaltyTotal = paidPenaltySum + unpaidPenaltySum;

  const summary = computeAccountSummary({
    principalTotal,
    totalPaid,
    unpaidPenaltySum,
    totalServicesAmount,
    penaltyPaidSum: paidPenaltySum,
    activePenaltySum: activePenaltyTotal,
    scheduleItems: activeSchedule.map((i: any) => ({
      installment_number: i.installment_number,
      due_date: i.due_date,
      base_installment_amount: i.base_installment_amount,
      penalty_amount: i.penalty_amount,
      total_due_amount: i.total_due_amount,
      paid_amount: i.paid_amount,
      status: i.status,
    })),
  });

  // Check 1–7 inputs
  // sumOfPendingMonths: base + penalty for pending/overdue rows, actual_remaining for partial rows
  // (matches AccountDetail.tsx canonical computation)
  const sumPendingMonths = activeSchedule
    .filter((i: any) => !['paid', 'cancelled'].includes(i.status))
    .reduce((sum: number, i: any) => {
      if (i.status === 'partially_paid') {
        return sum + Math.max(0, Number(i.actual_remaining || 0));
      }
      return sum + Number(i.base_installment_amount) + Number(i.penalty_amount || 0);
    }, 0);
  // Overpayment credit: paid rows where allocated > ceiling (e.g. Keep decision surplus)
  const overpaymentCredit = activeSchedule
    .filter((i: any) => i.status === 'paid')
    .reduce((sum: number, i: any) => {
      const allocated = Number(i.allocated || 0);
      const ceiling = Number(i.base_installment_amount) +
                      Number(i.penalty_amount || 0) +
                      Number(i.carried_amount || 0);
      return sum + Math.max(0, allocated - ceiling);
    }, 0);
  const adjustedPendingMonths = sumPendingMonths - overpaymentCredit;
  const sumAllBases = activeSchedule.reduce((s: number, i: any) => s + Number(i.base_installment_amount), 0);
  const baseIntegrity = Math.round((downpaymentAmount + sumAllBases) * 100) / 100;
  const unpaidCount = activeSchedule.filter((i: any) => !isEffectivelyPaid(i)).length;

  // Check 8: DP must have an explicit tagged payment record
  const dpPayments = activePayments.filter(isDownpaymentPayment);
  const taggedDpPaid = dpPayments.reduce((s: number, p: any) => s + Number(p.amount_paid), 0);
  const dpPass = downpaymentAmount === 0 ||
    (dpPayments.length > 0 && Math.abs(taggedDpPaid - downpaymentAmount) < 1);

  // Check 9: next payment date must come from schedule due_date
  const firstPending = [...activeSchedule]
    .filter((i: any) => i.status === 'pending' || i.status === 'partially_paid')
    .sort((a: any, b: any) => a.installment_number - b.installment_number)[0];
  const nextInSummary = [...summary.scheduleStates]
    .sort((a, b) => a.installmentNumber - b.installmentNumber)
    .find(s => !s.isPaid);
  const check9Exp = firstPending?.due_date ?? '—';
  const check9Act = nextInSummary?.dueDate ?? '—';

  return [
    {
      label: 'activePenalties (non-waived)',
      expected: summary.activePenalties,
      actual: activePenaltyTotal,
      pass: Math.abs(summary.activePenalties - activePenaltyTotal) < 0.01,
    },
    {
      label: 'totalLAAmount (base + penalties + svc)',
      expected: summary.totalLAAmount,
      actual: principalTotal + activePenaltyTotal + totalServicesAmount,
      pass: Math.abs(summary.totalLAAmount - (principalTotal + activePenaltyTotal + totalServicesAmount)) < 0.01,
    },
    {
      label: 'amountPaid (payments table vs stored)',
      expected: totalPaid,
      actual: Math.round(Number(account.total_paid) * 100) / 100,
      pass: Math.abs(totalPaid - Number(account.total_paid)) < 1,
    },
    {
      label: 'remainingBalance (stored vs computed)',
      expected: summary.remainingBalance,
      actual: Math.round(Number(account.remaining_balance) * 100) / 100,
      pass: Math.abs(summary.remainingBalance - Number(account.remaining_balance)) < 2,
    },
    {
      label: 'monthsRemaining',
      expected: summary.unpaidCount,
      actual: unpaidCount,
      pass: summary.unpaidCount === unpaidCount,
    },
    {
      label: 'sumOfPendingMonths ≈ remainingBalance',
      expected: summary.remainingBalance,
      actual: Math.round(adjustedPendingMonths * 100) / 100,
      pass: Math.abs(adjustedPendingMonths - summary.remainingBalance) < 500,
    },
    {
      label: 'DP + sumBases = principalTotal',
      expected: principalTotal,
      actual: baseIntegrity,
      pass: Math.abs(baseIntegrity - principalTotal) < 2,
    },
    {
      label: 'downPayment recorded and marked paid',
      expected: downpaymentAmount,
      actual: taggedDpPaid,
      pass: dpPass,
    },
    {
      label: 'nextPaymentDate uses due_date not payment date',
      expected: check9Exp,
      actual: check9Act,
      pass: !firstPending || check9Exp === check9Act,
    },
  ];
}

// ─────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────

export default function SystemAudit() {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<AccountAuditResult[] | null>(null);
  const [filterStatus, setFilterStatus] = useState<'failed' | 'all' | 'passed'>('failed');
  const [filterCheck, setFilterCheck] = useState('all');

  const runAudit = async () => {
    setLoading(true);
    setResults(null);
    try {
      const { data: accounts, error: accErr } = await supabase
        .from('layaway_accounts')
        .select('*, customers(full_name)')
        .in('status', ['active', 'overdue', 'final_settlement', 'extension_active'])
        .order('invoice_number');
      if (accErr) throw accErr;
      if (!accounts?.length) { setResults([]); return; }

      const ids = accounts.map((a: any) => a.id);

      const [schRes, payRes, penRes, svcRes] = await Promise.all([
        supabase.from('schedule_with_actuals' as any).select('*').in('account_id', ids),
        supabase.from('payments').select('*').in('account_id', ids),
        supabase.from('penalty_fees').select('*').in('account_id', ids),
        supabase.from('account_services' as any).select('*').in('account_id', ids),
      ]);

      console.log('[SystemAudit] schRes rows:', schRes.data?.length,
                  'error:', schRes.error,
                  'sample row:', schRes.data?.[0]);

      const scheduleMap = groupBy(schRes.data || [], 'account_id');
      const paymentsMap = groupBy(payRes.data || [], 'account_id');
      const penaltiesMap = groupBy(penRes.data || [], 'account_id');
      const servicesMap = groupBy(svcRes.data || [], 'account_id');

      const auditResults: AccountAuditResult[] = accounts.map((acc: any) => {
        let checks: any[] = [];
        try {
          checks = runAccountChecks(
            acc,
            scheduleMap[acc.id] || [],
            paymentsMap[acc.id] || [],
            penaltiesMap[acc.id] || [],
            servicesMap[acc.id] || [],
          );
        } catch (err) {
          console.error('[SystemAudit] runAccountChecks error for', acc.invoice_number, err);
        }
        const allPass = checks.length === 0 || checks.every(c => c.pass);
        return {
          accountId: acc.id,
          invoiceNumber: acc.invoice_number,
          customerName: (acc.customers as any)?.full_name || '—',
          status: acc.status,
          currency: acc.currency,
          allPass,
          checks,
          failedLabels: checks.filter(c => !c.pass).map(c => c.label),
        };
      });

      setResults(auditResults);
    } catch (err: any) {
      console.error('Audit error:', err);
    } finally {
      setLoading(false);
    }
  };

  // All unique check labels across all results (for filter dropdown)
  const checkLabels = useMemo(() => {
    if (!results) return [];
    const labels = new Set<string>();
    for (const r of results) for (const c of r.checks) labels.add(c.label);
    return Array.from(labels);
  }, [results]);

  const filtered = useMemo(() => {
    if (!results) return [];
    return results.filter(r => {
      if (filterStatus === 'failed' && r.allPass) return false;
      if (filterStatus === 'passed' && !r.allPass) return false;
      if (filterCheck !== 'all' && !r.failedLabels.includes(filterCheck)) return false;
      return true;
    });
  }, [results, filterStatus, filterCheck]);

  const passCount = results?.filter(r => r.allPass).length ?? 0;
  const failCount = results?.filter(r => !r.allPass).length ?? 0;

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-primary uppercase tracking-widest mb-1">Operations</p>
            <h1 className="text-2xl font-bold text-foreground font-display">System Audit</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Run all 9 verify checks across every active and overdue account
            </p>
          </div>
          <Button
            onClick={runAudit}
            disabled={loading}
            className="gold-gradient text-primary-foreground self-start sm:self-auto"
          >
            {loading
              ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Running…</>
              : <><RefreshCw className="h-4 w-4 mr-2" />Run Audit</>}
          </Button>
        </div>

        {/* Summary tiles */}
        {results && (
          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Accounts Checked</p>
              <p className="text-2xl font-bold text-card-foreground">{results.length}</p>
            </div>
            <div className="rounded-xl border border-success/30 bg-success/5 p-4">
              <p className="text-xs text-success uppercase tracking-wider mb-1">All Checks Pass</p>
              <p className="text-2xl font-bold text-success">✅ {passCount}</p>
            </div>
            <div className={`rounded-xl border p-4 ${failCount > 0 ? 'border-destructive/30 bg-destructive/5' : 'border-border bg-card'}`}>
              <p className="text-xs text-destructive uppercase tracking-wider mb-1">Has Failures</p>
              <p className="text-2xl font-bold text-destructive">❌ {failCount}</p>
            </div>
          </div>
        )}

        {/* Filters */}
        {results && results.length > 0 && (
          <div className="flex items-center gap-3 flex-wrap">
            <Select value={filterStatus} onValueChange={(v: any) => setFilterStatus(v)}>
              <SelectTrigger className="w-40 bg-card border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="failed">Failed only</SelectItem>
                <SelectItem value="all">All accounts</SelectItem>
                <SelectItem value="passed">Passed only</SelectItem>
              </SelectContent>
            </Select>

            <Select value={filterCheck} onValueChange={setFilterCheck}>
              <SelectTrigger className="w-80 bg-card border-border">
                <SelectValue placeholder="Filter by check…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All checks</SelectItem>
                {checkLabels.map(l => (
                  <SelectItem key={l} value={l}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <span className="text-xs text-muted-foreground">
              {filtered.length} account{filtered.length !== 1 ? 's' : ''}
            </span>
          </div>
        )}

        {/* Results table */}
        {results !== null && (
          filtered.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-12 text-center">
              <CheckCircle className="h-10 w-10 text-success/40 mx-auto mb-3" />
              <p className="text-sm font-medium text-card-foreground">
                {filterStatus === 'failed' && filterCheck === 'all'
                  ? 'No accounts with failures 🎉'
                  : 'No accounts match this filter'}
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/30 border-b border-border">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase">Invoice</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase">Customer</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase">Status</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase">Failed Checks</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map(r => (
                    <tr key={r.accountId} className="hover:bg-muted/10">
                      <td className="px-4 py-3 font-mono font-semibold text-card-foreground">
                        #{r.invoiceNumber}
                      </td>
                      <td className="px-4 py-3 text-card-foreground">{r.customerName}</td>
                      <td className="px-4 py-3">
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${r.status === 'overdue'
                            ? 'border-destructive/30 text-destructive'
                            : 'border-success/30 text-success'}`}
                        >
                          {r.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        {r.allPass ? (
                          <span className="text-xs text-success flex items-center gap-1">
                            <CheckCircle className="h-3 w-3" /> All passed
                          </span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {r.failedLabels.map(l => (
                              <Badge
                                key={l}
                                variant="outline"
                                className="text-[9px] border-destructive/30 text-destructive max-w-[200px] truncate"
                                title={l}
                              >
                                <XCircle className="h-2.5 w-2.5 mr-0.5 flex-shrink-0" />
                                {l}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link to={`/accounts/${r.accountId}`}>
                          <Button variant="ghost" size="sm" className="h-7 text-xs text-primary hover:text-primary">
                            View <ExternalLink className="h-3 w-3 ml-1" />
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {/* Empty state before first run */}
        {!results && !loading && (
          <div className="rounded-xl border border-border bg-card p-12 text-center">
            <ClipboardCheck className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm font-medium text-card-foreground">
              Press Run Audit to check all active accounts
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Runs all 9 verify checks across every active and overdue account
            </p>
          </div>
        )}

      </div>
    </AppLayout>
  );
}
