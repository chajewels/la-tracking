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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Loader2, LogIn, LogOut, Pencil, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { getPHTToday } from '@/lib/date-utils';
import {
  TemplateType, TimesheetProfile, TimesheetEntry,
  TEMPLATE_DEFAULTS, TEMPLATE_LABEL,
  computeMonth, computeConsolidation, monthLabelFromKey, daysInMonthOf,
  isoDowOf, formatPHP, formatPHP2, formatHours,
} from '@/lib/timesheetEngine';

const DOW_LABELS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ALL_DOW = [1, 2, 3, 4, 5, 6, 7];

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
  profile, entries, monthKey, onMonthChange, onRefresh, userId,
}: {
  profile: TimesheetProfile | null;
  entries: TimesheetEntry[];
  monthKey: string;
  onMonthChange: (k: string) => void;
  onRefresh: () => void;
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
      onRefresh();
    } catch (err: unknown) {
      toast.error((err as Error)?.message ?? 'Failed to save punch');
    } finally {
      setBusy(false);
    }
  }, [entryByDate, onRefresh, userId]);

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
    const todayEntry = entryByDate.get(today);
    let field: PunchField | null = null;
    if (kind === 'in') {
      if (!todayEntry?.am_in) field = 'am_in';
      else if (!todayEntry?.pm_in) field = 'pm_in';
      else { toast.info('Both Time In slots are already filled for today.'); return; }
    } else {
      if (todayEntry?.am_in && !todayEntry?.am_out) field = 'am_out';
      else if (todayEntry?.pm_in && !todayEntry?.pm_out) field = 'pm_out';
      else { toast.info('No open session to time out of.'); return; }
    }
    // True instant — stored as timestamptz, displayed back in the profile tz.
    const nowIso = new Date().toISOString();
    maybeWarnOutsideShift(isoToWall(nowIso, tz));
    await writeField(today, field, nowIso);
    toast.success(`Punched ${kind === 'in' ? 'in' : 'out'} (${field.replace('_', ' ')})`);
  }

  function onTimeEdit(workDate: string, field: PunchField, hhmm: string) {
    const iso = hhmm ? zonedWallToISO(workDate, hhmm, tz) : null;
    writeField(workDate, field, iso);
  }

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

  const daysInMonth = daysInMonthOf(monthKey);
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
                          disabled={busy}
                          className="h-7 w-[5.5rem] px-1 text-center text-xs tabular-nums"
                        />
                      </td>
                    ))}
                    <td className="px-3 py-1.5 text-right tabular-nums text-xs">{d.hours > 0 ? formatHours(d.hours) : '—'}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-xs">{d.salary > 0 ? formatPHP2(d.salary) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-muted/30 font-semibold">
                <td className="px-3 py-2 text-xs" colSpan={6}>TOTAL — {daysInMonth} days</td>
                <td className="px-3 py-2 text-right tabular-nums text-xs">{formatHours(month!.total_hours)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-xs">{formatPHP(month!.gross)}</td>
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
}

function profileToForm(p: TimesheetProfile | null): ProfileFormState {
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
        basic_salary: numOrNull(form.basic_salary),
        allowance: numOrNull(form.allowance),
        half_day_rate: numOrNull(form.half_day_rate),
        full_day_rate: numOrNull(form.full_day_rate),
        full_day_threshold_hours: numOrNull(form.full_day_threshold_hours),
        dayoff_divisor: form.dayoff_divisor.trim() === '' ? 4 : Number(form.dayoff_divisor),
        active: form.active,
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
  const defaults = TEMPLATE_DEFAULTS[form.template_type];

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

          {isCsr && (
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
          )}

          <div className="rounded-md border border-border/60 bg-muted/10 p-3">
            <p className="mb-2 text-[11px] uppercase text-muted-foreground">
              Rate overrides (blank → template default)
            </p>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Half-day ₱</Label>
                <Input type="number" value={form.half_day_rate} onChange={e => upd('half_day_rate', e.target.value)} className="h-9" placeholder={String(defaults.half_day_rate)} />
              </div>
              {!isCsr && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Full-day ₱</Label>
                  <Input type="number" value={form.full_day_rate} onChange={e => upd('full_day_rate', e.target.value)} className="h-9" placeholder={String(defaults.full_day_rate ?? '')} />
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-xs">Full-day hrs</Label>
                <Input type="number" value={form.full_day_threshold_hours} onChange={e => upd('full_day_threshold_hours', e.target.value)} className="h-9" placeholder={String(defaults.full_day_threshold_hours)} />
              </div>
              {isCsr && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Day-off divisor</Label>
                  <Input type="number" value={form.dayoff_divisor} onChange={e => upd('dayoff_divisor', e.target.value)} className="h-9" placeholder="4" />
                </div>
              )}
            </div>
          </div>

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

// ── Main page ───────────────────────────────────────────────────────────────

const TAB_VALUES = ['my', 'consolidation', 'cost', 'assignments'] as const;
type TabValue = typeof TAB_VALUES[number];

export default function Timesheet() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, roles } = useAuth();
  const isAdmin = roles.includes('admin');
  const canConsolidate = isAdmin || roles.includes('finance');
  const userId = user?.id ?? '';

  function tabFromParamGated(s: string | null): TabValue {
    const v = (s && (TAB_VALUES as readonly string[]).includes(s)) ? (s as TabValue) : 'my';
    if ((v === 'consolidation') && !canConsolidate) return 'my';
    if ((v === 'cost' || v === 'assignments') && !isAdmin) return 'my';
    return v;
  }

  const [tab, setTab] = useState<TabValue>(tabFromParamGated(searchParams.get('tab')));

  useEffect(() => {
    setTab(tabFromParamGated(searchParams.get('tab')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, isAdmin, canConsolidate]);

  function setTabAndUrl(next: string) {
    const v = tabFromParamGated(next);
    setTab(v);
    setSearchParams(v === 'my' ? {} : { tab: v }, { replace: true });
  }

  const [monthKey, setMonthKey] = useState<string>(currentMonthKey());
  const [loading, setLoading] = useState(true);

  // My-tab data
  const [myProfile, setMyProfile] = useState<TimesheetProfile | null>(null);
  const [myEntries, setMyEntries] = useState<TimesheetEntry[]>([]);

  // Admin/finance data
  const [allProfiles, setAllProfiles] = useState<TimesheetProfile[]>([]);
  const [allEntries, setAllEntries] = useState<(TimesheetEntry & { user_id: string })[]>([]);
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [nameByUser, setNameByUser] = useState<Map<string, string>>(new Map());

  const monthRange = useMemo(() => {
    const start = `${monthKey}-01`;
    const end = `${monthKey}-${String(daysInMonthOf(monthKey)).padStart(2, '0')}`;
    return { start, end };
  }, [monthKey]);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const client = supabase as any;
      const profileCols = 'id, user_id, template_type, job_title, timezone, work_days, shift_start, shift_end, basic_salary, allowance, half_day_rate, full_day_rate, full_day_threshold_hours, dayoff_divisor, active';
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
    } catch (err: unknown) {
      console.warn('Failed to load timesheet data:', (err as Error)?.message);
      toast.error('Failed to load timesheet data');
    } finally {
      setLoading(false);
    }
  }, [userId, monthRange.start, monthRange.end, canConsolidate]);

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
              <TabsTrigger value="my">My Timesheet</TabsTrigger>
              {canConsolidate && <TabsTrigger value="consolidation">Consolidation</TabsTrigger>}
              {isAdmin && <TabsTrigger value="cost">Cost Master</TabsTrigger>}
              {isAdmin && <TabsTrigger value="assignments">Assignments</TabsTrigger>}
            </TabsList>

            <TabsContent value="my" className="mt-4">
              <MyTimesheetTab
                profile={myProfile}
                entries={myEntries}
                monthKey={monthKey}
                onMonthChange={setMonthKey}
                onRefresh={load}
                userId={userId}
              />
            </TabsContent>

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

            {isAdmin && (
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
