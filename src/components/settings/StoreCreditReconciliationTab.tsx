import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ShieldCheck, Loader2, AlertTriangle, CheckCircle2, ArrowDownRight,
  ArrowUpRight, RefreshCw, Info,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatCurrency } from '@/lib/calculations';
import { useAuth } from '@/contexts/AuthContext';

// The reconcile-store-credit edge function response shape (report-only).
type DriftRow = {
  customer_id: string;
  full_name: string | null;
  email: string | null;
  hub_balance: number;
  shopify_balance: number;
  delta: number;
};
type UnreadableRow = {
  customer_id: string;
  full_name: string | null;
  detail: string | null;
};
type FailedSyncRow = {
  id: string;
  customer_id: string | null;
  direction: string | null;
  amount: number | null;
  status: string | null;
  error_detail: string | null;
  created_at: string | null;
};
type ReconResult = {
  run_id: string;
  checked: number;
  matched: number;
  drift: DriftRow[];
  unreadable: UnreadableRow[];
  failed_syncs: FailedSyncRow[];
};

// One stored reconciliation row (public.store_credit_reconciliation). This table
// is not present in the auto-generated Supabase types, so the query is cast at
// the call site (never hand-edit types.ts).
type StoredReconRow = {
  run_id: string;
  customer_id: string;
  shopify_customer_id: string | null;
  hub_balance: number | null;
  shopify_balance: number | null;
  delta: number | null;
  status: 'match' | 'drift' | 'shopify_unreadable';
  detail: string | null;
  checked_at: string;
};

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila',
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso)) + ' PHT';
  } catch {
    return iso;
  }
}

// Delta = hub - shopify. Positive → the Hub has MORE than Shopify (a credit that
// never reached Shopify). Negative → Shopify has MORE than the Hub (Shopify was
// over-credited). The sign is diagnostically meaningful, so render it distinctly.
function DeltaCell({ delta }: { delta: number }) {
  const positive = delta > 0;
  const Icon = positive ? ArrowUpRight : ArrowDownRight;
  const cls = positive ? 'text-warning' : 'text-destructive';
  return (
    <span className={`inline-flex items-center gap-1 font-medium tabular-nums ${cls}`}>
      <Icon className="h-3.5 w-3.5" />
      {positive ? '+' : '−'}{formatCurrency(Math.abs(delta), 'JPY')}
    </span>
  );
}

function SummaryStat({
  label, value, loud,
}: { label: string; value: number; loud?: boolean }) {
  const isLoud = loud && value > 0;
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        isLoud
          ? 'border-destructive/40 bg-destructive/10'
          : 'border-border bg-muted/30'
      }`}
    >
      <p className={`text-[10px] uppercase tracking-wide ${isLoud ? 'text-destructive' : 'text-muted-foreground'}`}>
        {label}
      </p>
      <p className={`text-lg font-semibold tabular-nums mt-0.5 ${isLoud ? 'text-destructive' : 'text-foreground'}`}>
        {value}
      </p>
    </div>
  );
}

export default function StoreCreditReconciliationTab() {
  const { roles } = useAuth();
  const isAdmin = (roles as string[]).includes('admin');

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ReconResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // Load the latest STORED run on mount so the page is useful without clicking Run.
  const { data: stored, isLoading: storedLoading } = useQuery({
    queryKey: ['sc-reconciliation-latest'],
    staleTime: 60_000,
    queryFn: async (): Promise<StoredReconRow[]> => {
      // store_credit_reconciliation is absent from the generated types — cast.
      const { data, error } = await (supabase.from('store_credit_reconciliation' as any) as any)
        .select('run_id, customer_id, shopify_customer_id, hub_balance, shopify_balance, delta, status, detail, checked_at')
        .order('checked_at', { ascending: false })
        .limit(1000);
      if (error) throw error;
      const rows = (data ?? []) as StoredReconRow[];
      if (rows.length === 0) return [];
      // The most-recent run_id is the first row's (ordered by checked_at desc).
      const latestRunId = rows[0].run_id;
      return rows.filter((r) => r.run_id === latestRunId);
    },
  });

  const runNow = async () => {
    setRunning(true);
    setRunError(null);
    try {
      const { data, error } = await supabase.functions.invoke('reconcile-store-credit', { body: {} });
      if (error) {
        let msg = error.message || 'Reconciliation failed';
        try {
          if ('context' in error && (error as any).context?.body) {
            const b = await new Response((error as any).context.body).json();
            if (b?.error) msg = b.error;
          }
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      if ((data as any)?.error) throw new Error((data as any).error);
      setResult(data as ReconResult);
    } catch (err: any) {
      setRunError(err?.message || 'Reconciliation failed');
    } finally {
      setRunning(false);
    }
  };

  // Prefer the just-run result; otherwise derive a view from the latest stored run.
  const storedDrift: DriftRow[] = (stored ?? [])
    .filter((r) => r.status === 'drift')
    .map((r) => ({
      customer_id: r.customer_id,
      full_name: null,
      email: null,
      hub_balance: Number(r.hub_balance ?? 0),
      shopify_balance: Number(r.shopify_balance ?? 0),
      delta: Number(r.delta ?? 0),
    }));
  const storedUnreadable: UnreadableRow[] = (stored ?? [])
    .filter((r) => r.status === 'shopify_unreadable')
    .map((r) => ({ customer_id: r.customer_id, full_name: null, detail: r.detail }));

  const view = result
    ? {
        source: 'live' as const,
        checkedAt: null as string | null,
        checked: result.checked,
        matched: result.matched,
        drift: result.drift,
        unreadable: result.unreadable,
        failedSyncs: result.failed_syncs,
      }
    : (stored && stored.length > 0)
      ? {
          source: 'stored' as const,
          checkedAt: stored[0].checked_at,
          checked: stored.length,
          matched: stored.filter((r) => r.status === 'match').length,
          drift: storedDrift,
          unreadable: storedUnreadable,
          failedSyncs: [] as FailedSyncRow[],
        }
      : null;

  const isClean =
    view &&
    view.drift.length === 0 &&
    view.unreadable.length === 0 &&
    view.failedSyncs.length === 0;

  return (
    <div className="space-y-6">
      {/* Header + run button */}
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-2">
            <ShieldCheck className="h-4 w-4 text-primary mt-0.5" />
            <div>
              <h3 className="text-sm font-semibold text-card-foreground">Store Credit Reconciliation</h3>
              <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
                The Hub is the single source of truth for store credit; Shopify is a mirror.
                This report compares the two and surfaces any drift. It runs automatically each
                night, or you can run it on demand.
              </p>
            </div>
          </div>
          {isAdmin && (
            <button
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-primary/30 text-primary hover:bg-primary/10 disabled:opacity-50 shrink-0"
              disabled={running}
              onClick={runNow}
            >
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Run reconciliation now
            </button>
          )}
        </div>

        {/* Report-only notice — this page never repairs. */}
        <div className="mt-4 rounded-lg border border-info/20 bg-info/10 p-3 flex items-start gap-2">
          <Info className="h-3.5 w-3.5 text-info mt-0.5 shrink-0" />
          <p className="text-[11px] text-info leading-relaxed">
            This report is <strong>read-only by design</strong>. It never repairs drift automatically —
            over the past week the Hub has been the correct side in some cases and Shopify in others,
            so auto-healing would destroy correct data. A human must diagnose each delta and decide.
          </p>
        </div>

        {runError && (
          <div className="mt-4 rounded-md p-3 bg-destructive/10 border border-destructive/20 text-sm text-destructive">
            {runError}
          </div>
        )}
      </div>

      {/* Loading the stored run */}
      {!view && storedLoading && (
        <div className="rounded-xl border border-border bg-card p-6 flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-primary mr-2" />
          <span className="text-sm text-muted-foreground">Loading latest reconciliation…</span>
        </div>
      )}

      {/* No stored run and nothing run yet */}
      {!view && !storedLoading && (
        <div className="rounded-xl border border-border bg-card p-6 text-center py-10">
          <p className="text-sm text-muted-foreground">
            No reconciliation has been run yet.
            {isAdmin ? ' Click “Run reconciliation now” to check the Hub against Shopify.' : ''}
          </p>
        </div>
      )}

      {view && (
        <>
          {/* Summary strip */}
          <div className="rounded-xl border border-border bg-card p-6">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Summary</h4>
              <span className="text-[11px] text-muted-foreground">
                {view.source === 'live'
                  ? 'Just now'
                  : `Latest stored run · ${fmtDateTime(view.checkedAt)}`}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              <SummaryStat label="Checked" value={view.checked} />
              <SummaryStat label="Matched" value={view.matched} />
              <SummaryStat label="Drift" value={view.drift.length} loud />
              <SummaryStat label="Unreadable" value={view.unreadable.length} />
              <SummaryStat label="Failed syncs" value={view.failedSyncs.length} loud />
            </div>
            {view.source === 'stored' && (
              <p className="text-[10px] text-muted-foreground mt-3 flex items-center gap-1">
                <Info className="h-3 w-3" />
                Showing the latest stored run. Failed-sync signals are only computed on a fresh run.
              </p>
            )}
          </div>

          {/* All clear */}
          {isClean && (
            <div className="rounded-xl border border-success/30 bg-success/10 p-6 flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5 text-success shrink-0" />
              <div>
                <p className="text-sm font-semibold text-success">Hub and Shopify are in sync</p>
                <p className="text-xs text-success/80 mt-0.5">
                  No drift, no unreadable customers, and no failed pushes to Shopify.
                </p>
              </div>
            </div>
          )}

          {/* DRIFT TABLE */}
          {view.drift.length > 0 && (
            <div className="rounded-xl border border-destructive/30 bg-card p-6">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                <h4 className="text-sm font-semibold text-destructive">
                  Drift — {view.drift.length} customer{view.drift.length !== 1 ? 's' : ''}
                </h4>
              </div>
              <p className="text-[11px] text-muted-foreground mb-4">
                The Hub and Shopify balances disagree. A positive delta means the Hub has more; a
                negative delta means Shopify has more.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="text-left py-2 px-3 font-medium text-xs">Customer</th>
                      <th className="text-right py-2 px-3 font-medium text-xs">Hub balance</th>
                      <th className="text-right py-2 px-3 font-medium text-xs">Shopify balance</th>
                      <th className="text-right py-2 px-3 font-medium text-xs">Delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.drift.map((d) => (
                      <tr key={d.customer_id} className="border-b border-border/50 hover:bg-muted/30">
                        <td className="py-2.5 px-3">
                          <span className="text-foreground font-medium">{d.full_name || d.customer_id}</span>
                          {d.email && (
                            <span className="block text-[11px] text-muted-foreground">{d.email}</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-foreground">
                          {formatCurrency(Number(d.hub_balance ?? 0), 'JPY')}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-foreground">
                          {formatCurrency(Number(d.shopify_balance ?? 0), 'JPY')}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <DeltaCell delta={Number(d.delta ?? 0)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* FAILED SYNCS TABLE */}
          {view.failedSyncs.length > 0 && (
            <div className="rounded-xl border border-destructive/30 bg-card p-6">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                <h4 className="text-sm font-semibold text-destructive">
                  Failed syncs — {view.failedSyncs.length}
                </h4>
              </div>
              <p className="text-[11px] text-muted-foreground mb-4">
                Pushes to Shopify that did not land (pending or failed). These are known drift until resolved.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="text-left py-2 px-3 font-medium text-xs">Date</th>
                      <th className="text-left py-2 px-3 font-medium text-xs">Direction</th>
                      <th className="text-right py-2 px-3 font-medium text-xs">Amount</th>
                      <th className="text-left py-2 px-3 font-medium text-xs">Status</th>
                      <th className="text-left py-2 px-3 font-medium text-xs">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.failedSyncs.map((s) => (
                      <tr key={s.id} className="border-b border-border/50 hover:bg-muted/30 align-top">
                        <td className="py-2.5 px-3 text-xs text-muted-foreground whitespace-nowrap">{fmtDateTime(s.created_at)}</td>
                        <td className="py-2.5 px-3 capitalize">{s.direction || '—'}</td>
                        <td className="py-2.5 px-3 text-right tabular-nums">
                          {s.amount != null ? formatCurrency(Number(s.amount), 'JPY') : '—'}
                        </td>
                        <td className="py-2.5 px-3">
                          <span className="text-xs font-medium text-destructive capitalize">{s.status || '—'}</span>
                        </td>
                        <td className="py-2.5 px-3 text-[11px] text-muted-foreground max-w-md break-words">
                          {s.error_detail || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* UNREADABLE TABLE */}
          {view.unreadable.length > 0 && (
            <div className="rounded-xl border border-warning/30 bg-card p-6">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="h-4 w-4 text-warning" />
                <h4 className="text-sm font-semibold text-warning">
                  Unreadable — {view.unreadable.length} customer{view.unreadable.length !== 1 ? 's' : ''}
                </h4>
              </div>
              <p className="text-[11px] text-muted-foreground mb-4">
                The Shopify balance could not be read for these customers. Their drift status is unknown.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="text-left py-2 px-3 font-medium text-xs">Customer</th>
                      <th className="text-left py-2 px-3 font-medium text-xs">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.unreadable.map((u) => (
                      <tr key={u.customer_id} className="border-b border-border/50 hover:bg-muted/30 align-top">
                        <td className="py-2.5 px-3 text-foreground font-medium">{u.full_name || u.customer_id}</td>
                        <td className="py-2.5 px-3 text-[11px] text-muted-foreground max-w-md break-words">{u.detail || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
