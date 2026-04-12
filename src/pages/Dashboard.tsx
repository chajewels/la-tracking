import { useState, useMemo } from 'react';
import { ROUTES } from '@/constants/routes';
import { DollarSign, FileText, AlertTriangle, TrendingUp, CheckCircle2, Banknote, Users, ShieldAlert, Gem, Award, Flame, ShieldCheck, Loader2 } from 'lucide-react';
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
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { getDisplayCurrencyForFilter } from '@/lib/currency-converter';
import { useAccounts, useCustomers, useDashboardSummary } from '@/hooks/use-supabase-data';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';

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
  // Note: accounts/customers are cached with staleTime so these calls are cheap when already loaded

  const customerCount = customers?.length ?? 0;

  // System Audit (admin only)
  const isAdmin = (roles as any[]).includes('admin');
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditResults, setAuditResults] = useState<any[] | null>(null);
  const [auditFilter, setAuditFilter] = useState<'all' | 'failed'>('failed');
  const [auditError, setAuditError] = useState<string | null>(null);

  const runSystemAudit = async () => {
    setAuditLoading(true);
    setAuditError(null);
    setAuditResults(null);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      const { data, error } = await supabase.rpc('audit_all_accounts', {}, { signal: controller.signal } as any);
      clearTimeout(timeout);
      if (error) throw error;
      setAuditResults(data || []);
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
        {/* Welcome Banner */}
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
                  Cha Jewels · Layaway Payment Management
                </p>
              </div>
            </div>
            <CurrencyToggle value={currencyFilter} onChange={setCurrencyFilter} />
          </div>
        </div>

        {/* KPI Cards */}
        <div>
          <p className="text-[10px] font-semibold text-primary uppercase tracking-widest mb-3">Key Metrics</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-4 gap-3 sm:gap-4">
            {summaryLoading ? (
              [...Array(4)].map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)
            ) : (
              <>
                <StatCard
                  title="Total Customers"
                  value={customerCount.toString()}
                  subtitle="All registered"
                  icon={Users}
                />
                <StatCard
                  title="Total Receivables"
                  value={formatCurrency(summary?.total_receivables ?? 0, displayCurrency)}
                  icon={DollarSign}
                  variant="gold"
                />
                <StatCard
                  title="Active Accounts"
                  value={(summary?.active_layaways ?? 0).toString()}
                  subtitle={currencyFilter === 'ALL' ? 'PHP & JPY' : `${currencyFilter} only`}
                  icon={FileText}
                />
                <StatCard
                  title="Collections Today"
                  value={formatCurrency(summary?.payments_today ?? 0, displayCurrency)}
                  icon={TrendingUp}
                  variant="success"
                />
              </>
            )}
          </div>
        </div>

        {canSeePendingSubmissions && <PendingSubmissionsAlert />}

        {/* Secondary KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
          {summaryLoading ? (
            [...Array(6)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
          ) : (
            <>
              <StatCard
                title="This Month"
                value={formatCurrency(summary?.collections_this_month ?? 0, displayCurrency)}
                icon={Banknote}
                variant="success"
              />
              <StatCard
                title="Overdue"
                value={(summary?.overdue_accounts ?? 0).toString()}
                subtitle={formatCurrency(summary?.overdue_amount ?? 0, displayCurrency)}
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
                subtitle="Inactive"
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
                subtitle="All time"
                icon={Award}
                variant="success"
                href={`${ROUTES.ACCOUNTS}?status=completed`}
              />
            </>
          )}
        </div>

        {/* Geo Breakdown */}
        {needsGeo && (
        <div>
          <p className="text-[10px] font-semibold text-primary uppercase tracking-widest mb-3">Regional Overview</p>
          <GeoBreakdown accounts={accounts || []} customers={customers || []} />
        </div>
        )}

        {/* Operations + Live Collection */}
        {(can('view_operations_panel') || can('view_live_collection')) && (
        <div>
          <p className="text-[10px] font-semibold text-primary uppercase tracking-widest mb-3">Operations & Activity</p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {can('view_operations_panel') && <OperationsPanel summary={summary} displayCurrency={displayCurrency} />}
            {can('view_live_collection') && <LiveCollectionTracker currencyFilter={currencyFilter} displayCurrency={displayCurrency} />}
          </div>
        </div>
        )}

        {/* AI & Predictions */}
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

        {/* Aging + Overdue + System Health */}
        <div>
          <p className="text-[10px] font-semibold text-primary uppercase tracking-widest mb-3">System Overview</p>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {can('view_aging_buckets') && <AgingBuckets currency={displayCurrency} />}
            {can('view_overdue_alerts') && <OverdueAlerts />}
            {can('view_system_health') && <SystemHealthPanel summary={summary} />}
          </div>
        </div>

        {/* System Audit — admin only */}
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
              onClick={() => { setAuditOpen(false); setAuditResults(null); setAuditError(null); }}
            />
            <div
              className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{ zIndex: 9999, pointerEvents: 'auto', backgroundColor: 'hsl(0,0%,16%)', borderRadius: 8, padding: 24, maxWidth: 700, width: '95%', maxHeight: '85vh', overflowY: 'auto', color: 'var(--foreground)' }}
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">System Audit — All Accounts</h2>
                <button
                  className="text-muted-foreground hover:text-foreground text-lg leading-none px-2"
                  onClick={() => { setAuditOpen(false); setAuditResults(null); setAuditError(null); }}
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
                  onClick={() => { setAuditOpen(false); setAuditResults(null); setAuditError(null); }}
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
