import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ROUTES } from '@/constants/routes';
import { FileText, AlertTriangle, CheckCircle2, Users, ShieldAlert, Gem, Award, Flame, ShieldCheck, Loader2, Clock, CalendarCheck, Calendar } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import PendingSubmissionsAlert from '@/components/dashboard/PendingSubmissionsAlert';
import AppLayout from '@/components/layout/AppLayout';
import StatCard from '@/components/dashboard/StatCard';
import AgingBuckets from '@/components/dashboard/AgingBuckets';
import OverdueAlerts from '@/components/dashboard/OverdueAlerts';
import CurrencyToggle, { CurrencyFilter } from '@/components/dashboard/CurrencyToggle';
import GeoBreakdown from '@/components/dashboard/GeoBreakdown';
import OperationsPanel from '@/components/dashboard/OperationsPanel';
import LiveCollectionTracker from '@/components/dashboard/LiveCollectionTracker';
import { LatePaymentRiskPanel, CompletionProbabilityPanel, CLVPanel } from '@/components/dashboard/AIRiskPanel';
import SystemHealthPanel from '@/components/dashboard/SystemHealthPanel';
import { Currency } from '@/lib/types';
import { getDisplayCurrencyForFilter } from '@/lib/currency-converter';
import { useAccounts, useCustomers, useDashboardSummary } from '@/hooks/use-supabase-data';
import { useAutoRefresh } from '@/hooks/use-auto-refresh';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';

interface DriftFinding {
  delete_function: string;
  parent_table: string;
  child_table: string;
  fk_name: string | null;
  on_delete: string | null;
  in_allowlist: boolean;
  finding_type: 'missing_cleanup' | 'preventive_no_delete_fn' | 'stale_allowlist_entry';
  severity: 'critical' | 'warning' | 'info';
  message: string;
}

export default function Dashboard() {
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>('ALL');
  const { session, loading: authLoading, profile, roles } = useAuth();
  const { can, canAccessPage } = usePermissions();
  const displayCurrency: Currency = getDisplayCurrencyForFilter(currencyFilter);
  const canSeePendingSubmissions = canAccessPage('/payment-submissions');

  const { data: summary, isLoading: summaryLoading } = useDashboardSummary(
    currencyFilter,
    Boolean(session) && !authLoading,
  );
  // Only load accounts/customers if needed by visible widgets
  const needsGeo = can('view_geo_breakdown');
  const { data: accounts } = useAccounts();
  const { data: customers } = useCustomers();
  useAutoRefresh([
    ['accounts'],
    ['customers'],
    ['dashboard-summary'],
  ]);
  // Note: accounts/customers are cached with staleTime so these calls are cheap when already loaded

  const customerCount = useMemo(() => {
    if (currencyFilter === 'ALL') return customers?.length ?? 0;
    if (!accounts) return 0;
    // Distinct customers with at least one layaway account in the selected
    // currency, excluding TEST accounts (matches dashboard-summary edge
    // function convention). Status-agnostic — counts anyone who ever had
    // an account in this currency.
    const matchingCustomerIds = new Set(
      accounts
        .filter((a: any) =>
          a.currency === currencyFilter &&
          !String(a.invoice_number).startsWith('TEST-')
        )
        .map((a: any) => a.customer_id)
    );
    return matchingCustomerIds.size;
  }, [customers, accounts, currencyFilter]);

  // Plan tier counts derived from already-loaded accounts list.
  // Active-flow scope: 4 statuses, TEST excluded (mirrors get_aging_buckets).
  const PLAN_TIERS = [3, 6, 8, 10, 12] as const;
  const ACTIVE_FLOW_STATUSES = new Set([
    'active', 'overdue', 'extension_active', 'final_settlement',
  ]);
  const planTierCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const t of PLAN_TIERS) counts.set(t, 0);
    for (const a of accounts ?? []) {
      if (!ACTIVE_FLOW_STATUSES.has(String((a as any).status))) continue;
      if (String((a as any).invoice_number).startsWith('TEST-')) continue;
      const m = Number((a as any).payment_plan_months);
      if (!counts.has(m)) continue;
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    return counts;
  }, [accounts]);

  // Aging buckets scope toggle (count-only on Dashboard).
  const [agingScope, setAgingScope] = useState<'all_collectible' | 'active_flow'>('all_collectible');

  // System Audit (admin only)
  const isAdmin = (roles as any[]).includes('admin');
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditResults, setAuditResults] = useState<any[] | null>(null);
  const [auditFilter, setAuditFilter] = useState<'all' | 'failed'>('failed');
  const [auditError, setAuditError] = useState<string | null>(null);
  const [driftFindings, setDriftFindings] = useState<DriftFinding[] | null>(null);
  const [driftError, setDriftError] = useState<string | null>(null);

  const runSystemAudit = async () => {
    setAuditLoading(true);
    setAuditError(null);
    setAuditResults(null);
    setDriftFindings(null);
    setDriftError(null);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      const [accountAudit, drift] = await Promise.all([
        (supabase.rpc as any)('audit_all_accounts', undefined, { signal: controller.signal }),
        (supabase.rpc as any)('audit_delete_cleanup_invariants', undefined, { signal: controller.signal }),
      ]);
      clearTimeout(timeout);

      if (accountAudit.error) throw accountAudit.error;
      setAuditResults(accountAudit.data || []);

      // Drift check is soft-fail — if RPC missing or errors, surface as
      // warning but still show account audit results.
      if (drift.error) {
        setDriftError(drift.error.message || 'Schema drift check unavailable');
        setDriftFindings(null);
      } else {
        setDriftFindings(drift.data || []);
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || err.message?.includes('abort')) {
        setAuditError('Audit timed out — too many accounts. Run per-account health checks individually instead.');
      } else {
        setAuditError(err.message || 'System audit failed. The audit_all_accounts RPC may not exist yet — create it in the Supabase SQL Editor.');
      }
      console.error('System audit error:', err);
    } finally {
      setAuditLoading(false);
    }
  };

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }, []);

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-8">
        {/* Section 1 — Welcome Banner */}
        <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-card via-card to-primary/5 p-6 sm:p-8">
          <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full -translate-y-1/2 translate-x-1/3 blur-3xl" />
          <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl gold-gradient shadow-lg">
                <Gem className="h-6 w-6 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-xl sm:text-2xl font-bold text-foreground font-display">
                  {greeting}, {profile?.full_name?.split(' ')[0] || 'there'}
                </h1>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Cha Jewels Hub
                </p>
              </div>
            </div>
            <CurrencyToggle value={currencyFilter} onChange={setCurrencyFilter} />
          </div>
        </div>

        {/* Section 2 — Key Metrics (counts only) */}
        <div>
          <p className="text-[10px] font-semibold text-primary uppercase tracking-widest mb-3">Key Metrics</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            {summaryLoading ? (
              [...Array(2)].map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)
            ) : (
              <>
                <StatCard
                  title="Total Customers"
                  value={customerCount.toString()}
                  subtitle={
                    currencyFilter === 'ALL'
                      ? 'All registered'
                      : `with ${currencyFilter} accounts`
                  }
                  icon={Users}
                />
                <StatCard
                  title="Total Active Accounts"
                  value={(summary?.active_layaways ?? 0).toString()}
                  subtitle={currencyFilter === 'ALL' ? 'PHP & JPY' : `${currencyFilter} only`}
                  icon={FileText}
                />
              </>
            )}
          </div>
        </div>

        {/* Section 3 — Pending Submissions Alert */}
        {canSeePendingSubmissions && <PendingSubmissionsAlert />}

        {/* Section 4 — Layaway Accounts */}
        <div>
          <p className="text-[10px] font-semibold text-primary uppercase tracking-widest mb-1">Layaway Accounts</p>
          <p className="text-xs text-muted-foreground mb-3">By plan tier</p>

          {/* 5 fixed plan tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 sm:gap-4 mb-4">
            {PLAN_TIERS.map((tier) => {
              const count = planTierCounts.get(tier) ?? 0;
              const isZero = count === 0;
              return (
                <Link
                  key={tier}
                  to={`${ROUTES.ACCOUNTS}?plan_months=${tier}`}
                  className={`group relative overflow-hidden rounded-xl border p-4 card-hover ${
                    isZero
                      ? 'bg-card border-border hover:border-border'
                      : 'bg-card border-border hover:border-primary/30'
                  }`}
                >
                  <p className="text-[10px] sm:text-xs font-medium text-muted-foreground uppercase tracking-wider leading-tight">
                    {tier} months
                  </p>
                  <p className={`mt-1.5 text-xl sm:text-2xl font-bold font-display tabular-nums ${
                    isZero ? 'text-muted-foreground/50' : 'text-card-foreground'
                  }`}>
                    {count}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {count === 1 ? 'account' : 'accounts'}
                  </p>
                </Link>
              );
            })}
          </div>

          {/* 5 status cards (count-only) */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
            {summaryLoading ? (
              [...Array(5)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
            ) : (
              <>
                <StatCard
                  title="Overdue"
                  value={(summary?.overdue_accounts ?? 0).toString()}
                  icon={AlertTriangle}
                  variant="danger"
                  href={`${ROUTES.MONITORING}?filter=overdue`}
                />
                <StatCard
                  title="Completed"
                  value={(summary?.completed_this_month ?? 0).toString()}
                  subtitle="This month"
                  icon={CheckCircle2}
                  variant="success"
                  href={`${ROUTES.ACCOUNTS}?status=completed`}
                />
                <StatCard
                  title="Forfeited"
                  value={(summary?.forfeited_accounts ?? 0).toString()}
                  icon={ShieldAlert}
                  variant="danger"
                  href={`${ROUTES.ACCOUNTS}?status=forfeited`}
                />
                <StatCard
                  title="Forfeited Today"
                  value={(summary?.forfeited_today ?? 0).toString()}
                  icon={Flame}
                  variant="warning"
                  href={`${ROUTES.ACCOUNTS}?status=forfeited&period=today`}
                />
                <StatCard
                  title="All Time Completed"
                  value={(summary?.completed_all_time ?? 0).toString()}
                  icon={Award}
                  variant="success"
                  href={`${ROUTES.ACCOUNTS}?status=completed`}
                />
              </>
            )}
          </div>
        </div>

        {/* Section 5 — Cash Orders (counts only — revenue cards moved to Finance) */}
        <div>
          <p className="text-[10px] font-semibold text-primary uppercase tracking-widest mb-3">Cash Orders</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            {summaryLoading ? (
              [...Array(2)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
            ) : (
              <>
                <StatCard
                  title="Active Orders"
                  value={(summary?.cash_orders_active ?? 0).toString()}
                  subtitle="Pending"
                  icon={FileText}
                />
                <StatCard
                  title="Completed"
                  value={(summary?.cash_orders_completed_this_month ?? 0).toString()}
                  subtitle="This month"
                  icon={CheckCircle2}
                  variant="success"
                />
              </>
            )}
          </div>
        </div>

        {/* Section 6 — Aging Buckets (count variant, scope-toggleable) */}
        {can('view_aging_buckets') && (
          <div>
            <AgingBuckets
              currency={displayCurrency}
              variant="count"
              scope={agingScope}
              onScopeChange={setAgingScope}
            />
          </div>
        )}

        {/* Section 7 — Overdue & Due Soon (count-only) */}
        <div>
          <p className="text-[10px] font-semibold text-primary uppercase tracking-widest mb-3">Overdue & Due Soon</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
            {summaryLoading ? (
              [...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
            ) : (
              <>
                <StatCard
                  title="Due Today"
                  value={(summary?.due_today_count ?? 0).toString()}
                  icon={Clock}
                  variant="warning"
                  href={`${ROUTES.MONITORING}?filter=due_today`}
                />
                <StatCard
                  title="Due in 3 Days"
                  value={(summary?.due_3_days_count ?? 0).toString()}
                  icon={CalendarCheck}
                />
                <StatCard
                  title="Due in 7 Days"
                  value={(summary?.due_7_days_count ?? 0).toString()}
                  icon={Calendar}
                />
              </>
            )}
          </div>
        </div>

        {/* Section 8 — Regional Overview (count-only on Dashboard) */}
        {needsGeo && (
        <div>
          <p className="text-[10px] font-semibold text-primary uppercase tracking-widest mb-3">Regional Overview</p>
          <GeoBreakdown accounts={accounts || []} customers={customers || []} countOnly />
        </div>
        )}

        {/* Section 9 — System Health + Overdue Alerts */}
        {(can('view_overdue_alerts') || can('view_system_health')) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {can('view_overdue_alerts') && <OverdueAlerts />}
            {can('view_system_health') && <SystemHealthPanel summary={summary} />}
          </div>
        )}

        {/* Section 10 — AI & Predictions */}
        {can('view_ai_risk') && (
        <div>
          <p className="text-[10px] font-semibold text-primary uppercase tracking-widest mb-3">AI & Predictions</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <LatePaymentRiskPanel />
            <CompletionProbabilityPanel />
            <CLVPanel />
          </div>
        </div>
        )}

        {/* Sections 11 + 12 — Operations Panel + Live Collection Tracker (count-only) */}
        {(can('view_operations_panel') || can('view_live_collection')) && (
        <div>
          <p className="text-[10px] font-semibold text-primary uppercase tracking-widest mb-3">Operations & Activity</p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {can('view_operations_panel') && <OperationsPanel summary={summary} displayCurrency={displayCurrency} countOnly />}
            {can('view_live_collection') && <LiveCollectionTracker currencyFilter={currencyFilter} displayCurrency={displayCurrency} countOnly />}
          </div>
        </div>
        )}

        {/* Section 13 — System Audit — admin only */}
        {isAdmin && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-[10px] font-semibold text-primary uppercase tracking-widest">Account Audit</p>
              <button
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-primary/30 text-primary hover:bg-primary/10 disabled:opacity-50"
                disabled={auditLoading}
                onClick={() => { setAuditOpen(true); runSystemAudit(); }}
              >
                {auditLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                Run System Audit
              </button>
            </div>
          </div>
        )}

        {/* System Audit Modal */}
        {auditOpen && (
          <>
            <div
              className="fixed inset-0"
              style={{ zIndex: 9998, pointerEvents: 'auto', backgroundColor: 'rgba(0,0,0,0.7)' }}
              onClick={() => { setAuditOpen(false); setAuditResults(null); setAuditError(null); setDriftFindings(null); setDriftError(null); }}
            />
            <div
              className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{ zIndex: 9999, pointerEvents: 'auto', backgroundColor: 'hsl(0,0%,16%)', borderRadius: 8, padding: 24, maxWidth: 700, width: '95%', maxHeight: '85vh', overflowY: 'auto', color: 'var(--foreground)' }}
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">System Audit</h2>
                <button
                  className="text-muted-foreground hover:text-foreground text-lg leading-none px-2"
                  onClick={() => { setAuditOpen(false); setAuditResults(null); setAuditError(null); setDriftFindings(null); setDriftError(null); }}
                >×</button>
              </div>

              {auditLoading && (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-5 w-5 animate-spin text-primary mr-2" />
                  <span className="text-sm text-muted-foreground">Auditing all accounts...</span>
                </div>
              )}

              {!auditLoading && auditError && (
                <div className="rounded-md p-3 bg-destructive/10 border border-destructive/20 text-sm text-destructive">
                  {auditError}
                </div>
              )}

              {!auditLoading && auditResults && (
                <div className="space-y-3">
                  {/* Schema drift findings */}
                  {driftError && (
                    <div className="rounded-md p-2.5 bg-warning/10 border border-warning/20 text-xs text-warning">
                      Schema drift check unavailable: {driftError}
                    </div>
                  )}
                  {driftFindings && driftFindings.length === 0 && (
                    <div className="rounded-md p-3 text-sm font-medium bg-success/10 text-success border border-success/20">
                      ✅ No schema drift detected
                    </div>
                  )}
                  {driftFindings && driftFindings.length > 0 && (() => {
                    const counts = driftFindings.reduce(
                      (acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; },
                      {} as Record<'critical' | 'warning' | 'info', number>
                    );
                    const headerColor = counts.critical
                      ? 'bg-destructive/10 text-destructive border-destructive/20'
                      : counts.warning
                        ? 'bg-warning/10 text-warning border-warning/20'
                        : 'bg-info/10 text-info border-info/20';
                    const sevBadge = (sev: DriftFinding['severity']) =>
                      sev === 'critical' ? 'bg-destructive/15 text-destructive border-destructive/30'
                      : sev === 'warning' ? 'bg-warning/15 text-warning border-warning/30'
                      : 'bg-info/15 text-info border-info/30';
                    return (
                      <div className="space-y-2">
                        <div className={`rounded-md p-3 text-sm font-medium border ${headerColor}`}>
                          ⚠️ {driftFindings.length} schema drift finding{driftFindings.length !== 1 ? 's' : ''}
                          {counts.critical ? ` · ${counts.critical} critical` : ''}
                          {counts.warning ? ` · ${counts.warning} warning` : ''}
                          {counts.info ? ` · ${counts.info} info` : ''}
                        </div>
                        <div className="rounded-md border border-border overflow-hidden">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="bg-muted/30 border-b border-border">
                                <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Severity</th>
                                <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Delete Fn</th>
                                <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Parent</th>
                                <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Child</th>
                                <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Finding</th>
                              </tr>
                            </thead>
                            <tbody>
                              {driftFindings.map((f, i) => (
                                <tr key={i} className="border-b border-border/50 last:border-0">
                                  <td className="px-3 py-2">
                                    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${sevBadge(f.severity)}`}>
                                      {f.severity}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 font-mono text-foreground">{f.delete_function}</td>
                                  <td className="px-3 py-2 text-muted-foreground">{f.parent_table}</td>
                                  <td className="px-3 py-2 font-mono text-foreground">{f.child_table}</td>
                                  <td className="px-3 py-2 text-muted-foreground">{f.message}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <p className="text-[10px] text-muted-foreground">
                          Drift findings indicate FK gaps in delete-cleanup edge functions. See CLAUDE.md "AUDIT RPCs" section for fix patterns.
                        </p>
                      </div>
                    );
                  })()}

                  {/* Visual divider before per-account section */}
                  {driftFindings !== null && (
                    <div className="border-t border-border pt-3">
                      <p className="text-[10px] font-semibold text-primary uppercase tracking-widest mb-3">Per-Account Health</p>
                    </div>
                  )}

                  {(() => {
                    const failedAccounts = auditResults.filter((r: any) => !r.all_pass);
                    const passedCount = auditResults.length - failedAccounts.length;
                    const filtered = auditFilter === 'failed' ? failedAccounts : auditResults;
                    return (
                      <>
                        <div className={`rounded-md p-3 text-sm font-medium ${
                          failedAccounts.length === 0 ? 'bg-success/10 text-success border border-success/20' : 'bg-destructive/10 text-destructive border border-destructive/20'
                        }`}>
                          {failedAccounts.length === 0
                            ? `✅ All ${auditResults.length} accounts passed`
                            : `❌ ${failedAccounts.length} failed / ${passedCount} passed / ${auditResults.length} total`}
                        </div>

                        <div className="flex gap-2 text-xs">
                          <button
                            className={`px-3 py-1 rounded-md border ${auditFilter === 'failed' ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}
                            onClick={() => setAuditFilter('failed')}
                          >Failed Only ({failedAccounts.length})</button>
                          <button
                            className={`px-3 py-1 rounded-md border ${auditFilter === 'all' ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}
                            onClick={() => setAuditFilter('all')}
                          >All ({auditResults.length})</button>
                        </div>

                        {filtered.length === 0 && (
                          <p className="text-sm text-muted-foreground text-center py-4">
                            {auditFilter === 'failed' ? 'No failing accounts' : 'No accounts found'}
                          </p>
                        )}

                        {filtered.length > 0 && (
                          <div className="rounded-md border border-border overflow-hidden">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="bg-muted/30 border-b border-border">
                                  <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Invoice</th>
                                  <th className="text-center px-3 py-2 font-semibold text-muted-foreground">Health</th>
                                  <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Failed Checks</th>
                                </tr>
                              </thead>
                              <tbody>
                                {filtered.map((r: any, i: number) => (
                                  <tr key={i} className="border-b border-border/50 last:border-0">
                                    <td className="px-3 py-2 font-mono font-medium text-foreground">#{r.invoice_number}</td>
                                    <td className="px-3 py-2 text-center">{r.all_pass ? '✅' : '❌'}</td>
                                    <td className="px-3 py-2 text-muted-foreground">
                                      {r.failed_checks ? (
                                        Array.isArray(r.failed_checks) ? r.failed_checks.join(', ') : String(r.failed_checks)
                                      ) : '—'}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}

              <div className="flex justify-end gap-3 mt-4 pt-3 border-t border-border">
                <button
                  className="px-4 py-2 rounded-lg text-sm text-primary border border-primary/30 hover:bg-primary/10 disabled:opacity-50"
                  disabled={auditLoading}
                  onClick={runSystemAudit}
                >
                  {auditLoading ? 'Running...' : 'Re-run Audit'}
                </button>
                <button
                  className="px-4 py-2 rounded-lg text-sm border border-border"
                  onClick={() => { setAuditOpen(false); setAuditResults(null); setAuditError(null); setDriftFindings(null); setDriftError(null); }}
                >
                  Close
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
