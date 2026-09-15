import { Link } from 'react-router-dom';
import { LinkIcon, Link2Off } from 'lucide-react';
import {
  PORTAL_TOKEN_LABEL, formatPhtDay, portalTokenTone, usePortalTokenHealth,
} from '@/hooks/usePortalTokenHealth';

/**
 * Two faces of one signal (portal_token_expiry_report, 60-day window):
 *   <PortalTokenPill />    sidebar footer, beside the email pill
 *   <PortalTokenBanner />  dashboard, renders only when something is wrong
 *
 * The worklist itself lives in CSR Monitoring → Portal links, not here: a list
 * of hundreds of customers is a worklist, and worklists already have a home.
 * This is only the "something needs attention" signal, in the two places staff
 * already look for exactly that.
 *
 * Added 2026-09-15, after 447 of 632 active portal tokens were found 30 days
 * from lapsing — 195 on one Sunday — with nothing in the Hub watching.
 */

const PORTAL_TOKEN_LINK = '/monitoring?tab=portal-links';

const TONE_TEXT = { ok: 'text-success', warn: 'text-warning', bad: 'text-destructive', muted: 'text-muted-foreground' } as const;
const TONE_DOT = { ok: 'bg-success', warn: 'bg-warning', bad: 'bg-destructive', muted: 'bg-muted-foreground' } as const;

export function PortalTokenPill({ enabled = true }: { enabled?: boolean }) {
  const { data, isLoading, isError } = usePortalTokenHealth(60, enabled);
  if (!enabled) return null;
  const status = isError ? 'unknown' : data?.status;
  const tone = portalTokenTone(status);
  const label = isLoading ? 'Checking portal links…' : PORTAL_TOKEN_LABEL[status ?? 'unknown'];
  const detail = data && data.status !== 'ok' && data.expiring_in_window > 0
    ? ` · ${data.expiring_in_window}`
    : '';
  return (
    <Link
      to={PORTAL_TOKEN_LINK}
      data-testid="portal-token-pill"
      className={`mt-1 flex items-center justify-center gap-1.5 text-[10px] select-none transition-colors hover:text-white/80 ${TONE_TEXT[tone]}`}
      title="Customer portal links approaching expiry, next 60 days. Click for the list."
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${TONE_DOT[tone]} ${tone === 'bad' ? 'animate-pulse' : ''}`} />
      {label}{detail}
    </Link>
  );
}

export function PortalTokenBanner() {
  const { data } = usePortalTokenHealth(60);
  if (!data || data.status === 'ok') return null;
  const bad = data.status === 'urgent' || data.status === 'expired';
  const Icon = bad ? Link2Off : LinkIcon;

  // The peak day leads. "195 lapse on 19 Mar" is a sentence someone can
  // schedule work against; "447 within 60 days" is not.
  const peak = data.peak_day && data.peak_day_count > 0
    ? `${data.peak_day_count} of them on ${formatPhtDay(data.peak_day)}`
    : null;

  return (
    <div
      data-testid="portal-token-banner"
      className={`flex flex-col gap-2 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between ${bad ? 'border-destructive/50 bg-destructive/10' : 'border-warning/50 bg-warning/10'}`}
      role="alert"
    >
      <div className="flex items-start gap-3">
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${bad ? 'text-destructive' : 'text-warning'}`} />
        <div className="text-sm">
          <p className="font-medium">{PORTAL_TOKEN_LABEL[data.status]}</p>
          <p className="text-muted-foreground">
            {data.expiring_in_window} customer link{data.expiring_in_window === 1 ? '' : 's'} lapse within {data.window_days} days
            {peak ? `, ${peak}` : ''}.{' '}
            {data.expiring_in_window_with_live_plan > 0 && (
              <>
                <strong>{data.expiring_in_window_with_live_plan}</strong> are held by customers with a layaway plan still running.
              </>
            )}
          </p>
          {/*
            The fire-and-forget last-seen write is the one thing here that can
            fail silently, and a stuck zero would mean the deferred lifecycle
            question is losing data again. Say so where someone will see it.
          */}
          {data.tokens_with_any_last_seen === 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              No portal visit has been recorded since {data.last_seen_recording_since}. If that stays at zero, last-seen recording has stopped working.
            </p>
          )}
        </div>
      </div>
      <Link
        to={PORTAL_TOKEN_LINK}
        className="shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-background/50"
      >
        See who
      </Link>
    </div>
  );
}
