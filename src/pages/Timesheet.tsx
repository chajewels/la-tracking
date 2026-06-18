import { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Loader2, LogIn, LogOut, Pencil, Clock, Copy, ClipboardPaste } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { getPHTToday } from '@/lib/date-utils';
import {
  TemplateType, TimesheetProfile, TimesheetEntry, MonthCostRow,
  TEMPLATE_LABEL,
  computeMonth, computeConsolidation, computeAllMonthsSummary, monthLabelFromKey, monthKeyFromDate, addDays, TIMESHEET_ROWS,
  isoDowOf, formatPHP, formatPHP2, formatHours,
} from '@/lib/timesheetEngine';

const DOW_LABELS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ALL_DOW = [1, 2, 3, 4, 5, 6, 7];

// Out-punches before this local hour close the PRIOR day's shift: the workday
// runs 08:00 → 00:00, so an early-hours out-punch belongs to last night.
const OVERNIGHT_CUTOFF = 8;

// ── Month + timezone helpers ────────────────────────────────────────────────

/** Current 'YYYY-MM' in PHT. */
function currentMonthKey(): string {
  return getPHTToday().slice(0, 7);
}

/** List of selectable month keys: 12 months back through current. */
function monthOptions(): string[] {
  const out: string[] = [];
  const [y, m] = currentMonthKey().split('-').map(Number);
  for (let i = 0; i < 12; i++) {
    const d = new Date(y, m - 1 - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** Offset (ms) such that asUTC(localFieldsOf(date in tz)) − date = offset. */
function getTzOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    Number(map.hour), Number(map.minute), Number(map.second),
  );
  return asUTC - date.getTime();
}

/** Convert a wall-clock 'HH:MM' on `workDate` in `tz` to a UTC ISO instant. */
function zonedWallToISO(workDate: string, hhmm: string, tz: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = workDate.split('-').map(Number);
  const naiveUTC = Date.UTC(y, mo - 1, d, h || 0, m || 0, 0);
  const offset = getTzOffsetMs(new Date(naiveUTC), tz);
  return new Date(naiveUTC - offset).toISOString();
}

/** Extract 'HH:MM' wall-clock in `tz` from a timestamptz ISO. */
function isoToWall(iso: string | null, tz: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit',
  }).format(d);
}

type PunchField = 'am_in' | 'am_out' | 'pm_in' | 'pm_out';
const PUNCH_FIELDS: PunchField[] = ['am_in', 'am_out', 'pm_in', 'pm_out'];

// ── Tab: My Timesheet ───────────────────────────────────────────────────────

function MyTimesheetTab({
  profile, entries, monthKey, onMonthChange, onEntrySaved, userId,
}: {
  profile: TimesheetProfile | null;
  entries: TimesheetEntry[];
  monthKey: string;
  onMonthChange: (k: string) => void;
  onEntrySaved: (entry: TimesheetEntry) => void;
  userId: string;
}) {
  const [busy, setBusy] = useState(false);

  const month = useMemo(
    () => (profile ? computeMonth(monthKey, entries, profile) : null),
    [profile, entries, monthKey],
  );

  const tz = profile?.timezone || 'Asia/Manila';
  const today = getPHTToday();

  const entryByDate = useMemo(() => {
    const map = new Map<string, TimesheetEntry>();
    for (const e of entries) map.set(e.work_date, e);
    return map;
  }, [entries]);

  // Upsert a single punch/edit field onto today's (or a given date's) row.
  const writeField = useCallback(async (workDate: string, field: PunchField, iso: string | null) => {
    setBusy(true);
    try {
      const client = supabase as any;
      const existing = entryByDate.get(workDate);
      const payload: Record<string, unknown> = {
        user_id: userId,
        work_date: workDate,
        [field]: iso,
      };
      // Carry forward the other fields so an upsert doesn't clobber them.
      if (existing) {
        for (const f of PUNCH_FIELDS) {
          if (f !== field) payload[f] = existing[f];
        }
      }
      const { error } = await client
        .from('timesheet_entries')
        .upsert(payload, { onConflict: 'user_id,work_date' });
      if (error) throw error;
      // Update local state in place — no global reload, so the grid never
      // unmounts mid-edit. The row we just wrote is authoritative.
      const saved: TimesheetEntry = {
        work_date: workDate,
        am_in: existing?.am_in ?? null,
        am_out: existing?.am_out ?? null,
        pm_in: existing?.pm_in ?? null,
        pm_out: existing?.pm_out ?? null,
      };
      saved[field] = iso;
      onEntrySaved(saved);
    } catch (err: unknown) {
      toast.error((err as Error)?.message ?? 'Failed to save punch');
    } finally {
      setBusy(false);
    }
  }, [entryByDate, onEntrySaved, userId]);

  // Soft shift-window warning (non-blocking).
  function maybeWarnOutsideShift(hhmm: string) {
    if (!profile?.shift_start && !profile?.shift_end) return;
    const toMin = (s: string) => {
      const [h, m] = s.split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    const now = toMin(hhmm);
    const start = profile.shift_start ? toMin(profile.shift_start) : null;
    const end = profile.shift_end ? toMin(profile.shift_end) : null;
    if ((start != null && now < start - 60) || (end != null && now > end + 60)) {
      toast.warning('Punch is well outside your scheduled shift window.');
    }
  }

  async function punch(kind: 'in' | 'out') {
    if (!profile) return;
    const now = new Date();
    // Hour-of-day in the user's IANA timezone. A 21:48 in Manila lands in PM;
    // an 08:00 lands in AM. Routes by the CURRENT instant, never by which AM
    // slots happen to be empty.
    const hourParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', hour12: false,
    }).formatToParts(now);
    const hour = Number(hourParts.find(p => p.type === 'hour')?.value ?? 0);
    const isPM = hour >= 12;

    const todayEntry = entryByDate.get(today);

    // Overnight close (Option A). Workday runs 08:00 → 00:00, so an out-punch
    // before 08:00 with no open shift today but an unclosed clock-in yesterday
    // belongs to last night. Close yesterday's pm_out, clamped to 23:59 (the
    // day-grid model can't carry a punch past midnight on a single row).
    if (kind === 'out' && hour < OVERNIGHT_CUTOFF) {
      const todayHasOpenIn = !!todayEntry &&
        ((!!todayEntry.am_in && !todayEntry.am_out) || (!!todayEntry.pm_in && !todayEntry.pm_out));
      const yesterday = addDays(today, -1);
      const yEntry = entryByDate.get(yesterday);
      const yesterdayOpenShift = !!yEntry && (!!yEntry.am_in || !!yEntry.pm_in) && !yEntry.pm_out;
      if (!todayHasOpenIn && yesterdayOpenShift) {
        await writeField(yesterday, 'pm_out', zonedWallToISO(yesterday, '23:59', tz));
        toast.success('Punched out — overnight shift closed (recorded 23:59).');
        return;
      }
    }

    const field: PunchField = kind === 'in'
      ? (isPM ? 'pm_in' : 'am_in')
      : (isPM ? 'pm_out' : 'am_out');
    const half = isPM ? 'PM' : 'AM';

    if (todayEntry?.[field]) {
      toast.info(`${half} time-${kind} already recorded.`);
      return;
    }

    // True instant — stored as timestamptz, displayed back in the profile tz.
    const nowIso = now.toISOString();
    maybeWarnOutsideShift(isoToWall(nowIso, tz));
    await writeField(today, field, nowIso);
    toast.success(`Punched ${kind} (${field.replace('_', ' ').toUpperCase()})`);
  }

  function onTimeEdit(workDate: string, field: PunchField, hhmm: string) {
    const iso = hhmm ? zonedWallToISO(workDate, hhmm, tz) : null;
    writeField(workDate, field, iso);
  }

  // ── Copy / paste a day's punch set ──────────────────────────────────────
  // One clipboard slot: the four time-of-day values as HH:mm in the profile
  // tz (blank = ''), extracted exactly the way the grid formats times for
  // editing.
  const [copied, setCopied] = useState<Record<PunchField, string> | null>(null);

  function copyRow(entry: TimesheetEntry | null) {
    setCopied({
      am_in: isoToWall(entry ? entry.am_in : null, tz),
      am_out: isoToWall(entry ? entry.am_out : null, tz),
      pm_in: isoToWall(entry ? entry.pm_in : null, tz),
      pm_out: isoToWall(entry ? entry.pm_out : null, tz),
    });
    toast.success('Punch times copied');
  }

  // Write all four punches of `copied` onto `workDate` in one upsert, through
  // the same path manual edits use (blank → null; non-blank → composed
  // timestamptz in the profile tz).
  const pasteRow = useCallback(async (workDate: string) => {
    if (!copied) return;
    setBusy(true);
    try {
      const client = supabase as any;
      const payload: Record<string, unknown> = { user_id: userId, work_date: workDate };
      for (const f of PUNCH_FIELDS) {
        const hhmm = copied[f];
        payload[f] = hhmm ? zonedWallToISO(workDate, hhmm, tz) : null;
      }
      const { error } = await client
        .from('timesheet_entries')
        .upsert(payload, { onConflict: 'user_id,work_date' });
      if (error) throw error;
      onEntrySaved({
        work_date: workDate,
        am_in: (payload.am_in as string | null) ?? null,
        am_out: (payload.am_out as string | null) ?? null,
        pm_in: (payload.pm_in as string | null) ?? null,
        pm_out: (payload.pm_out as string | null) ?? null,
      });
      toast.success('Punch times pasted');
    } catch (err: unknown) {
      toast.error((err as Error)?.message ?? 'Failed to paste punch');
    } finally {
      setBusy(false);
    }
  }, [copied, onEntrySaved, userId, tz]);

  if (!profile) {
    return (
      <div className="rounded-lg border border-border bg-card p-12 text-center">
        <Clock className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium text-card-foreground">No timesheet assigned</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Ask an admin to assign your timesheet template before you can punch in.
        </p>
      </div>
    );
  }

  // The sheet ALWAYS has 31 rows; shorter months spill into the next.
  const sheetRowCount = month!.days.length;
  const isCsr = profile.template_type === 'csr';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={monthKey} onValueChange={onMonthChange}>
          <SelectTrigger className="h-9 w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {monthOptions().map(k => (
              <SelectItem key={k} value={k}>{monthLabelFromKey(k)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
          {TEMPLATE_LABEL[profile.template_type]}
        </Badge>
        {profile.job_title && <span className="text-xs text-muted-foreground">{profile.job_title}</span>}
        <span className="text-[11px] text-muted-foreground">{tz}</span>
        {monthKey === currentMonthKey() && (
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" onClick={() => punch('in')} disabled={busy} className="h-9 gold-gradient text-primary-foreground">
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <LogIn className="mr-1.5 h-4 w-4" />}
              Time In
            </Button>
            <Button size="sm" variant="outline" onClick={() => punch('out')} disabled={busy} className="h-9">
              <LogOut className="mr-1.5 h-4 w-4" /> Time Out
            </Button>
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-left font-medium">Day</th>
                <th className="px-2 py-2 text-center font-medium">AM In</th>
                <th className="px-2 py-2 text-center font-medium">AM Out</th>
                <th className="px-2 py-2 text-center font-medium">PM In</th>
                <th className="px-2 py-2 text-center font-medium">PM Out</th>
                <th className="px-3 py-2 text-right font-medium">Hours</th>
                <th className="px-3 py-2 text-right font-medium">Salary</th>
                <th className="px-2 py-2 text-center font-medium">Copy</th>
              </tr>
            </thead>
            <tbody>
              {month!.days.map(d => {
                const entry = entryByDate.get(d.date) ?? null;
                const isToday = d.date === today;
                return (
                  <tr
                    key={d.date}
                    className={cn(
                      'border-t border-border',
                      isToday && 'bg-primary/5',
                      !d.isScheduled && 'bg-muted/20',
                    )}
                  >
                    <td className="px-3 py-1.5 tabular-nums text-xs">{d.date.slice(8, 10)}</td>
                    <td className={cn('px-3 py-1.5 text-xs', d.dow >= 6 && 'text-muted-foreground')}>{DOW_LABELS[d.dow]}</td>
                    {PUNCH_FIELDS.map(f => (
                      <td key={f} className="px-1.5 py-1.5 text-center">
                        <Input
                          type="time"
                          value={isoToWall(entry ? entry[f] : null, tz)}
                          onChange={(e) => onTimeEdit(d.date, f, e.target.value)}
                          className="h-7 w-[5.5rem] px-1 text-center text-xs tabular-nums"
                        />
                      </td>
                    ))}
                    <td className="px-3 py-1.5 text-right tabular-nums text-xs">{d.hours > 0 ? formatHours(d.hours) : '—'}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-xs">{d.salary > 0 ? formatPHP2(d.salary) : '—'}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center justify-center gap-1">
                        <Button
                          type="button" size="icon" variant="ghost"
                          className="h-6 w-6 text-muted-foreground hover:text-foreground"
                          title="Copy this day's punch times"
                          onClick={() => copyRow(entry)}
                          disabled={busy}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                        <Button
                          type="button" size="icon" variant="ghost"
                          className="h-6 w-6 text-muted-foreground hover:text-foreground"
                          title={copied ? 'Paste copied punch times here' : 'Copy a day first'}
                          onClick={() => pasteRow(d.date)}
                          disabled={busy || !copied}
                        >
                          <ClipboardPaste className="h-3 w-3" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-muted/30 font-semibold">
                <td className="px-3 py-2 text-xs" colSpan={6}>TOTAL — {sheetRowCount} days</td>
                <td className="px-3 py-2 text-right tabular-nums text-xs">{formatHours(month!.total_hours)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-xs">{formatPHP(month!.gross)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard label="Total Hours" value={formatHours(month!.total_hours)} />
        <SummaryCard label="No. of Day-off" value={String(month!.dayoff_count)} />
        {isCsr ? (
          <>
            <SummaryCard label="Gross (capped)" value={formatPHP(month!.gross)} />
            <SummaryCard
              label="Allowance Paid"
              value={formatPHP(month!.allowance_paid)}
              sub={month!.forfeitedWeeks > 0 ? `${month!.forfeitedWeeks} week(s) forfeited` : undefined}
            />
            <SummaryCard label="Net Pay" value={formatPHP(month!.net)} highlight />
          </>
        ) : (
          <SummaryCard label="Net Pay" value={formatPHP(month!.net)} highlight />
        )}
      </div>
    </div>
  );
}

// ── Tab: Consolidation (admin/finance) ──────────────────────────────────────

function ConsolidationTab({
  profiles, entriesByUser, nameByUser, monthKey, onMonthChange,
}: {
  profiles: TimesheetProfile[];
  entriesByUser: Map<string, TimesheetEntry[]>;
  nameByUser: Map<string, string>;
  monthKey: string;
  onMonthChange: (k: string) => void;
}) {
  const active = useMemo(() => profiles.filter(p => p.active), [profiles]);
  const result = useMemo(
    () => computeConsolidation(monthKey, active, entriesByUser, nameByUser),
    [active, entriesByUser, nameByUser, monthKey],
  );

  return (
    <div className="space-y-4">
      <Select value={monthKey} onValueChange={onMonthChange}>
        <SelectTrigger className="h-9 w-48"><SelectValue /></SelectTrigger>
        <SelectContent>
          {monthOptions().map(k => (
            <SelectItem key={k} value={k}>{monthLabelFromKey(k)}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {result.users.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-12 text-center text-sm text-muted-foreground">
          No active timesheet profiles.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 uppercase text-muted-foreground">
                <tr>
                  <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left font-medium">Date</th>
                  {result.users.map(u => (
                    <th key={u.user_id} colSpan={2} className="px-2 py-2 text-center font-medium border-l border-border">
                      {u.name}
                    </th>
                  ))}
                </tr>
                <tr>
                  <th className="sticky left-0 z-10 bg-muted/40 px-3 py-1 text-left font-medium" />
                  {result.users.map(u => (
                    <Fragment2 key={u.user_id}>
                      <th className="px-2 py-1 text-right font-medium border-l border-border">Hrs</th>
                      <th className="px-2 py-1 text-right font-medium">Salary</th>
                    </Fragment2>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.dates.map(date => (
                  <tr key={date} className="border-t border-border">
                    <td className="sticky left-0 z-10 bg-card px-3 py-1 tabular-nums">
                      {date.slice(8, 10)} {DOW_LABELS[isoDowOf(date)]}
                    </td>
                    {result.users.map(u => {
                      const cell = result.matrix[date][u.user_id];
                      const h = cell?.hours ?? 0;
                      const s = cell?.salary ?? 0;
                      return (
                        <Fragment2 key={u.user_id}>
                          <td className="px-2 py-1 text-right tabular-nums border-l border-border">{h > 0 ? formatHours(h) : '—'}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{s > 0 ? formatPHP2(s) : '—'}</td>
                        </Fragment2>
                      );
                    })}
                  </tr>
                ))}
                <tr className="border-t border-border bg-muted/20 font-medium">
                  <td className="sticky left-0 z-10 bg-muted/20 px-3 py-1.5">ALLOWANCE</td>
                  {result.users.map(u => (
                    <Fragment2 key={u.user_id}>
                      <td className="px-2 py-1.5 text-right tabular-nums border-l border-border text-muted-foreground">—</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{formatPHP(u.allowance_paid)}</td>
                    </Fragment2>
                  ))}
                </tr>
                <tr className="border-t border-border bg-muted/30 font-semibold">
                  <td className="sticky left-0 z-10 bg-muted/30 px-3 py-2">TOTAL (Net / Hrs)</td>
                  {result.users.map(u => (
                    <Fragment2 key={u.user_id}>
                      <td className="px-2 py-2 text-right tabular-nums border-l border-border">{formatHours(u.total_hours)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-primary">{formatPHP(u.net)}</td>
                    </Fragment2>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// React.Fragment passthrough that accepts a key (for paired <td> cells).
function Fragment2({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

// ── Tab: Cost Master (admin) ────────────────────────────────────────────────

function CostMasterTab({
  profiles, entriesByUser, nameByUser, monthKey, onMonthChange,
}: {
  profiles: TimesheetProfile[];
  entriesByUser: Map<string, TimesheetEntry[]>;
  nameByUser: Map<string, string>;
  monthKey: string;
  onMonthChange: (k: string) => void;
}) {
  const active = useMemo(() => profiles.filter(p => p.active), [profiles]);

  const groups = useMemo(() => {
    const order: TemplateType[] = ['live_admin', 'csr'];
    return order.map(template => {
      const rows = active
        .filter(p => p.template_type === template)
        .map(p => {
          const m = computeMonth(monthKey, entriesByUser.get(p.user_id) ?? [], p);
          return {
            user_id: p.user_id,
            name: nameByUser.get(p.user_id) ?? p.user_id,
            total_hours: m.total_hours,
            dailySum: m.gross === m.net ? m.gross : (m.net - m.allowance_paid), // gross (capped) for CSR
            net: m.net,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const subtotalHours = rows.reduce((s, r) => s + r.total_hours, 0);
      const subtotalNet = rows.reduce((s, r) => s + r.net, 0);
      return { template, rows, subtotalHours, subtotalNet };
    }).filter(g => g.rows.length > 0);
  }, [active, entriesByUser, nameByUser, monthKey]);

  const grandNet = useMemo(() => groups.reduce((s, g) => s + g.subtotalNet, 0), [groups]);

  return (
    <div className="space-y-4">
      <Select value={monthKey} onValueChange={onMonthChange}>
        <SelectTrigger className="h-9 w-48"><SelectValue /></SelectTrigger>
        <SelectContent>
          {monthOptions().map(k => (
            <SelectItem key={k} value={k}>{monthLabelFromKey(k)}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {groups.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-12 text-center text-sm text-muted-foreground">
          No active timesheet profiles.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">User</th>
                <th className="px-3 py-2 text-right font-medium">Total Hours</th>
                <th className="px-3 py-2 text-right font-medium">Daily-Salary Sum</th>
                <th className="px-3 py-2 text-right font-medium">Net Pay</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <Fragment2 key={g.template}>
                  <tr className="border-t border-border bg-muted/20">
                    <td colSpan={4} className="px-3 py-1.5 text-xs font-semibold uppercase text-muted-foreground">
                      {TEMPLATE_LABEL[g.template]}
                    </td>
                  </tr>
                  {g.rows.map(r => (
                    <tr key={r.user_id} className="border-t border-border">
                      <td className="px-3 py-2">{r.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatHours(r.total_hours)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatPHP(r.dailySum)}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-primary">{formatPHP(r.net)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-border bg-muted/10 text-xs font-medium">
                    <td className="px-3 py-1.5">Subtotal — {TEMPLATE_LABEL[g.template]}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatHours(g.subtotalHours)}</td>
                    <td className="px-3 py-1.5" />
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatPHP(g.subtotalNet)}</td>
                  </tr>
                </Fragment2>
              ))}
              <tr className="border-t-2 border-primary/40 bg-primary/5 font-semibold">
                <td className="px-3 py-2.5" colSpan={3}>GRAND TOTAL — Monthly Payroll Cost</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-primary">{formatPHP(grandNet)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Tab: Assignments (admin) ────────────────────────────────────────────────

interface StaffRow {
  user_id: string;
  full_name: string;
}

interface ProfileFormState {
  template_type: TemplateType;
  job_title: string;
  timezone: string;
  work_days: number[];
  shift_start: string;
  shift_end: string;
  basic_salary: string;
  allowance: string;
  half_day_rate: string;
  full_day_rate: string;
  full_day_threshold_hours: string;
  dayoff_divisor: string;
  active: boolean;
  can_view_all: boolean;
}

function profileToForm(p: TimesheetProfile | null): ProfileFormState {
  const pv = p as (TimesheetProfile & { can_view_all?: boolean }) | null;
  return {
    template_type: p?.template_type ?? 'csr',
    job_title: p?.job_title ?? '',
    timezone: p?.timezone ?? 'Asia/Manila',
    work_days: p?.work_days ?? [1, 2, 3, 4, 5, 6],
    shift_start: p?.shift_start ? p.shift_start.slice(0, 5) : '',
    shift_end: p?.shift_end ? p.shift_end.slice(0, 5) : '',
    basic_salary: p?.basic_salary != null ? String(p.basic_salary) : '',
    allowance: p?.allowance != null ? String(p.allowance) : '',
    half_day_rate: p?.half_day_rate != null ? String(p.half_day_rate) : '',
    full_day_rate: p?.full_day_rate != null ? String(p.full_day_rate) : '',
    full_day_threshold_hours: p?.full_day_threshold_hours != null ? String(p.full_day_threshold_hours) : '',
    dayoff_divisor: p?.dayoff_divisor != null ? String(p.dayoff_divisor) : '4',
    active: p?.active ?? true,
    can_view_all: pv?.can_view_all ?? false,
  };
}

function AssignmentDialog({
  open, onOpenChange, staff, existing, onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  staff: StaffRow | null;
  existing: TimesheetProfile | null;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ProfileFormState>(profileToForm(null));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setForm(profileToForm(existing));
  }, [open, existing]);

  function upd<K extends keyof ProfileFormState>(key: K, value: ProfileFormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function toggleDay(dow: number) {
    setForm(prev => ({
      ...prev,
      work_days: prev.work_days.includes(dow)
        ? prev.work_days.filter(d => d !== dow)
        : [...prev.work_days, dow].sort((a, b) => a - b),
    }));
  }

  async function save() {
    if (!staff) return;
    const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));
    setSaving(true);
    try {
      const payload = {
        user_id: staff.user_id,
        template_type: form.template_type,
        job_title: form.job_title.trim() || null,
        timezone: form.timezone.trim() || 'Asia/Manila',
        work_days: form.work_days,
        shift_start: form.shift_start || null,
        shift_end: form.shift_end || null,
        // basic_salary / allowance only apply to CSR. live_admin pay is
        // computed from fixed tiers — those columns stay null. The four
        // rate-override columns are NEVER written from the UI; the engine
        // ignores them.
        basic_salary: form.template_type === 'csr' ? numOrNull(form.basic_salary) : null,
        allowance: form.template_type === 'csr' ? numOrNull(form.allowance) : null,
        half_day_rate: null,
        full_day_rate: null,
        full_day_threshold_hours: null,
        dayoff_divisor: 4,
        active: form.active,
        can_view_all: form.can_view_all,
      };
      const client = supabase as any;
      const { error } = existing
        ? await client.from('timesheet_profiles').update(payload).eq('id', existing.id)
        : await client.from('timesheet_profiles').upsert(payload, { onConflict: 'user_id' });
      if (error) throw error;
      toast.success(existing ? 'Assignment updated' : 'Assignment created');
      onSaved();
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error((err as Error)?.message ?? 'Failed to save assignment');
    } finally {
      setSaving(false);
    }
  }

  const isCsr = form.template_type === 'csr';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{staff?.full_name ?? 'Assignment'}</DialogTitle>
          <DialogDescription>Configure this staff member's timesheet template and pay.</DialogDescription>
        </DialogHeader>
        <form onSubmit={e => { e.preventDefault(); save(); }} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Template *</Label>
              <Select value={form.template_type} onValueChange={v => upd('template_type', v as TemplateType)}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="live_admin">Live Admin</SelectItem>
                  <SelectItem value="csr">CSR</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Job Title</Label>
              <Input value={form.job_title} onChange={e => upd('job_title', e.target.value)} className="h-9" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Timezone</Label>
              <Input value={form.timezone} onChange={e => upd('timezone', e.target.value)} className="h-9" placeholder="Asia/Manila" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Status</Label>
              <label className="flex h-9 items-center gap-2 text-sm">
                <Switch checked={form.active} onCheckedChange={v => upd('active', v)} />
                {form.active ? 'Active' : 'Inactive'}
              </label>
            </div>
          </div>

          <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border/60 bg-muted/10 px-3 py-2 text-sm">
            <Checkbox checked={form.can_view_all} onCheckedChange={v => upd('can_view_all', v === true)} />
            <span>Can view Consolidation + Cost Master</span>
            <span className="ml-auto text-[10px] text-muted-foreground">timesheet-only, no role change</span>
          </label>

          <div className="space-y-1.5">
            <Label className="text-xs">Work Days (ISO Mon→Sun)</Label>
            <div className="flex flex-wrap gap-1.5">
              {ALL_DOW.map(dow => (
                <button
                  key={dow}
                  type="button"
                  onClick={() => toggleDay(dow)}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                    form.work_days.includes(dow)
                      ? 'border-primary/50 bg-primary/15 text-primary'
                      : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/50',
                  )}
                >
                  {DOW_LABELS[dow]}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Shift Start</Label>
              <Input type="time" value={form.shift_start} onChange={e => upd('shift_start', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Shift End</Label>
              <Input type="time" value={form.shift_end} onChange={e => upd('shift_end', e.target.value)} className="h-9" />
            </div>
          </div>

          {isCsr ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Basic Salary (₱)</Label>
                <Input type="number" value={form.basic_salary} onChange={e => upd('basic_salary', e.target.value)} className="h-9" min={0} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Allowance (₱)</Label>
                <Input type="number" value={form.allowance} onChange={e => upd('allowance', e.target.value)} className="h-9" min={0} />
              </div>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Pay is computed from fixed tiers: ₱300 (1–3.99 hr) / ₱500 (≥4 hr).
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving} className="gold-gradient text-primary-foreground">
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {existing ? 'Save Changes' : 'Create Assignment'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AssignmentsTab({
  staff, profiles, onRefresh,
}: {
  staff: StaffRow[];
  profiles: TimesheetProfile[];
  onRefresh: () => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedStaff, setSelectedStaff] = useState<StaffRow | null>(null);

  const profileByUser = useMemo(() => {
    const map = new Map<string, TimesheetProfile>();
    for (const p of profiles) map.set(p.user_id, p);
    return map;
  }, [profiles]);

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Staff</th>
              <th className="px-3 py-2 text-left font-medium">Template</th>
              <th className="px-3 py-2 text-left font-medium">Job Title</th>
              <th className="px-3 py-2 text-center font-medium">Status</th>
              <th className="px-3 py-2 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {staff.length === 0 ? (
              <tr><td colSpan={5} className="px-3 py-10 text-center text-sm text-muted-foreground">No staff found.</td></tr>
            ) : (
              staff.map(s => {
                const p = profileByUser.get(s.user_id) ?? null;
                return (
                  <tr key={s.user_id} className="border-t border-border hover:bg-muted/30">
                    <td className="px-3 py-2 font-medium">{s.full_name}</td>
                    <td className="px-3 py-2">
                      {p ? (
                        <Badge variant="outline" className="border-primary/40 bg-primary/10 text-[10px] text-primary">
                          {TEMPLATE_LABEL[p.template_type]}
                        </Badge>
                      ) : <span className="text-xs text-muted-foreground">Unassigned</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{p?.job_title ?? '—'}</td>
                    <td className="px-3 py-2 text-center">
                      {p ? (
                        p.active
                          ? <span className="text-xs text-green-400">Active</span>
                          : <span className="text-xs text-muted-foreground">Inactive</span>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => { setSelectedStaff(s); setDialogOpen(true); }}
                      >
                        <Pencil className="mr-1 h-3 w-3" /> {p ? 'Edit' : 'Assign'}
                      </Button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <AssignmentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        staff={selectedStaff}
        existing={selectedStaff ? profileByUser.get(selectedStaff.user_id) ?? null : null}
        onSaved={onRefresh}
      />
    </div>
  );
}

// ── Small helpers ───────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-xl font-semibold tabular-nums', highlight ? 'text-primary' : 'text-card-foreground')}>{value}</p>
      {sub && <p className="mt-0.5 text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ── Tab: Full Summary (admin) ───────────────────────────────────────────────

const CSR_BAR = '#D4AF37';
const LIVE_ADMIN_BAR = '#1756A8';

function FullSummaryTab({
  profiles, allEntries,
}: {
  profiles: TimesheetProfile[];
  allEntries: (TimesheetEntry & { user_id: string })[];
}) {
  const summary = useMemo(
    () => computeAllMonthsSummary(profiles, allEntries),
    [profiles, allEntries],
  );

  // Historical months persisted before the live data existed. Live computed
  // rows always win on a month-key collision; history only fills gaps.
  const [histRows, setHistRows] = useState<MonthCostRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await (supabase as any)
        .from('timesheet_monthly_history')
        .select('month_key, csr_net, liveadmin_net');
      if (cancelled) return;
      const mapped: MonthCostRow[] = ((data as { month_key: string; csr_net: number; liveadmin_net: number }[]) ?? [])
        .map(r => ({
          monthKey: r.month_key,
          label: monthLabelFromKey(r.month_key),
          csr: Number(r.csr_net),
          liveAdmin: Number(r.liveadmin_net),
          total: Number(r.csr_net) + Number(r.liveadmin_net),
        }));
      setHistRows(mapped);
    })().catch(() => { if (!cancelled) setHistRows([]); });
    return () => { cancelled = true; };
  }, []);

  // Months that have at least one REAL punch, derived from the SAME entries
  // array that feeds computeAllMonthsSummary. A month with only blank/₱0
  // entry rows (current/recent month before anyone punches) does NOT count —
  // its empty live row must not overwrite a real history month. computeAll-
  // MonthsSummary already derives its months from the entries, so gating on
  // mere row-presence would be a no-op; we require an actual punch.
  const monthsWithPunches = useMemo(() => {
    const set = new Set<string>();
    for (const e of allEntries) {
      if (!e.am_in && !e.am_out && !e.pm_in && !e.pm_out) continue; // no real punch
      const mk = monthKeyFromDate(e.work_date);
      if (mk) set.add(mk);
    }
    return set;
  }, [allEntries]);

  // Merge history + live by monthKey, ascending. Seed with history, then
  // overlay a live row ONLY when its month actually has punches — so a live
  // row wins on collision only once the month is genuinely worked, and an
  // empty/unpunched live month neither overrides history nor adds a blank
  // month. Result: every history month (incl. May 2026) always shows; a
  // month appears live only after it has punches (June stays blank until
  // punched, then appears live).
  const mergedRows = useMemo<MonthCostRow[]>(() => {
    const byKey = new Map<string, MonthCostRow>();
    for (const r of histRows) byKey.set(r.monthKey, r);
    for (const r of summary.rows) {
      if (monthsWithPunches.has(r.monthKey)) byKey.set(r.monthKey, r); // live wins only when punched
    }
    return Array.from(byKey.values()).sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  }, [histRows, summary.rows, monthsWithPunches]);

  // Year filter — "all" plus each distinct year present in the merged list.
  const [year, setYear] = useState<string>('all');
  const years = useMemo(() => {
    const set = new Set<string>();
    for (const r of mergedRows) set.add(r.monthKey.slice(0, 4));
    return Array.from(set).sort();
  }, [mergedRows]);
  // Reset to "all" if the selected year disappears from the data.
  useEffect(() => {
    if (year !== 'all' && !years.includes(year)) setYear('all');
  }, [years, year]);

  const filteredRows = useMemo(
    () => (year === 'all' ? mergedRows : mergedRows.filter(r => r.monthKey.slice(0, 4) === year)),
    [mergedRows, year],
  );

  const filteredTotals = useMemo(() => {
    let csr = 0, liveAdmin = 0, total = 0;
    for (const r of filteredRows) { csr += r.csr; liveAdmin += r.liveAdmin; total += r.total; }
    return { csr, liveAdmin, total };
  }, [filteredRows]);

  const hasData = filteredRows.length > 0;
  const headlineLabel = year === 'all' ? 'All-time payroll cost' : `${year} payroll cost`;
  const footerLabel = year === 'all' ? 'All-time total' : `${year} total`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="rounded-lg border border-border bg-card p-4 flex-1 min-w-[220px]">
          <p className="text-xs text-muted-foreground">{headlineLabel}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-primary">{formatPHP(filteredTotals.total)}</p>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">Year</Label>
          <Select value={year} onValueChange={setYear}>
            <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {years.map(y => <SelectItem key={y} value={y}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!hasData ? (
        <div className="rounded-lg border border-border bg-card p-12 text-center text-sm text-muted-foreground">
          No timesheet data yet.
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="mb-3 text-sm font-semibold text-card-foreground">Monthly Payroll Cost</h3>
            <div className="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={filteredRows} margin={{ top: 4, right: 24, left: 8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 11 }} />
                  <YAxis stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 11 }} />
                  <Tooltip
                    cursor={{ fill: 'hsl(var(--muted) / 0.3)' }}
                    contentStyle={{
                      background: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                    formatter={(value: number) => formatPHP(value)}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="csr" stackId="cost" fill={CSR_BAR} name="CSR" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="liveAdmin" stackId="cost" fill={LIVE_ADMIN_BAR} name="Live Admin" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Month</th>
                  <th className="px-3 py-2 text-right font-medium">CSR</th>
                  <th className="px-3 py-2 text-right font-medium">Live Admin</th>
                  <th className="px-3 py-2 text-right font-medium">Grand Total</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map(r => (
                  <tr key={r.monthKey} className="border-t border-border">
                    <td className="px-3 py-2 font-medium">{r.label}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatPHP(r.csr)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatPHP(r.liveAdmin)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-primary">{formatPHP(r.total)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-primary/40 bg-primary/5 font-semibold">
                  <td className="px-3 py-2.5">{footerLabel}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatPHP(filteredTotals.csr)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatPHP(filteredTotals.liveAdmin)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-primary">{formatPHP(filteredTotals.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

const TAB_VALUES = ['my', 'fullsummary', 'consolidation', 'cost', 'assignments'] as const;
type TabValue = typeof TAB_VALUES[number];

export default function Timesheet() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, roles } = useAuth();
  const isAdmin = roles.includes('admin');
  const userId = user?.id ?? '';

  const [monthKey, setMonthKey] = useState<string>(currentMonthKey());
  const [loading, setLoading] = useState(true);

  // My-tab data — loaded on every path (the current user's own profile +
  // entries). myProfile carries the timesheet-only can_view_all flag.
  const [myProfile, setMyProfile] = useState<TimesheetProfile | null>(null);
  const [myEntries, setMyEntries] = useState<TimesheetEntry[]>([]);

  // can_view_all is a timesheet-only visibility grant (NOT a finance/admin
  // role). A flagged staff member sees Consolidation + Cost Master while
  // keeping My Timesheet; they never get Full Summary or Assignments. It's
  // not in the engine's TimesheetProfile interface, so read it via cast.
  const canViewAll = !!(myProfile as (TimesheetProfile & { can_view_all?: boolean }) | null)?.can_view_all;

  // Single source of truth for the two shared gates.
  const canConsolidate = isAdmin || roles.includes('finance') || canViewAll;
  const canViewCost = isAdmin || canViewAll;

  // Admin lands on Full Summary and has NO "My Timesheet" tab; everyone
  // else (incl. flagged staff) lands on My Timesheet.
  const defaultTab: TabValue = isAdmin ? 'fullsummary' : 'my';

  function tabFromParamGated(s: string | null): TabValue {
    const v = (s && (TAB_VALUES as readonly string[]).includes(s)) ? (s as TabValue) : defaultTab;
    if (v === 'fullsummary' && !isAdmin) return 'my';         // admin-only view
    if (v === 'my' && isAdmin) return 'fullsummary';          // My Timesheet hidden from admin
    if (v === 'consolidation' && !canConsolidate) return defaultTab;
    if (v === 'cost' && !canViewCost) return defaultTab;
    if (v === 'assignments' && !isAdmin) return defaultTab;
    return v;
  }

  const [tab, setTab] = useState<TabValue>(tabFromParamGated(searchParams.get('tab')));

  useEffect(() => {
    setTab(tabFromParamGated(searchParams.get('tab')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, isAdmin, canConsolidate, canViewCost]);

  function setTabAndUrl(next: string) {
    const v = tabFromParamGated(next);
    setTab(v);
    setSearchParams(v === defaultTab ? {} : { tab: v }, { replace: true });
  }

  // Admin/finance data
  const [allProfiles, setAllProfiles] = useState<TimesheetProfile[]>([]);
  const [allEntries, setAllEntries] = useState<(TimesheetEntry & { user_id: string })[]>([]);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [nameByUser, setNameByUser] = useState<Map<string, string>>(new Map());
  // All-time entries for the admin Full Summary (every month, no date range).
  const [summaryEntries, setSummaryEntries] = useState<(TimesheetEntry & { user_id: string })[]>([]);

  const monthRange = useMemo(() => {
    // Load the FULL 31-row window, not just the calendar month: the grid's
    // trailing spillover rows (next-month dates that pad the sheet to 31)
    // both display and count toward this month's totals, so their entries
    // must be fetched too. June loads 2026-06-01..2026-07-01 inclusive.
    // (The all-time Full Summary fetch is separate and unaffected.)
    const start = `${monthKey}-01`;
    const end = addDays(start, TIMESHEET_ROWS - 1);
    return { start, end };
  }, [monthKey]);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const client = supabase as any;
      const profileCols = 'id, user_id, template_type, job_title, timezone, work_days, shift_start, shift_end, basic_salary, allowance, half_day_rate, full_day_rate, full_day_threshold_hours, dayoff_divisor, active, can_view_all';
      const entryCols = 'work_date, am_in, am_out, pm_in, pm_out, user_id';

      // My profile + entries (explicit user filter on top of RLS).
      const [myProfRes, myEntRes] = await Promise.all([
        client.from('timesheet_profiles').select(profileCols).eq('user_id', userId).maybeSingle(),
        client.from('timesheet_entries').select(entryCols).eq('user_id', userId)
          .gte('work_date', monthRange.start).lte('work_date', monthRange.end),
      ]);
      setMyProfile((myProfRes.data as TimesheetProfile) ?? null);
      setMyEntries((myEntRes.data as TimesheetEntry[]) ?? []);

      // Admin/finance datasets (RLS returns all rows for those roles).
      if (canConsolidate) {
        const [profRes, entRes] = await Promise.all([
          client.from('timesheet_profiles').select(profileCols),
          client.from('timesheet_entries').select(entryCols)
            .gte('work_date', monthRange.start).lte('work_date', monthRange.end),
        ]);
        setAllProfiles((profRes.data as TimesheetProfile[]) ?? []);
        setAllEntries((entRes.data as (TimesheetEntry & { user_id: string })[]) ?? []);
      }

      // Staff list + names (admin Assignments + consolidation column labels).
      if (canConsolidate) {
        const { data: profRows } = await client.from('profiles').select('user_id, full_name');
        const rows = ((profRows as StaffRow[]) ?? []).filter(r => r.full_name);
        rows.sort((a, b) => a.full_name.localeCompare(b.full_name));
        setStaff(rows);
        setNameByUser(new Map(rows.map(r => [r.user_id, r.full_name])));
      }

      // All-time entries for the admin Full Summary — every month, no date
      // range (RLS returns all rows for admin). Active-profile filtering and
      // per-month grouping happen inside computeAllMonthsSummary.
      if (isAdmin) {
        const { data: allTime } = await client
          .from('timesheet_entries')
          .select(entryCols);
        setSummaryEntries((allTime as (TimesheetEntry & { user_id: string })[]) ?? []);
      }
    } catch (err: unknown) {
      console.warn('Failed to load timesheet data:', (err as Error)?.message);
      toast.error('Failed to load timesheet data');
    } finally {
      setLoading(false);
    }
  }, [userId, monthRange.start, monthRange.end, canConsolidate, isAdmin]);

  useEffect(() => { load(); }, [load]);

  const entriesByUser = useMemo(() => {
    const map = new Map<string, TimesheetEntry[]>();
    for (const e of allEntries) {
      const list = map.get(e.user_id) ?? [];
      list.push(e);
      map.set(e.user_id, list);
    }
    return map;
  }, [allEntries]);

  // Merge a single saved row into myEntries in place — the My Timesheet tab
  // uses this so a punch/manual edit never fires the global reload (which
  // would unmount the grid mid-edit).
  const applyMyEntryUpsert = useCallback((entry: TimesheetEntry) => {
    setMyEntries(prev => {
      const idx = prev.findIndex(e => e.work_date === entry.work_date);
      if (idx === -1) return [...prev, entry];
      const next = prev.slice();
      next[idx] = entry;
      return next;
    });
  }, []);

  return (
    <AppLayout>
      <div className="container mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl text-card-foreground">Timesheet</h1>
            <p className="text-xs text-muted-foreground">
              Monthly staff time tracking. Punch in/out, view your pay, PHP throughout.
            </p>
          </div>
          <span className="text-xs text-muted-foreground">{loading ? 'Loading…' : monthLabelFromKey(monthKey)}</span>
        </div>

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-[400px] w-full" />
          </div>
        ) : (
          <Tabs value={tab} onValueChange={setTabAndUrl}>
            <TabsList>
              {isAdmin && <TabsTrigger value="fullsummary">Full Summary</TabsTrigger>}
              {!isAdmin && <TabsTrigger value="my">My Timesheet</TabsTrigger>}
              {canConsolidate && <TabsTrigger value="consolidation">Consolidation</TabsTrigger>}
              {canViewCost && <TabsTrigger value="cost">Cost Master</TabsTrigger>}
              {isAdmin && <TabsTrigger value="assignments">Assignments</TabsTrigger>}
            </TabsList>

            {isAdmin && (
              <TabsContent value="fullsummary" className="mt-4">
                <FullSummaryTab profiles={allProfiles} allEntries={summaryEntries} />
              </TabsContent>
            )}

            {!isAdmin && (
              <TabsContent value="my" className="mt-4">
                <MyTimesheetTab
                  profile={myProfile}
                  entries={myEntries}
                  monthKey={monthKey}
                  onMonthChange={setMonthKey}
                  onEntrySaved={applyMyEntryUpsert}
                  userId={userId}
                />
              </TabsContent>
            )}

            {canConsolidate && (
              <TabsContent value="consolidation" className="mt-4">
                <ConsolidationTab
                  profiles={allProfiles}
                  entriesByUser={entriesByUser}
                  nameByUser={nameByUser}
                  monthKey={monthKey}
                  onMonthChange={setMonthKey}
                />
              </TabsContent>
            )}

            {canViewCost && (
              <TabsContent value="cost" className="mt-4">
                <CostMasterTab
                  profiles={allProfiles}
                  entriesByUser={entriesByUser}
                  nameByUser={nameByUser}
                  monthKey={monthKey}
                  onMonthChange={setMonthKey}
                />
              </TabsContent>
            )}

            {isAdmin && (
              <TabsContent value="assignments" className="mt-4">
                <AssignmentsTab staff={staff} profiles={allProfiles} onRefresh={load} />
              </TabsContent>
            )}
          </Tabs>
        )}
      </div>
    </AppLayout>
  );
}
