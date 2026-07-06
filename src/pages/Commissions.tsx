import { useState, useEffect, useMemo, useCallback, Fragment } from 'react';
import { chartColors } from '@/theme/tokens';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import {
  Plus, Pencil, Trash2, Search, X, Loader2, Star, Scale,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { getPHTToday } from '@/lib/date-utils';
import {
  SaleRow, CommissionAgent, CommissionSplit, MonthlyComputation,
  CanonicalRole, CANONICAL_ROLES, ROLE_LABEL_FULL, ROLE_LABEL_ABBREV,
  computeAllMonths, monthKeyFromDate, monthLabelFromKey,
  defaultEligible, formatPHP, formatJPY, agentColor,
} from '@/lib/commissionEngine';

const STATUS_OPTIONS = ['Paid', 'Cancelled', 'Pending'] as const;
const CHANNEL_OPTIONS = ['Chat', 'Posting', 'Live'] as const;
const SOURCE_OPTIONS = ['Admin Post', 'DM', 'Live Post', 'Online Store', 'Other'] as const;
const FALLBACK_AGENT_COLOR = '#1756A8';

function statusBadgeClass(status: string | null): string {
  switch (status) {
    case 'Paid':      return 'bg-green-500/15 text-green-300 border-green-500/30';
    case 'Cancelled': return 'bg-red-500/15 text-red-300 border-red-500/30';
    case 'Pending':   return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    default:          return 'bg-muted text-muted-foreground border-border';
  }
}

function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: 'short', day: '2-digit',
    }).format(new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')));
  } catch {
    return '—';
  }
}

function toDateInputValue(value: string | null | undefined): string {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Sales Log dialog ────────────────────────────────────────────────────────

interface SalesLogFormState {
  sale_date: string;
  item_code: string;
  invoice_number: string;
  item_amount: string;
  client_name: string;
  closer: string;
  processor: string;
  coordinator: string;
  support: string;
  verifier: string;
  status: string;
  channel: string;
  source: string;
  opened_in_chat: boolean;
  closed_in_chat: boolean;
  eligible: boolean;
  eligible_manually_set: boolean; // tracks whether the user has overridden the auto-default
  notes: string;
}

function emptyForm(): SalesLogFormState {
  return {
    sale_date: getPHTToday(),
    item_code: '',
    invoice_number: '',
    item_amount: '',
    client_name: '',
    closer: '',
    processor: '',
    coordinator: '',
    support: '',
    verifier: '',
    status: 'Paid',
    channel: 'Chat',
    source: 'Admin Post',
    opened_in_chat: true,
    closed_in_chat: true,
    eligible: true,
    eligible_manually_set: false,
    notes: '',
  };
}

function SalesLogDialog({
  open, onOpenChange, editing, agents, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: SaleRow | null;
  agents: CommissionAgent[];
  onSaved: () => void;
}) {
  const [form, setForm] = useState<SalesLogFormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Active agent options for role dropdowns; when editing an old row that
  // references an inactive agent, surface that name even though they're not
  // currently active.
  const activeAgents = useMemo(
    () => agents.filter(a => a.active).map(a => a.name).sort((a, b) => a.localeCompare(b)),
    [agents]
  );

  function roleOptions(currentValue: string): string[] {
    if (!currentValue || activeAgents.includes(currentValue)) return activeAgents;
    return [...activeAgents, currentValue].sort((a, b) => a.localeCompare(b));
  }

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        sale_date: toDateInputValue(editing.sale_date) || getPHTToday(),
        item_code: editing.item_code ?? '',
        invoice_number: editing.invoice_number ?? '',
        item_amount: editing.item_amount != null ? String(editing.item_amount) : '',
        client_name: editing.client_name ?? '',
        closer: editing.closer ?? '',
        processor: editing.processor ?? '',
        coordinator: editing.coordinator ?? '',
        support: editing.support ?? '',
        verifier: editing.verifier ?? '',
        status: editing.status ?? 'Paid',
        channel: editing.channel ?? 'Chat',
        source: editing.source ?? 'Admin Post',
        opened_in_chat: editing.opened_in_chat ?? true,
        closed_in_chat: editing.closed_in_chat ?? true,
        eligible: editing.eligible ?? false,
        // When editing an existing row, treat the stored value as authoritative
        // and lock in manual-override mode so we don't surprise the user by
        // flipping it while they toggle status/channel.
        eligible_manually_set: true,
        notes: editing.notes ?? '',
      });
    } else {
      setForm(emptyForm());
    }
  }, [open, editing]);

  function update<K extends keyof SalesLogFormState>(key: K, value: SalesLogFormState[K]) {
    setForm(prev => {
      const next = { ...prev, [key]: value };
      // Auto-default eligible when status/channel change AND user hasn't
      // manually overridden it.
      if ((key === 'status' || key === 'channel') && !prev.eligible_manually_set) {
        const status = key === 'status' ? (value as string) : prev.status;
        const channel = key === 'channel' ? (value as string) : prev.channel;
        next.eligible = defaultEligible(status, channel);
      }
      return next;
    });
  }

  async function save() {
    if (!form.sale_date) { toast.error('Date is required'); return; }
    const amount = Number(form.item_amount);
    if (!Number.isFinite(amount) || amount < 0) { toast.error('Amount must be a non-negative number'); return; }
    setSaving(true);
    try {
      const payload = {
        sale_date: form.sale_date,
        item_code: form.item_code.trim() || null,
        invoice_number: form.invoice_number.trim() || null,
        item_amount: amount,
        client_name: form.client_name.trim() || null,
        closer: form.closer.trim() || null,
        processor: form.processor.trim() || null,
        coordinator: form.coordinator.trim() || null,
        support: form.support.trim() || null,
        verifier: form.verifier.trim() || null,
        status: form.status,
        channel: form.channel,
        source: form.source,
        opened_in_chat: form.opened_in_chat,
        closed_in_chat: form.closed_in_chat,
        eligible: form.eligible,
        notes: form.notes.trim() || null,
      };
      const client = supabase;
      const { error } = editing
        ? await client.from('sales_log').update(payload).eq('id', editing.id)
        : await client.from('sales_log').insert(payload);
      if (error) throw error;
      toast.success(editing ? 'Sale updated' : 'Sale added');
      onSaved();
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error((err as Error)?.message ?? 'Failed to save sale');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!editing) return;
    if (!window.confirm('Delete this sale entry? This cannot be undone.')) return;
    setDeleting(true);
    try {
      const client = supabase;
      const { error } = await client.from('sales_log').delete().eq('id', editing.id);
      if (error) throw error;
      toast.success('Sale deleted');
      onSaved();
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error((err as Error)?.message ?? 'Failed to delete sale');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit Sale' : 'New Sale'}</DialogTitle>
          <DialogDescription>
            All commission calculations refresh automatically after save.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => { e.preventDefault(); save(); }}
          className="space-y-3"
        >
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Date *</Label>
              <Input type="date" value={form.sale_date} onChange={e => update('sale_date', e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Item Code</Label>
              <Input value={form.item_code} onChange={e => update('item_code', e.target.value)} className="h-9" placeholder="e.g. CJ-RING-001" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Amount (¥) *</Label>
              <Input type="number" inputMode="numeric" value={form.item_amount} onChange={e => update('item_amount', e.target.value)} className="h-9" min={0} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">HUB Invoice #</Label>
            <Input
              value={form.invoice_number}
              onChange={e => update('invoice_number', e.target.value)}
              className="h-9"
              placeholder="e.g. 19131"
            />
            <p className="text-[10px] text-muted-foreground">
              Auto-marks this row as Paid when the payment confirms in HUB.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Client Name</Label>
            <Input value={form.client_name} onChange={e => update('client_name', e.target.value)} className="h-9" />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {(['closer', 'processor', 'coordinator', 'support', 'verifier'] as const).map((role) => (
              <div key={role} className="space-y-1.5">
                <Label className="text-xs capitalize">{role}</Label>
                <Select value={form[role] || '__none__'} onValueChange={v => update(role, v === '__none__' ? '' : v)}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">—</SelectItem>
                    {roleOptions(form[role]).map(name => (
                      <SelectItem key={name} value={name}>{name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Status</Label>
              <Select value={form.status} onValueChange={v => update('status', v)}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Channel</Label>
              <Select value={form.channel} onValueChange={v => update('channel', v)}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CHANNEL_OPTIONS.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Source</Label>
              <Select value={form.source} onValueChange={v => update('source', v)}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SOURCE_OPTIONS.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <Switch checked={form.opened_in_chat} onCheckedChange={v => update('opened_in_chat', v)} />
              Opened in chat
            </label>
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <Switch checked={form.closed_in_chat} onCheckedChange={v => update('closed_in_chat', v)} />
              Closed in chat
            </label>
            <label className="flex items-center gap-2 text-xs cursor-pointer ml-auto">
              <Checkbox
                checked={form.eligible}
                onCheckedChange={(v) => {
                  setForm(prev => ({ ...prev, eligible: v === true, eligible_manually_set: true }));
                }}
              />
              <span className="font-medium">Eligible for commission</span>
              {!form.eligible_manually_set && (
                <span className="text-[10px] text-muted-foreground">(auto)</span>
              )}
            </label>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Notes</Label>
            <Textarea value={form.notes} onChange={e => update('notes', e.target.value)} rows={2} className="resize-none" />
          </div>

          <DialogFooter className="gap-2">
            {editing && (
              <Button type="button" variant="outline" onClick={remove} disabled={saving || deleting} className="mr-auto border-destructive/30 text-destructive hover:bg-destructive/10">
                {deleting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1.5 h-4 w-4" />}
                Delete
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving || deleting}>Cancel</Button>
            <Button type="submit" disabled={saving || deleting} className="gold-gradient text-primary-foreground">
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {editing ? 'Save Changes' : 'Add Sale'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Agent edit dialog (Config tab) ──────────────────────────────────────────

function AgentDialog({
  open, onOpenChange, editing, onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: CommissionAgent | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(FALLBACK_AGENT_COLOR);
  const [active, setActive] = useState(true);
  const [startMonth, setStartMonth] = useState('');
  const [sortOrder, setSortOrder] = useState<string>('0');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name ?? '');
      setColor(editing.color ?? FALLBACK_AGENT_COLOR);
      setActive(editing.active ?? true);
      setStartMonth(toDateInputValue(editing.start_month) || '');
      setSortOrder(String(editing.sort_order ?? 0));
    } else {
      setName('');
      setColor(FALLBACK_AGENT_COLOR);
      setActive(true);
      setStartMonth('');
      setSortOrder('0');
    }
  }, [open, editing]);

  async function save() {
    if (!name.trim()) { toast.error('Name is required'); return; }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        color,
        active,
        start_month: (startMonth || null) as string,
        sort_order: Number(sortOrder) || 0,
      };
      const client = supabase;
      const { error } = editing
        ? await client.from('commission_agents').update(payload).eq('id', editing.id)
        : await client.from('commission_agents').insert(payload);
      if (error) throw error;
      toast.success(editing ? 'Agent updated' : 'Agent added');
      onSaved();
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error((err as Error)?.message ?? 'Failed to save agent');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit Agent' : 'New Agent'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={e => { e.preventDefault(); save(); }} className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Name *</Label>
            <Input value={name} onChange={e => setName(e.target.value)} className="h-9" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Color</Label>
              <div className="flex items-center gap-2">
                <input type="color" value={color} onChange={e => setColor(e.target.value)} className="h-9 w-12 rounded border border-border bg-background" />
                <Input value={color} onChange={e => setColor(e.target.value)} className="h-9 font-mono text-xs" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Sort Order</Label>
              <Input type="number" value={sortOrder} onChange={e => setSortOrder(e.target.value)} className="h-9" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Start Month</Label>
              <Input type="date" value={startMonth} onChange={e => setStartMonth(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Status</Label>
              <label className="flex h-9 items-center gap-2 text-sm">
                <Switch checked={active} onCheckedChange={setActive} />
                {active ? 'Active' : 'Inactive'}
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving} className="gold-gradient text-primary-foreground">
              {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {editing ? 'Save Changes' : 'Add Agent'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Multi-select filter (lifted from Inquiries for consistency) ─────────────

function MultiSelectFilter({
  label, options, selected, onChange,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter(s => s !== value) : [...selected, value]);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-9 justify-start gap-2 text-xs',
            selected.length > 0 && 'border-primary/40 text-primary'
          )}
        >
          {label}
          {selected.length > 0 && (
            <span className="ml-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-primary/20 px-1.5 text-[10px] font-semibold text-primary">
              {selected.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 p-2">
        <div className="max-h-64 overflow-y-auto space-y-1">
          {options.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">No options</p>
          ) : (
            options.map(opt => (
              <label
                key={opt}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted"
              >
                <Checkbox checked={selected.includes(opt)} onCheckedChange={() => toggle(opt)} />
                <span className="flex-1 truncate">{opt}</span>
              </label>
            ))
          )}
        </div>
        {selected.length > 0 && (
          <Button variant="ghost" size="sm" className="mt-1 h-7 w-full text-xs text-muted-foreground" onClick={() => onChange([])}>
            Clear
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Merge-groups chip editor (Config tab, per-month sub-row) ────────────────

function MergeChipsEditor({
  split, onChange,
}: {
  split: CommissionSplit;
  onChange: (groups: string[][]) => void;
}) {
  const [selected, setSelected] = useState<Set<CanonicalRole>>(new Set());

  const pctMap: Record<CanonicalRole, number> = {
    closer: Number(split.closer_pct) || 0,
    processor: Number(split.processor_pct) || 0,
    coordinator: Number(split.coordinator_pct) || 0,
    support: Number(split.support_pct) || 0,
    verifier: Number(split.verifier_pct) || 0,
  };

  const groups: CanonicalRole[][] = useMemo(() => {
    if (!Array.isArray(split.merge_groups)) return [];
    const used = new Set<CanonicalRole>();
    const out: CanonicalRole[][] = [];
    for (const g of split.merge_groups) {
      if (!Array.isArray(g)) continue;
      const valid: CanonicalRole[] = [];
      for (const r of g) {
        if (typeof r !== 'string') continue;
        const lc = r.toLowerCase() as CanonicalRole;
        if (!(CANONICAL_ROLES as readonly string[]).includes(lc)) continue;
        if (used.has(lc) || valid.includes(lc)) continue;
        valid.push(lc);
      }
      if (valid.length >= 2) {
        valid.sort((a, b) => CANONICAL_ROLES.indexOf(a) - CANONICAL_ROLES.indexOf(b));
        for (const r of valid) used.add(r);
        out.push(valid);
      }
    }
    return out;
  }, [split.merge_groups]);

  const inGroup = useMemo(() => {
    const s = new Set<CanonicalRole>();
    for (const g of groups) for (const r of g) s.add(r);
    return s;
  }, [groups]);

  const standalone = useMemo(
    () => CANONICAL_ROLES.filter(r => !inGroup.has(r)),
    [inGroup]
  );

  function toggle(role: CanonicalRole) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }

  function merge() {
    const newGroup = CANONICAL_ROLES.filter(r => selected.has(r) && !inGroup.has(r));
    if (newGroup.length < 2) return;
    onChange([...groups.map(g => [...g]), newGroup]);
    setSelected(new Set());
  }

  function unmerge(index: number) {
    const next = groups.filter((_, i) => i !== index).map(g => [...g]);
    onChange(next);
    setSelected(new Set());
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] uppercase text-muted-foreground mr-1">Roles</span>
      {standalone.map(r => {
        const isSelected = selected.has(r);
        return (
          <button
            key={r}
            type="button"
            onClick={() => toggle(r)}
            className={cn(
              'rounded-md px-2 py-1 text-[10px] font-medium border transition-colors',
              isSelected
                ? 'border-primary/50 bg-primary/15 text-primary'
                : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/50'
            )}
          >
            {ROLE_LABEL_FULL[r]} {pctMap[r]}%
          </button>
        );
      })}
      {groups.map((g, i) => {
        const sumPct = g.reduce((s, m) => s + pctMap[m], 0);
        const label = g.map(m => ROLE_LABEL_ABBREV[m]).join('+');
        return (
          <button
            key={`g-${i}`}
            type="button"
            onClick={() => unmerge(i)}
            className="rounded-md px-2 py-1 text-[10px] font-medium border border-primary/50 bg-primary/10 text-primary hover:bg-primary/20"
            title="Click to unmerge"
          >
            {label} {sumPct}% <span className="ml-1 opacity-70">×</span>
          </button>
        );
      })}
      {selected.size >= 2 && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-[10px]"
          onClick={merge}
        >
          + Merge ({selected.size})
        </Button>
      )}
      {groups.length === 0 && selected.size < 2 && (
        <span className="ml-1 text-[10px] text-muted-foreground italic">
          Select 2+ chips to merge
        </span>
      )}
    </div>
  );
}

// ── Tab: Overview ───────────────────────────────────────────────────────────

function OverviewTab({
  monthly, agents, selectedMonthKey,
}: {
  monthly: MonthlyComputation[];
  agents: CommissionAgent[];
  selectedMonthKey: string | null;
}) {
  const totals = useMemo(() => {
    let eligible = 0;
    let pool = 0;
    let cancelled = 0;
    let sales = 0;
    for (const m of monthly) {
      eligible += m.eligibleRows.length;
      pool += m.pool;
      cancelled += m.cancelledCount;
      sales += m.salesAmt;
    }
    return { eligible, pool, cancelled, sales };
  }, [monthly]);

  const perMonthChart = useMemo(() => monthly.map(m => ({
    month: m.monthLabel,
    pool: m.pool,
    eligible: m.eligibleRows.length,
    sales: m.salesAmt,
  })), [monthly]);

  const perAgentTotals = useMemo(() => {
    const map = new Map<string, { name: string; total: number; color: string }>();
    for (const m of monthly) {
      for (const a of m.agents) {
        const existing = map.get(a.canonicalKey);
        if (existing) {
          existing.total += a.total;
        } else {
          map.set(a.canonicalKey, {
            name: a.name,
            total: a.total,
            color: agentColor(a.name, agents, FALLBACK_AGENT_COLOR),
          });
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [monthly, agents]);

  const statusDist = useMemo(() => {
    let paid = 0, cancelled = 0, pending = 0;
    for (const m of monthly) {
      for (const r of m.rows) {
        if (r.status === 'Paid') paid += 1;
        else if (r.status === 'Cancelled') cancelled += 1;
        else if (r.status === 'Pending') pending += 1;
      }
    }
    return [
      { name: 'Paid', value: paid, color: '#22c55e' },
      { name: 'Cancelled', value: cancelled, color: '#ef4444' },
      { name: 'Pending', value: pending, color: '#f59e0b' },
    ];
  }, [monthly]);

  const activeMonth = useMemo(
    () => monthly.find(m => m.monthKey === selectedMonthKey) ?? monthly[monthly.length - 1] ?? null,
    [monthly, selectedMonthKey]
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Total Eligible" value={totals.eligible.toLocaleString()} />
        <KpiCard label="Total Pool" value={formatPHP(totals.pool)} />
        <KpiCard label="Total Cancelled" value={totals.cancelled.toLocaleString()} />
        <KpiCard label="Total Sales" value={formatJPY(totals.sales)} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Per-month Pool & Eligible">
          <BarChart data={perMonthChart}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="month" stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 11 }} />
            <YAxis yAxisId="left" stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 11 }} />
            <YAxis yAxisId="right" orientation="right" stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 11 }} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number, name: string) => name === 'pool' ? formatPHP(v) : v.toLocaleString()} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar yAxisId="left" dataKey="pool" fill={chartColors.primary} name="Pool ₱" radius={[3, 3, 0, 0]} />
            <Bar yAxisId="right" dataKey="eligible" fill="#1756A8" name="Eligible" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartCard>

        <ChartCard title="Per-agent Total Earnings">
          <BarChart data={perAgentTotals} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis type="number" stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="name" width={100} stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 11 }} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => formatPHP(v)} />
            <Bar dataKey="total" radius={[0, 4, 4, 0]}>
              {perAgentTotals.map((a) => (
                <Cell key={a.name} fill={a.color} />
              ))}
            </Bar>
          </BarChart>
        </ChartCard>

        <ChartCard title="Per-month Sales (¥)">
          <LineChart data={perMonthChart}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="month" stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 11 }} />
            <YAxis stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 11 }} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => formatJPY(v)} />
            <Line type="monotone" dataKey="sales" stroke={chartColors.primary} strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ChartCard>

        <ChartCard title="Status Distribution">
          <PieChart>
            <Pie data={statusDist} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={90} paddingAngle={2}>
              {statusDist.map(s => <Cell key={s.name} fill={s.color} />)}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </PieChart>
        </ChartCard>
      </div>

      {activeMonth && activeMonth.split && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-card-foreground">
              {activeMonth.monthLabel} — Split Breakdown
            </h3>
            <span className="text-xs text-muted-foreground">
              Pool: {formatPHP(activeMonth.pool)} · Pool/Item: {formatPHP(activeMonth.split.pool_per_item_php)}
            </span>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Role</th>
                <th className="px-3 py-2 text-right font-medium">%</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 text-left font-medium">Winner</th>
              </tr>
            </thead>
            <tbody>
              {activeMonth.roles.map(role => {
                const winnerAgent = activeMonth.agents.find(a => a.wonRole === role.key);
                return (
                  <tr key={role.key} className="border-t border-border">
                    <td className="px-3 py-2 capitalize">{role.label}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{role.pct}%</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatPHP(Math.round(activeMonth.pool * role.pct / 100))}</td>
                    <td className="px-3 py-2">{winnerAgent?.name ?? <span className="text-muted-foreground">—</span>}</td>
                  </tr>
                );
              })}
              {(activeMonth.split.top_sales_pct || 0) > 0 && (
                <tr className="border-t border-border bg-muted/20">
                  <td className="px-3 py-2 flex items-center gap-1.5"><Star className="h-3.5 w-3.5 text-primary" /> Top Sales</td>
                  <td className="px-3 py-2 text-right tabular-nums">{activeMonth.split.top_sales_pct}%</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPHP(activeMonth.topSalesBonus)}</td>
                  <td className="px-3 py-2">{activeMonth.topSalesWinner ?? <span className="text-muted-foreground">—</span>}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Tab: Agents ─────────────────────────────────────────────────────────────

function AgentsTab({
  monthly, agents, selectedMonthKey, onMonthChange,
}: {
  monthly: MonthlyComputation[];
  agents: CommissionAgent[];
  selectedMonthKey: string | null;
  onMonthChange: (k: string) => void;
}) {
  const activeMonth = useMemo(
    () => monthly.find(m => m.monthKey === selectedMonthKey) ?? monthly[monthly.length - 1] ?? null,
    [monthly, selectedMonthKey]
  );

  // Total across all months (Dec 2025 included alongside any 2026 months).
  const totalByAgent = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of monthly) {
      for (const a of m.agents) {
        map.set(a.canonicalKey, (map.get(a.canonicalKey) ?? 0) + a.total);
      }
    }
    return map;
  }, [monthly]);

  if (!activeMonth) {
    return (
      <div className="rounded-lg border border-border bg-card p-12 text-center text-sm text-muted-foreground">
        No commission data yet.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Label className="text-xs text-muted-foreground">Month</Label>
        <Select value={activeMonth.monthKey} onValueChange={onMonthChange}>
          <SelectTrigger className="h-9 w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {monthly.map(m => (
              <SelectItem key={m.monthKey} value={m.monthKey}>{m.monthLabel}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {activeMonth.agents.map(a => {
          const color = agentColor(a.name, agents, FALLBACK_AGENT_COLOR);
          const allMonthsTotal = totalByAgent.get(a.canonicalKey) ?? 0;
          return (
            <div key={a.canonicalKey} className="rounded-lg border border-border bg-card p-4" style={{ borderTop: `3px solid ${color}` }}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h4 className="font-semibold text-card-foreground">{a.name}</h4>
                <div className="flex items-center gap-1">
                  {a.isTopSales && (
                    <Badge variant="outline" className="border-primary/40 bg-primary/10 text-[10px] text-primary">
                      <Star className="mr-1 h-3 w-3" /> Top Sales
                    </Badge>
                  )}
                  {a.tiedRole && (
                    <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-300">
                      <Scale className="mr-1 h-3 w-3" /> Tied
                    </Badge>
                  )}
                </div>
              </div>

              <div className="mb-2 flex flex-wrap gap-1.5 text-[10px]">
                {activeMonth.roles.map(role => {
                  const c = a.counts[role.key] ?? 0;
                  if (c === 0) return null;
                  const isWinner = a.wonRole === role.key;
                  return (
                    <span key={role.key} className={cn('rounded px-1.5 py-0.5 border', isWinner ? 'border-primary/40 bg-primary/10 text-primary font-medium' : 'border-border bg-muted/30 text-muted-foreground')}>
                      {role.label}: {c}
                    </span>
                  );
                })}
              </div>

              <div className="grid grid-cols-3 gap-2 text-xs">
                <div>
                  <p className="text-muted-foreground">Earn</p>
                  <p className="font-semibold tabular-nums text-card-foreground">{formatPHP(a.earn)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Bonus</p>
                  <p className="font-semibold tabular-nums text-card-foreground">{formatPHP(a.bonus)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Total</p>
                  <p className="font-semibold tabular-nums text-primary">{formatPHP(a.total)}</p>
                </div>
              </div>
              <div className="mt-2 border-t border-border pt-2 flex justify-between text-[11px]">
                <span className="text-muted-foreground">Total (all months)</span>
                <span className="font-medium tabular-nums">{formatPHP(allMonthsTotal)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Tab: Monthly ────────────────────────────────────────────────────────────

function MonthlyTab({
  monthly, selectedMonthKey, onMonthChange,
}: {
  monthly: MonthlyComputation[];
  selectedMonthKey: string | null;
  onMonthChange: (k: string) => void;
}) {
  const activeMonth = useMemo(
    () => monthly.find(m => m.monthKey === selectedMonthKey) ?? monthly[monthly.length - 1] ?? null,
    [monthly, selectedMonthKey]
  );

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold text-card-foreground">Monthly Summary</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Month</th>
                <th className="px-3 py-2 text-right font-medium">Entries</th>
                <th className="px-3 py-2 text-right font-medium">Eligible</th>
                <th className="px-3 py-2 text-right font-medium">Cancelled</th>
                <th className="px-3 py-2 text-right font-medium">Pending</th>
                <th className="px-3 py-2 text-right font-medium">Sales ¥</th>
                <th className="px-3 py-2 text-right font-medium">Pool ₱</th>
                <th className="px-3 py-2 text-left font-medium">Top Sales</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map(m => {
                const isActive = activeMonth?.monthKey === m.monthKey;
                return (
                  <tr
                    key={m.monthKey}
                    onClick={() => onMonthChange(m.monthKey)}
                    className={cn('border-t border-border cursor-pointer transition-colors', isActive ? 'bg-primary/10' : 'hover:bg-muted/30')}
                  >
                    <td className="px-3 py-2 font-medium">{m.monthLabel}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.rows.length.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.eligibleRows.length.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.cancelledCount.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.pendingCount.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatJPY(m.salesAmt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatPHP(m.pool)}</td>
                    <td className="px-3 py-2">{m.topSalesWinner ?? <span className="text-muted-foreground">—</span>}</td>
                  </tr>
                );
              })}
              {monthly.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-10 text-center text-sm text-muted-foreground">No data</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {activeMonth && (
        <>
          <div className="rounded-lg border border-border bg-card">
            <div className="border-b border-border px-4 py-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-card-foreground">
                {activeMonth.monthLabel} — Role Counts per Agent
              </h3>
              <span className="text-xs text-muted-foreground">
                {(() => {
                  const merged = activeMonth.roles.filter(r => r.members.length > 1);
                  if (merged.length > 0) return `Merged: ${merged.map(r => r.label).join(', ')}`;
                  return `${activeMonth.roles.length} role${activeMonth.roles.length === 1 ? '' : 's'}`;
                })()}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Agent</th>
                    {activeMonth.roles.map(r => (
                      <th key={r.key} className="px-3 py-2 text-right font-medium">{r.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeMonth.agents.length === 0 ? (
                    <tr><td colSpan={activeMonth.roles.length + 1} className="px-3 py-6 text-center text-sm text-muted-foreground">No agent activity this month</td></tr>
                  ) : (
                    activeMonth.agents.map(a => (
                      <tr key={a.canonicalKey} className="border-t border-border">
                        <td className="px-3 py-2 font-medium">{a.name}</td>
                        {activeMonth.roles.map(r => {
                          const c = a.counts[r.key] ?? 0;
                          const isWinner = a.wonRole === r.key;
                          return (
                            <td key={r.key} className={cn('px-3 py-2 text-right tabular-nums', isWinner && 'font-bold text-primary')}>
                              {c > 0 ? c : '—'}
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  )}
                  {activeMonth.agents.length > 0 && (
                    <tr className="border-t border-border bg-muted/30 font-semibold">
                      <td className="px-3 py-2">TOTAL</td>
                      {activeMonth.roles.map(r => {
                        const sum = activeMonth.agents.reduce((s, a) => s + (a.counts[r.key] ?? 0), 0);
                        return <td key={r.key} className="px-3 py-2 text-right tabular-nums">{sum}</td>;
                      })}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold text-card-foreground">Payout Breakdown</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Agent</th>
                    <th className="px-3 py-2 text-left font-medium">Role Won</th>
                    <th className="px-3 py-2 text-right font-medium">Earn</th>
                    <th className="px-3 py-2 text-right font-medium">Bonus</th>
                    <th className="px-3 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {activeMonth.agents.filter(a => a.total > 0).map(a => {
                    const role = activeMonth.roles.find(r => r.key === a.wonRole);
                    return (
                      <tr key={a.canonicalKey} className="border-t border-border">
                        <td className="px-3 py-2 font-medium">{a.name}</td>
                        <td className="px-3 py-2">
                          {role ? role.label : <span className="text-muted-foreground">—</span>}
                          {a.isTopSales && <span className="ml-1.5 text-primary">★</span>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatPHP(a.earn)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatPHP(a.bonus)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-primary">{formatPHP(a.total)}</td>
                      </tr>
                    );
                  })}
                  {activeMonth.agents.every(a => a.total === 0) && (
                    <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">No payouts</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Tab: Sales Log ──────────────────────────────────────────────────────────

function SalesLogTab({
  rows, agents, totalAvailable, onRefresh,
}: {
  rows: SaleRow[];
  agents: CommissionAgent[];
  totalAvailable: number;
  onRefresh: () => void;
}) {
  const [search, setSearch] = useState('');
  const [filterMonth, setFilterMonth] = useState<string[]>([]);
  const [filterStatus, setFilterStatus] = useState<string[]>([]);
  const [filterChannel, setFilterChannel] = useState<string[]>([]);
  const [filterEligible, setFilterEligible] = useState<string[]>([]); // 'Eligible' / 'Not Eligible'
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SaleRow | null>(null);

  const monthOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      const k = monthKeyFromDate(r.sale_date);
      if (k) set.add(k);
    }
    return Array.from(set).sort().reverse().map(k => ({ key: k, label: monthLabelFromKey(k) }));
  }, [rows]);

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows
      .filter(r => {
        if (filterMonth.length > 0) {
          const k = monthKeyFromDate(r.sale_date);
          if (!k || !filterMonth.includes(k)) return false;
        }
        if (filterStatus.length > 0 && !filterStatus.includes(r.status)) return false;
        if (filterChannel.length > 0 && !(r.channel && filterChannel.includes(r.channel))) return false;
        if (filterEligible.length > 0) {
          const tag = r.eligible ? 'Eligible' : 'Not Eligible';
          if (!filterEligible.includes(tag)) return false;
        }
        if (term) {
          const haystack = `${r.client_name ?? ''} ${r.item_code ?? ''}`.toLowerCase();
          if (!haystack.includes(term)) return false;
        }
        return true;
      })
      .sort((a, b) => (b.sale_date ?? '').localeCompare(a.sale_date ?? ''));
  }, [rows, search, filterMonth, filterStatus, filterChannel, filterEligible]);

  function clearFilters() {
    setSearch('');
    setFilterMonth([]);
    setFilterStatus([]);
    setFilterChannel([]);
    setFilterEligible([]);
  }

  const hasFilters = !!search || filterMonth.length || filterStatus.length || filterChannel.length || filterEligible.length;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search client or item code…" className="h-9 pl-8 text-xs" />
          </div>
          <MultiSelectFilter label="Month" options={monthOptions.map(m => m.key)} selected={filterMonth} onChange={setFilterMonth} />
          <MultiSelectFilter label="Status" options={[...STATUS_OPTIONS]} selected={filterStatus} onChange={setFilterStatus} />
          <MultiSelectFilter label="Channel" options={[...CHANNEL_OPTIONS]} selected={filterChannel} onChange={setFilterChannel} />
          <MultiSelectFilter label="Eligible" options={['Eligible', 'Not Eligible']} selected={filterEligible} onChange={setFilterEligible} />
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="h-9 text-xs text-muted-foreground">
              <X className="mr-1 h-3.5 w-3.5" /> Clear
            </Button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {filteredRows.length.toLocaleString()} of {totalAvailable.toLocaleString()}
          </span>
          <Button onClick={() => { setEditing(null); setDialogOpen(true); }} className="h-9 gold-gradient text-primary-foreground">
            <Plus className="mr-1 h-4 w-4" /> New Sale
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-left font-medium">Item Code</th>
                <th className="px-3 py-2 text-right font-medium">Amount ¥</th>
                <th className="px-3 py-2 text-left font-medium">Client</th>
                <th className="px-3 py-2 text-left font-medium">Closer</th>
                <th className="px-3 py-2 text-left font-medium">Processor</th>
                <th className="px-3 py-2 text-left font-medium">Coord</th>
                <th className="px-3 py-2 text-left font-medium">Support</th>
                <th className="px-3 py-2 text-left font-medium">Verifier</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Channel</th>
                <th className="px-3 py-2 text-center font-medium">Eligible</th>
                <th className="px-3 py-2 text-center font-medium">Invoice #</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr><td colSpan={14} className="px-3 py-10 text-center text-sm text-muted-foreground">
                  {hasFilters ? 'No sales match the current filter.' : 'No sales recorded yet.'}
                </td></tr>
              ) : (
                filteredRows.map(r => (
                  <tr key={r.id} className="border-t border-border hover:bg-muted/30">
                    <td className="px-3 py-2 text-xs">{formatShortDate(r.sale_date)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.item_code || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{Number(r.item_amount || 0).toLocaleString()}</td>
                    <td className="px-3 py-2">{r.client_name || <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-3 py-2 text-xs">{r.closer || '—'}</td>
                    <td className="px-3 py-2 text-xs">{r.processor || '—'}</td>
                    <td className="px-3 py-2 text-xs">{r.coordinator || '—'}</td>
                    <td className="px-3 py-2 text-xs">{r.support || '—'}</td>
                    <td className="px-3 py-2 text-xs">{r.verifier || '—'}</td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className={cn('text-[10px] font-medium', statusBadgeClass(r.status))}>{r.status}</Badge>
                    </td>
                    <td className="px-3 py-2 text-xs">{r.channel || '—'}</td>
                    <td className="px-3 py-2 text-center">{r.eligible ? '✓' : <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-3 py-2 text-center font-mono text-xs">{r.invoice_number || '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => { setEditing(r); setDialogOpen(true); }} aria-label="Edit">
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <SalesLogDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        agents={agents}
        onSaved={onRefresh}
      />
    </div>
  );
}

// ── Tab: Config ─────────────────────────────────────────────────────────────

function ConfigTab({
  agents, splits, onRefresh,
}: {
  agents: CommissionAgent[];
  splits: CommissionSplit[];
  onRefresh: () => void;
}) {
  const [agentDialogOpen, setAgentDialogOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<CommissionAgent | null>(null);

  // Splits editor state — local edits keyed by month; saved per-row.
  const [splitDrafts, setSplitDrafts] = useState<Record<string, CommissionSplit>>({});
  const [newSplitMonth, setNewSplitMonth] = useState('');
  const [savingMonth, setSavingMonth] = useState<string | null>(null);

  useEffect(() => {
    const drafts: Record<string, CommissionSplit> = {};
    for (const s of splits) drafts[s.month] = { ...s };
    setSplitDrafts(drafts);
  }, [splits]);

  function updateDraft(
    month: string,
    key: keyof CommissionSplit,
    value: number | boolean | string[][] | null,
  ) {
    setSplitDrafts(prev => ({ ...prev, [month]: { ...prev[month], [key]: value as never } }));
  }

  function totalPct(s: CommissionSplit): number {
    return (Number(s.closer_pct) || 0)
      + (Number(s.processor_pct) || 0)
      + (Number(s.coordinator_pct) || 0)
      + (Number(s.support_pct) || 0)
      + (Number(s.verifier_pct) || 0)
      + (Number(s.top_sales_pct) || 0);
  }

  async function saveSplit(month: string) {
    const draft = splitDrafts[month];
    if (!draft) return;
    if (totalPct(draft) !== 100) {
      toast.error('Closer + Processor + Coordinator + Support + Verifier + Top Sales must equal 100.');
      return;
    }
    setSavingMonth(month);
    try {
      const client = supabase;
      const payload = {
        closer_pct: draft.closer_pct,
        processor_pct: draft.processor_pct,
        coordinator_pct: draft.coordinator_pct,
        support_pct: draft.support_pct,
        verifier_pct: draft.verifier_pct,
        top_sales_pct: draft.top_sales_pct,
        merge_groups: draft.merge_groups ?? [],
        pool_per_item_php: draft.pool_per_item_php,
      };
      const exists = splits.some(s => s.month === month);
      const { error } = exists
        ? await client.from('commission_splits').update(payload).eq('month', month)
        : await client.from('commission_splits').insert({ month, ...payload });
      if (error) throw error;
      toast.success('Split saved');
      onRefresh();
    } catch (err: unknown) {
      toast.error((err as Error)?.message ?? 'Failed to save split');
    } finally {
      setSavingMonth(null);
    }
  }

  function addBlankSplit() {
    if (!newSplitMonth) { toast.error('Pick a month first'); return; }
    const monthKey = toDateInputValue(newSplitMonth);
    const firstOfMonth = monthKey.slice(0, 7) + '-01';
    if (splitDrafts[firstOfMonth]) { toast.error('A split for that month already exists'); return; }
    // Seed from latest prior split.
    const sorted = [...splits].sort((a, b) => b.month.localeCompare(a.month));
    const seed = sorted.find(s => s.month <= firstOfMonth) ?? sorted[0] ?? null;
    const fresh: CommissionSplit = seed
      ? { ...seed, month: firstOfMonth, merge_groups: seed.merge_groups ? seed.merge_groups.map(g => [...g]) : [] }
      : {
          month: firstOfMonth,
          closer_pct: 30, processor_pct: 20, coordinator_pct: 0,
          support_pct: 20, verifier_pct: 20, top_sales_pct: 10,
          merge_groups: [], pool_per_item_php: 100,
        };
    setSplitDrafts(prev => ({ ...prev, [firstOfMonth]: fresh }));
    setNewSplitMonth('');
  }

  const splitMonths = useMemo(
    () => Object.keys(splitDrafts).sort((a, b) => b.localeCompare(a)),
    [splitDrafts]
  );

  const sortedAgents = useMemo(
    () => [...agents].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name)),
    [agents]
  );

  async function toggleAgentActive(a: CommissionAgent, value: boolean) {
    try {
      const client = supabase;
      const { error } = await client.from('commission_agents').update({ active: value }).eq('id', a.id);
      if (error) throw error;
      toast.success(`${a.name} ${value ? 'activated' : 'deactivated'}`);
      onRefresh();
    } catch (err: unknown) {
      toast.error((err as Error)?.message ?? 'Failed to update agent');
    }
  }

  return (
    <div className="space-y-6">
      {/* Agents manager */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold text-card-foreground">Commission Agents</h3>
          <Button size="sm" onClick={() => { setEditingAgent(null); setAgentDialogOpen(true); }} className="gold-gradient text-primary-foreground">
            <Plus className="mr-1 h-4 w-4" /> New Agent
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Color</th>
                <th className="px-3 py-2 text-left font-medium">Name</th>
                <th className="px-3 py-2 text-left font-medium">Start Month</th>
                <th className="px-3 py-2 text-right font-medium">Sort</th>
                <th className="px-3 py-2 text-left font-medium">Active</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedAgents.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">No agents</td></tr>
              ) : (
                sortedAgents.map(a => (
                  <tr key={a.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <span className="inline-block h-5 w-5 rounded border border-border" style={{ background: a.color || FALLBACK_AGENT_COLOR }} />
                    </td>
                    <td className="px-3 py-2 font-medium">{a.name}</td>
                    <td className="px-3 py-2 text-xs">{a.start_month ? formatShortDate(a.start_month) : '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{a.sort_order ?? 0}</td>
                    <td className="px-3 py-2">
                      <Switch checked={!!a.active} onCheckedChange={(v) => toggleAgentActive(a, v)} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => { setEditingAgent(a); setAgentDialogOpen(true); }} aria-label="Edit">
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Splits editor */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-card-foreground">Commission Splits</h3>
            <p className="text-[11px] text-muted-foreground">Months without a row inherit the latest prior month.</p>
          </div>
          <div className="flex items-center gap-2">
            <Input type="month" value={newSplitMonth} onChange={e => setNewSplitMonth(e.target.value + '-01')} className="h-9 w-40" />
            <Button size="sm" variant="outline" onClick={addBlankSplit}>
              <Plus className="mr-1 h-4 w-4" /> Add Month
            </Button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Month</th>
                <th className="px-2 py-2 text-right font-medium">Closer %</th>
                <th className="px-2 py-2 text-right font-medium">Proc %</th>
                <th className="px-2 py-2 text-right font-medium">Coord %</th>
                <th className="px-2 py-2 text-right font-medium">Sup %</th>
                <th className="px-2 py-2 text-right font-medium">Ver %</th>
                <th className="px-2 py-2 text-right font-medium">Top %</th>
                <th className="px-3 py-2 text-right font-medium">Pool/Item ₱</th>
                <th className="px-2 py-2 text-right font-medium">Sum</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {splitMonths.length === 0 ? (
                <tr><td colSpan={10} className="px-3 py-6 text-center text-sm text-muted-foreground">No splits configured</td></tr>
              ) : (
                splitMonths.map(month => {
                  const d = splitDrafts[month];
                  const sum = totalPct(d);
                  const sumOk = sum === 100;
                  return (
                    <Fragment key={month}>
                      <tr className="border-t border-border">
                        <td className="px-3 py-2 text-xs font-medium">{monthLabelFromKey(month.slice(0, 7))}</td>
                        {(['closer_pct', 'processor_pct', 'coordinator_pct', 'support_pct', 'verifier_pct', 'top_sales_pct'] as const).map(k => (
                          <td key={k} className="px-1 py-1">
                            <Input
                              type="number"
                              value={d[k] as number}
                              onChange={e => updateDraft(month, k, Number(e.target.value))}
                              className="h-8 w-16 text-right text-xs tabular-nums"
                              min={0}
                              max={100}
                            />
                          </td>
                        ))}
                        <td className="px-2 py-1">
                          <Input
                            type="number"
                            value={d.pool_per_item_php}
                            onChange={e => updateDraft(month, 'pool_per_item_php', Number(e.target.value))}
                            className="h-8 w-20 text-right text-xs tabular-nums"
                            min={0}
                          />
                        </td>
                        <td className={cn('px-2 py-2 text-right text-xs font-semibold tabular-nums', sumOk ? 'text-green-400' : 'text-destructive')}>
                          {sum}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button size="sm" variant="outline" className="h-7" onClick={() => saveSplit(month)} disabled={savingMonth === month || !sumOk}>
                            {savingMonth === month ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
                          </Button>
                        </td>
                      </tr>
                      <tr className="border-t border-border/40 bg-muted/10">
                        <td colSpan={10} className="px-3 py-2">
                          <MergeChipsEditor
                            split={d}
                            onChange={(groups) => updateDraft(month, 'merge_groups', groups)}
                          />
                        </td>
                      </tr>
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <AgentDialog
        open={agentDialogOpen}
        onOpenChange={setAgentDialogOpen}
        editing={editingAgent}
        onSaved={onRefresh}
      />
    </div>
  );
}

// ── Small helpers ───────────────────────────────────────────────────────────

const tooltipStyle: React.CSSProperties = {
  background: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 6,
  fontSize: 12,
};

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold text-card-foreground tabular-nums">{value}</p>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactElement }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold text-card-foreground">{title}</h3>
      <div className="h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

const TAB_VALUES = ['overview', 'agents', 'monthly', 'sales-log', 'config'] as const;
type TabValue = typeof TAB_VALUES[number];

function tabFromParam(s: string | null): TabValue {
  if (s && (TAB_VALUES as readonly string[]).includes(s)) return s as TabValue;
  return 'overview';
}

export default function Commissions() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Admin gate — Config tab is admin-only. Uses the same role source
  // PermissionsContext reads from (useAuth().roles), so it matches the
  // admin short-circuit in usePermissions().can().
  const { roles } = useAuth();
  const isAdmin = roles.includes('admin');

  // Normalize the URL-derived tab against the admin gate: a deep link like
  // ?tab=config silently falls back to Overview for non-admins.
  function tabFromParamGated(s: string | null): TabValue {
    const v = tabFromParam(s);
    if (v === 'config' && !isAdmin) return 'overview';
    return v;
  }

  const [tab, setTab] = useState<TabValue>(tabFromParamGated(searchParams.get('tab')));

  useEffect(() => {
    setTab(tabFromParamGated(searchParams.get('tab')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, isAdmin]);

  function setTabAndUrl(next: string) {
    const v = tabFromParamGated(next);
    setTab(v);
    setSearchParams(v === 'overview' ? {} : { tab: v }, { replace: true });
  }

  const [rows, setRows] = useState<SaleRow[]>([]);
  const [agents, setAgents] = useState<CommissionAgent[]>([]);
  const [splits, setSplits] = useState<CommissionSplit[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMonthKey, setSelectedMonthKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const client = supabase;
      // sales_log can exceed PostgREST's 1,000-row server cap (.limit(10000)
      // does NOT override it), which truncated the dataset to the most recent
      // ~1,000 sales and made computeAllMonths see only 2 months. Paginate
      // with .range() until every row is fetched.
      async function fetchAllSalesLog() {
        const pageSize = 1000;
        let from = 0;
        let all: any[] = [];
        while (true) {
          const { data, error } = await client
            .from('sales_log')
            .select('id, sale_date, item_code, invoice_number, item_amount, client_name, closer, processor, coordinator, support, verifier, status, channel, source, opened_in_chat, closed_in_chat, eligible, notes')
            .order('sale_date', { ascending: false })
            .range(from, from + pageSize - 1);
          if (error) throw error;
          if (!data || data.length === 0) break;
          all = all.concat(data);
          if (data.length < pageSize) break;
          from += pageSize;
        }
        return all;
      }
      const [salesData, agentsRes, splitsRes] = await Promise.all([
        fetchAllSalesLog(),
        client.from('commission_agents').select('id, name, color, active, start_month, sort_order'),
        client.from('commission_splits').select('month, closer_pct, processor_pct, coordinator_pct, support_pct, verifier_pct, top_sales_pct, merge_groups, pool_per_item_php').order('month', { ascending: true }),
      ]);
      if (agentsRes.error) throw agentsRes.error;
      if (splitsRes.error) throw splitsRes.error;
      setRows((salesData as SaleRow[]) ?? []);
      setAgents((agentsRes.data as CommissionAgent[]) ?? []);
      setSplits((splitsRes.data as CommissionSplit[]) ?? []);
    } catch (err: unknown) {
      console.warn('Failed to load commissions data:', (err as Error)?.message);
      toast.error('Failed to load commissions data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const monthly = useMemo(() => computeAllMonths(rows, splits), [rows, splits]);

  // Default to latest month with data once loaded.
  useEffect(() => {
    if (selectedMonthKey == null && monthly.length > 0) {
      setSelectedMonthKey(monthly[monthly.length - 1].monthKey);
    }
  }, [monthly, selectedMonthKey]);

  return (
    <AppLayout>
      <div className="container mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl text-card-foreground">Sales Commissions</h1>
            <p className="text-xs text-muted-foreground">
              Replicates the GAS commission algorithm. Pool in ₱, sales/items in ¥. Single role per agent, winner-take-all.
            </p>
          </div>
          <span className="text-xs text-muted-foreground">
            {loading ? 'Loading…' : `${rows.length.toLocaleString()} sales · ${agents.length} agents · ${splits.length} splits`}
          </span>
        </div>

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-[400px] w-full" />
          </div>
        ) : (
          <Tabs value={tab} onValueChange={setTabAndUrl}>
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="agents">Agents</TabsTrigger>
              <TabsTrigger value="monthly">Monthly</TabsTrigger>
              <TabsTrigger value="sales-log">Sales Log</TabsTrigger>
              {isAdmin && <TabsTrigger value="config">Config</TabsTrigger>}
            </TabsList>

            <TabsContent value="overview" className="mt-4">
              <OverviewTab monthly={monthly} agents={agents} selectedMonthKey={selectedMonthKey} />
            </TabsContent>
            <TabsContent value="agents" className="mt-4">
              <AgentsTab monthly={monthly} agents={agents} selectedMonthKey={selectedMonthKey} onMonthChange={setSelectedMonthKey} />
            </TabsContent>
            <TabsContent value="monthly" className="mt-4">
              <MonthlyTab monthly={monthly} selectedMonthKey={selectedMonthKey} onMonthChange={setSelectedMonthKey} />
            </TabsContent>
            <TabsContent value="sales-log" className="mt-4">
              <SalesLogTab rows={rows} agents={agents} totalAvailable={rows.length} onRefresh={load} />
            </TabsContent>
            {isAdmin && (
              <TabsContent value="config" className="mt-4">
                <ConfigTab agents={agents} splits={splits} onRefresh={load} />
              </TabsContent>
            )}
          </Tabs>
        )}
      </div>
    </AppLayout>
  );
}
