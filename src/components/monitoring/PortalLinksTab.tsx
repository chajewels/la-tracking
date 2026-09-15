import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Link2Off, ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  formatPhtDay, usePortalTokenHealth, usePortalTokenList, type PortalTokenRow,
} from '@/hooks/usePortalTokenHealth';

/**
 * Who is about to lose their portal link.
 *
 * THE LIST LIVES HERE, not in the notification and not in Settings. The bell
 * shows 20 notifications, so an alert naming hundreds of customers would bury
 * everything else; and a list of hundreds of customers to work through is a
 * worklist, which is what this page is for. The alert carries counts and the
 * peak day, and points here.
 *
 * ORDER IS THE ORDER TO WORK IT IN: live plans first, then soonest to lapse.
 * A customer mid-plan who cannot open their schedule is a different problem
 * from a dormant one with a stale link.
 *
 * Regenerating is still one customer at a time, from the customer's own page —
 * bulk regeneration is deliberately not part of this change.
 */

const WINDOWS = [30, 60, 90, 400] as const;

export default function PortalLinksTab() {
  const [days, setDays] = useState<number>(60);
  const { data: report } = usePortalTokenHealth(days);
  const { data: rows, isLoading, isError } = usePortalTokenList(days);

  const { livePlan, dormant } = useMemo(() => {
    const all = rows ?? [];
    return {
      livePlan: all.filter(r => r.has_live_plan),
      dormant: all.filter(r => !r.has_live_plan),
    };
  }, [rows]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-3 text-base">
            <Link2Off className="h-4 w-4" />
            Portal links approaching expiry
            <span className="ml-auto flex gap-1">
              {WINDOWS.map(w => (
                <Button
                  key={w}
                  size="sm"
                  variant={days === w ? 'default' : 'outline'}
                  onClick={() => setDays(w)}
                  className="h-7 px-2 text-xs"
                >
                  {w === 400 ? 'All' : `${w}d`}
                </Button>
              ))}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {report && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Figure label="Expiring" value={report.expiring_in_window} />
                <Figure label="With a live plan" value={report.expiring_in_window_with_live_plan} emphasis />
                <Figure label="Worst single day" value={report.peak_day_count} sub={formatPhtDay(report.peak_day)} />
                <Figure label="Active links" value={report.active_tokens} />
              </div>
              {/*
                The fire-and-forget last-seen write is the only thing here that
                can fail without anyone noticing, and a stuck zero means the
                deferred mint-vs-use question is losing data again.
              */}
              <p className="text-xs text-muted-foreground">
                {report.tokens_with_any_last_seen === 0
                  ? `No portal visit recorded since ${report.last_seen_recording_since}. If this stays at zero, last-seen recording has stopped working.`
                  : `${report.tokens_with_any_last_seen} of ${report.active_tokens} links have recorded a visit since ${report.last_seen_recording_since}.`}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}
      {isError && <p className="text-sm text-destructive">Could not load the list.</p>}

      {!isLoading && !isError && (
        <>
          <Section
            title="Customers with a plan still running"
            note="Work these first — a lapsed link here means someone mid-plan cannot see their schedule."
            rows={livePlan}
          />
          <Section
            title="No plan running"
            note="Their link still lapses, but nothing is in flight behind it."
            rows={dormant}
          />
        </>
      )}
    </div>
  );
}

function Figure({ label, value, sub, emphasis }: { label: string; value: number; sub?: string; emphasis?: boolean }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`font-display text-2xl ${emphasis ? 'text-warning' : ''}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Section({ title, note, rows }: { title: string; note: string; rows: PortalTokenRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title} <span className="text-muted-foreground">({rows.length})</span></CardTitle>
        <p className="text-xs text-muted-foreground">{note}</p>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b">
              <th className="p-3 text-left font-normal">Customer</th>
              <th className="p-3 text-left font-normal">Link expires</th>
              <th className="p-3 text-left font-normal">Last portal visit</th>
              <th className="p-3 text-left font-normal">Contact</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.token_id} className="border-b last:border-0">
                <td className="p-3">
                  <Link to={`/customers/${r.customer_id}`} className="inline-flex items-center gap-1 hover:underline">
                    {r.full_name ?? '—'} <ExternalLink className="h-3 w-3 opacity-50" />
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {r.customer_code ?? '—'}
                    {r.live_plan_count > 0 && ` · ${r.live_plan_count} plan${r.live_plan_count === 1 ? '' : 's'}`}
                    {/* A customer with a password does not lose access when the
                        token lapses — they are on the list, but they are not
                        the urgent part of it. */}
                    {r.has_password && <Badge variant="outline" className="ml-2 text-[10px]">has password</Badge>}
                  </div>
                </td>
                <td className="p-3 whitespace-nowrap">
                  {formatPhtDay(r.expires_at)}
                  <span className="ml-2 text-xs text-muted-foreground">{r.days_left}d</span>
                </td>
                <td className="p-3 whitespace-nowrap text-muted-foreground">
                  {r.last_used_at
                    ? <>{formatPhtDay(r.last_used_at)}{r.use_count > 0 && <span className="ml-1 text-xs">· {r.use_count}×</span>}</>
                    : <span className="text-xs">not since recording began</span>}
                </td>
                <td className="p-3 text-xs text-muted-foreground">
                  {r.email || r.mobile_number || <span className="text-destructive">no email or mobile</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
