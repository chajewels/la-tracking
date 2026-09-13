import { Link } from 'react-router-dom';
import { Mail, MailWarning, MailX, Loader2, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import {
  EMAIL_HEALTH_LABEL, EMAIL_HEALTH_QUERY_KEY, emailHealthTone, formatUtcShort, useEmailHealth,
  type EmailDeliveryReport,
} from '@/hooks/useEmailHealth';

/**
 * Three faces of one signal (email_delivery_report, last 24h):
 *   <EmailHealthPill />    sidebar footer, always visible to staff
 *   <EmailHealthBanner />  dashboard, renders only when something is wrong
 *   <EmailHealthCard />    Settings → General, the numbers + "Run check now"
 * Added 2026-09-13 so an outage like the nine-day missing_unsubscribe refusal
 * can never run silently again.
 */

const EMAIL_HEALTH_LINK = '/settings?tab=general#email-health';

const TONE_TEXT = { ok: 'text-success', warn: 'text-warning', bad: 'text-destructive', muted: 'text-muted-foreground' } as const;
const TONE_DOT = { ok: 'bg-success', warn: 'bg-warning', bad: 'bg-destructive', muted: 'bg-muted-foreground' } as const;

export function EmailHealthPill({ enabled = true }: { enabled?: boolean }) {
  const { data, isLoading, isError } = useEmailHealth(24, enabled);
  if (!enabled) return null;
  const status = isError ? 'unknown' : data?.status;
  const tone = emailHealthTone(status);
  const label = isLoading ? 'Checking email…' : EMAIL_HEALTH_LABEL[status ?? 'unknown'];
  const detail = data?.status === 'refused' && data.refusal_streak_started_at
    ? ` since ${formatUtcShort(data.refusal_streak_started_at)}`
    : data?.status === 'ok' && data.last_sent_at
      ? ` · last ${formatUtcShort(data.last_sent_at)}`
      : '';
  return (
    <Link
      to={EMAIL_HEALTH_LINK}
      data-testid="email-health-pill"
      className={`mt-1 flex items-center justify-center gap-1.5 text-[10px] select-none transition-colors hover:text-white/80 ${TONE_TEXT[tone]}`}
      title="Email delivery, last 24 hours. Click for details."
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${TONE_DOT[tone]} ${tone === 'bad' ? 'animate-pulse' : ''}`} />
      {label}{detail}
    </Link>
  );
}

export function EmailHealthBanner() {
  const { data } = useEmailHealth(24);
  if (!data || data.status === 'ok') return null;
  const bad = data.status === 'refused';
  const Icon = bad ? MailX : MailWarning;
  return (
    <div
      data-testid="email-health-banner"
      className={`flex flex-col gap-2 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between ${bad ? 'border-destructive/50 bg-destructive/10' : 'border-warning/50 bg-warning/10'}`}
      role="alert"
    >
      <div className="flex items-start gap-3">
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${bad ? 'text-destructive' : 'text-warning'}`} />
        <div>
          <p className="text-sm font-semibold text-card-foreground">
            {EMAIL_HEALTH_LABEL[data.status]}
            {bad && data.refusal_streak_started_at ? ` since ${formatUtcShort(data.refusal_streak_started_at)}` : ''}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Last 24h: {data.expected_total} customer emails expected, {data.sent} accepted, {data.failed} refused.
            {data.newest_request_id ? ` Newest request_id ${data.newest_request_id}.` : ''}
            {data.status === 'silent' ? ' Events happened but no send attempt was logged — a sender is bypassing the log.' : ''}
          </p>
        </div>
      </div>
      <Link to={EMAIL_HEALTH_LINK} className="text-xs font-semibold text-primary underline-offset-2 hover:underline whitespace-nowrap">
        Open email delivery
      </Link>
    </div>
  );
}

const EXPECTED_LABELS: Record<string, string> = {
  payment_reminders: 'Payment reminders',
  layaway_payment_confirmations: 'Layaway payment confirmations',
  cash_payment_confirmations: 'Cash-order payment confirmations',
  portal_submission_acknowledgements: 'Portal submission acknowledgements',
  payment_rejections: 'Payment rejections',
  penalties_applied: 'Penalties applied',
  waivers_approved: 'Waivers approved',
  accounts_forfeited: 'Accounts forfeited',
  loyalty_events: 'Loyalty events',
  loyalty_pre_expiry_warnings: 'Loyalty pre-expiry warnings',
  web_orders_placed: 'Web orders placed',
  web_orders_closed: 'Web orders cancelled or expired',
};

export function EmailHealthCard() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useEmailHealth(24);
  const [running, setRunning] = useState(false);
  const tone = emailHealthTone(isError ? 'unknown' : data?.status);

  async function runNow() {
    setRunning(true);
    try {
      const { data: res, error: fnErr } = await supabase.functions.invoke<{ error?: string; status?: string }>('email-health-check');
      if (fnErr) throw fnErr;
      if (res?.error) throw new Error(res.error);
      toast.success(`Email delivery check: ${EMAIL_HEALTH_LABEL[(res?.status ?? 'unknown') as keyof typeof EMAIL_HEALTH_LABEL] ?? 'done'}`);
      qc.invalidateQueries({ queryKey: EMAIL_HEALTH_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ['staff-notifications'] });
    } catch (e) {
      toast.error((e as Error).message || 'Check failed');
    } finally {
      setRunning(false);
    }
  }

  const expected = (data?.expected ?? {}) as EmailDeliveryReport['expected'];

  return (
    <div id="email-health" className="rounded-xl border border-border bg-card p-5 space-y-4" data-testid="email-health-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Mail className={`h-4 w-4 ${TONE_TEXT[tone]}`} />
          <div>
            <h3 className="text-sm font-semibold text-card-foreground">Email delivery</h3>
            <p className="text-[11px] text-muted-foreground">
              Customer emails expected against attempts accepted by the email API, last 24 hours. Checked daily at 08:50 PHT; every refusal raises a staff notification at once.
            </p>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={runNow} disabled={running} className="shrink-0">
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          <span className="ml-1.5">Run check now</span>
        </Button>
      </div>

      {isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
      {isError && <p className="text-xs text-destructive">Could not load: {(error as Error)?.message}</p>}

      {data && (
        <>
          <div className={`flex items-center gap-2 text-sm font-semibold ${TONE_TEXT[tone]}`}>
            <span className={`inline-block h-2 w-2 rounded-full ${TONE_DOT[tone]}`} />
            {EMAIL_HEALTH_LABEL[data.status]}
            {data.status === 'refused' && data.refusal_streak_started_at && (
              <span className="font-normal text-muted-foreground">since {formatUtcShort(data.refusal_streak_started_at)}</span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Expected', value: data.expected_total },
              { label: 'Accepted', value: data.sent },
              { label: 'Refused', value: data.failed },
              { label: 'Suppressed', value: data.suppressed },
            ].map(s => (
              <div key={s.label} className="rounded-lg bg-muted/30 p-2.5">
                <p className="text-lg font-bold text-card-foreground tabular-nums">{s.value}</p>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{s.label}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            {Object.entries(expected).map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between border-b border-border/40 py-1">
                <span className="text-muted-foreground">{EXPECTED_LABELS[k] ?? k}</span>
                <span className="tabular-nums text-card-foreground">{v}</span>
              </div>
            ))}
            <div className="flex items-baseline justify-between border-b border-border/40 py-1">
              <span className="text-muted-foreground">Storefront accepted / refused</span>
              <span className="tabular-nums text-card-foreground">{data.storefront?.sent ?? 0} / {data.storefront?.failed ?? 0}</span>
            </div>
            <div className="flex items-baseline justify-between border-b border-border/40 py-1">
              <span className="text-muted-foreground">Last accepted send</span>
              <span className="tabular-nums text-card-foreground">{formatUtcShort(data.last_sent_at)}</span>
            </div>
          </div>

          {data.newest_error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
              <p className="font-semibold text-destructive">Newest refusal{data.newest_request_id ? ` · request_id ${data.newest_request_id}` : ''} · {formatUtcShort(data.last_failure_at)}</p>
              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{data.newest_error}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
