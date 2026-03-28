import { useState } from 'react';
import { CheckCircle, XCircle, Minus, RefreshCw, Loader2, ChevronDown, ChevronRight, Database, Bookmark, Cpu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { Link } from 'react-router-dom';

interface AffectedAccount {
  account_id: string;
  invoice_number: string;
  customer_name: string;
  detail: string;
}

interface CheckResult {
  id: number;
  section: 'data' | 'benchmark' | 'system';
  label: string;
  description: string;
  status: 'pass' | 'fail' | 'skip';
  expected: string;
  affectedCount: number;
  affectedAccounts: AffectedAccount[];
}

interface HealthSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  elapsed_ms: number;
}

interface HealthData {
  checks: CheckResult[];
  summary: HealthSummary;
  timestamp: string;
}

const SECTION_META = {
  data:      { label: 'Data Integrity',         icon: Database,  color: 'text-primary' },
  benchmark: { label: 'Benchmark Verification',  icon: Bookmark,  color: 'text-info' },
  system:    { label: 'System Functions',         icon: Cpu,       color: 'text-warning' },
} as const;

function StatusIcon({ status }: { status: CheckResult['status'] }) {
  if (status === 'pass') return <CheckCircle className="h-4 w-4 text-success flex-shrink-0" />;
  if (status === 'fail') return <XCircle className="h-4 w-4 text-destructive flex-shrink-0" />;
  return <Minus className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
}

function CheckRow({ check }: { check: CheckResult }) {
  const [open, setOpen] = useState(false);
  const hasFailed = check.status === 'fail' && check.affectedAccounts.length > 0;

  return (
    <div className={`rounded-lg border transition-colors ${
      check.status === 'pass' ? 'border-success/40 bg-zinc-900' :
      check.status === 'fail' ? 'border-destructive/40 bg-zinc-900' :
      'border-zinc-700 bg-zinc-900'
    }`}>
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
              <Badge variant="outline" className="text-[9px] h-4 px-1.5 bg-zinc-700 text-muted-foreground border-zinc-600">
                skipped
              </Badge>
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
                <Link
                  to={acc.account_id ? `/accounts/${acc.account_id}` : '#'}
                  className="font-mono font-semibold text-primary hover:underline flex-shrink-0 w-16"
                  onClick={e => e.stopPropagation()}
                >
                  #{acc.invoice_number}
                </Link>
                <span className="text-muted-foreground truncate flex-1">{acc.customer_name}</span>
                <span className="text-card-foreground text-right flex-shrink-0 max-w-[200px] truncate">{acc.detail}</span>
              </div>
            ))}
            {check.affectedAccounts.length > 50 && (
              <p className="text-[10px] text-muted-foreground pt-1">
                … and {check.affectedAccounts.length - 50} more
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SystemHealthCheckPanel() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: result, error: err } = await supabase.functions.invoke('system-health-v2');
      if (err) throw err;
      setData(result as HealthData);
    } catch (e: any) {
      setError(e.message || 'Health check failed');
    } finally {
      setLoading(false);
    }
  };

  const sections = (['data', 'benchmark', 'system'] as const);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-card-foreground">System Health Check</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Read-only — 12 automated checks across data integrity, benchmarks, and system functions
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data && (
            <p className="text-[10px] text-muted-foreground">
              Last run: {new Date(data.timestamp).toLocaleTimeString()} · {data.summary.elapsed_ms}ms
            </p>
          )}
          <Button onClick={run} disabled={loading} size="sm" className="gap-1.5">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {loading ? 'Running…' : data ? 'Re-run Checks' : 'Run All Checks'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-zinc-900 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Score card */}
      {data && (
        <div className={`rounded-xl border p-4 ${
          data.summary.failed === 0
            ? 'border-success/40 bg-zinc-900'
            : 'border-destructive/40 bg-zinc-900'
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {data.summary.failed === 0
                ? <CheckCircle className="h-6 w-6 text-success" />
                : <XCircle className="h-6 w-6 text-destructive" />
              }
              <div>
                <p className="text-lg font-bold text-card-foreground font-display">
                  {data.summary.passed + data.summary.skipped}/{data.summary.total} checks passed
                </p>
                <p className="text-xs text-muted-foreground">
                  {data.summary.failed === 0
                    ? 'System healthy — no issues found'
                    : `${data.summary.failed} issue${data.summary.failed > 1 ? 's' : ''} found — see details below`}
                </p>
              </div>
            </div>
            <div className="flex gap-4 text-center">
              <div>
                <p className="text-xl font-bold text-success">{data.summary.passed}</p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Passed</p>
              </div>
              <div>
                <p className={`text-xl font-bold ${data.summary.failed > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {data.summary.failed}
                </p>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Failed</p>
              </div>
              {data.summary.skipped > 0 && (
                <div>
                  <p className="text-xl font-bold text-muted-foreground">{data.summary.skipped}</p>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Skipped</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Checks by section */}
      {data && sections.map(section => {
        const sectionChecks = data.checks.filter(c => c.section === section);
        const meta = SECTION_META[section];
        const Icon = meta.icon;
        const sectionFailed = sectionChecks.filter(c => c.status === 'fail').length;

        return (
          <div key={section} className="space-y-2">
            <div className="flex items-center gap-2">
              <Icon className={`h-3.5 w-3.5 ${meta.color}`} />
              <h3 className={`text-xs font-semibold uppercase tracking-wider ${meta.color}`}>
                {meta.label}
              </h3>
              {sectionFailed > 0 && (
                <Badge variant="outline" className="text-[9px] h-4 px-1.5 bg-zinc-900 text-destructive border-destructive/40">
                  {sectionFailed} failed
                </Badge>
              )}
            </div>
            <div className="space-y-1.5">
              {sectionChecks.map(check => <CheckRow key={check.id} check={check} />)}
            </div>
          </div>
        );
      })}

      {/* Empty state */}
      {!data && !loading && !error && (
        <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-12 text-center">
          <RefreshCw className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm font-medium text-card-foreground">No results yet</p>
          <p className="text-xs text-muted-foreground mt-1">Click "Run All Checks" to scan the system</p>
        </div>
      )}

      {loading && (
        <div className="space-y-1.5">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="h-14 rounded-lg border border-zinc-700 bg-zinc-900 animate-pulse" />
          ))}
        </div>
      )}
    </div>
  );
}
