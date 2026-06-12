import { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from '@/components/ui/sheet';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ScatterChart, Scatter, ReferenceLine, ReferenceArea, ZAxis, Cell,
} from 'recharts';
import {
  Pencil, Plus, X, ChevronLeft, ChevronRight, Filter, Search, Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { getPHTToday } from '@/lib/date-utils';

// ── Types ───────────────────────────────────────────────────────────────────

interface InquiryRow {
  id: string;
  item_code: string | null;
  product_name: string;
  category: string | null;
  inquiry_count: number;
  last_inquired_date: string | null;
  notes: string | null;
  source: string | null;
  action_needed: string | null;
  order_placed: string | null;
  inquirer_name: string | null;
  entered_by: string | null;
  created_at?: string;
  updated_at?: string;
}

interface DropdownOption {
  dropdown_type: string;
  value: string;
  sort_order: number | null;
}

type DropdownMap = Record<string, string[]>;

const DROPDOWN_TYPES = ['category', 'source', 'action_needed', 'order_placed', 'entered_by'] as const;
type DropdownType = typeof DROPDOWN_TYPES[number];

const PAGE_SIZE = 50;
const GOLD = '#D4AF37';

// ── Badge color helpers ─────────────────────────────────────────────────────

function sourceBadgeClass(value: string | null): string {
  switch (value) {
    case 'DM':       return 'bg-blue-500/15 text-blue-300 border-blue-500/30';
    case 'Comment':  return 'bg-purple-500/15 text-purple-300 border-purple-500/30';
    case 'Live':     return 'bg-green-500/15 text-green-300 border-green-500/30';
    default:         return 'bg-muted text-muted-foreground border-border';
  }
}

function actionNeededBadgeClass(value: string | null): string {
  switch (value) {
    case 'Details forwarded': return 'bg-primary/15 text-primary border-primary/30';
    case 'No stock':          return 'bg-red-500/15 text-red-300 border-red-500/30';
    case 'Restock soon':      return 'bg-orange-500/15 text-orange-300 border-orange-500/30';
    default:                  return 'bg-muted text-muted-foreground border-border';
  }
}

function orderPlacedBadgeClass(value: string | null): string {
  switch (value) {
    case 'Yes':       return 'bg-green-500/15 text-green-300 border-green-500/30';
    case 'No':        return 'bg-muted text-muted-foreground border-border';
    case 'Joy Mine':  return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    default:          return 'bg-muted text-muted-foreground border-border';
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: 'short', day: '2-digit',
    }).format(new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')));
  } catch {
    return '—';
  }
}

// ── Multi-select filter (Popover + Command-style checklist) ─────────────────

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
          <Filter className="h-3.5 w-3.5" />
          {label}
          {selected.length > 0 && (
            <span className="ml-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-primary/20 px-1.5 text-[10px] font-semibold text-primary">
              {selected.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2">
        <div className="max-h-64 overflow-y-auto space-y-1">
          {options.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">No options</p>
          ) : (
            options.map(opt => (
              <label
                key={opt}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted"
              >
                <Checkbox
                  checked={selected.includes(opt)}
                  onCheckedChange={() => toggle(opt)}
                />
                <span className="flex-1 truncate">{opt}</span>
              </label>
            ))
          )}
        </div>
        {selected.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 h-7 w-full text-xs text-muted-foreground"
            onClick={() => onChange([])}
          >
            Clear
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Add-new-option inline editor ────────────────────────────────────────────

function AddOptionInline({
  type, onAdded,
}: {
  type: DropdownType;
  onAdded: (newValue: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const { error } = await (supabase as any)
        .from('inquiry_dropdown_options')
        .insert({ dropdown_type: type, value: trimmed });
      if (error) throw error;
      await onAdded(trimmed);
      toast.success(`Added "${trimmed}"`);
      setValue('');
      setEditing(false);
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? 'Failed to add option';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
      >
        <Plus className="h-3 w-3" /> Add option
      </button>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-1.5">
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); save(); }
          if (e.key === 'Escape') { setEditing(false); setValue(''); }
        }}
        placeholder="New option…"
        className="h-7 text-xs"
        disabled={saving}
      />
      <Button type="button" size="sm" className="h-7 px-2 text-xs" onClick={save} disabled={saving || !value.trim()}>
        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Add'}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0"
        onClick={() => { setEditing(false); setValue(''); }}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ── Inquiry Form Sheet ──────────────────────────────────────────────────────

interface InquiryFormState {
  item_code: string;
  product_name: string;
  category: string;
  inquiry_count: number;
  last_inquired_date: string;
  notes: string;
  source: string;
  action_needed: string;
  order_placed: string;
  inquirer_name: string;
  entered_by: string;
}

function emptyForm(profileName?: string | null): InquiryFormState {
  return {
    item_code: '',
    product_name: '',
    category: '',
    inquiry_count: 1,
    last_inquired_date: getPHTToday(),
    notes: '',
    source: '',
    action_needed: '',
    order_placed: '',
    inquirer_name: '',
    entered_by: profileName || '',
  };
}

function InquiryFormSheet({
  open, onOpenChange, editing, dropdowns, onDropdownAdded, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: InquiryRow | null;
  dropdowns: DropdownMap;
  onDropdownAdded: () => Promise<void>;
  onSaved: () => void;
}) {
  const { profile } = useAuth();
  const [form, setForm] = useState<InquiryFormState>(() => emptyForm(profile?.full_name));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(editing ? {
        item_code: editing.item_code ?? '',
        product_name: editing.product_name ?? '',
        category: editing.category ?? '',
        inquiry_count: editing.inquiry_count ?? 1,
        last_inquired_date: editing.last_inquired_date ?? getPHTToday(),
        notes: editing.notes ?? '',
        source: editing.source ?? '',
        action_needed: editing.action_needed ?? '',
        order_placed: editing.order_placed ?? '',
        inquirer_name: editing.inquirer_name ?? '',
        entered_by: editing.entered_by ?? '',
      } : emptyForm(profile?.full_name));
    }
  }, [open, editing, profile?.full_name]);

  const update = <K extends keyof InquiryFormState>(key: K, value: InquiryFormState[K]) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const save = async () => {
    if (!form.product_name.trim()) {
      toast.error('Product Name is required');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        item_code: form.item_code.trim() || null,
        product_name: form.product_name.trim(),
        category: form.category || null,
        inquiry_count: Number(form.inquiry_count) || 1,
        last_inquired_date: form.last_inquired_date || null,
        notes: form.notes.trim() || null,
        source: form.source || null,
        action_needed: form.action_needed || null,
        order_placed: form.order_placed || null,
        inquirer_name: form.inquirer_name.trim() || null,
        entered_by: form.entered_by.trim() || null,
      };
      const client = supabase as any;
      const { error } = editing
        ? await client.from('product_inquiries').update(payload).eq('id', editing.id)
        : await client.from('product_inquiries').insert(payload);
      if (error) throw error;
      toast.success(editing ? 'Inquiry updated' : 'Inquiry added');
      onSaved();
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error((err as Error)?.message ?? 'Failed to save inquiry');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-md overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{editing ? 'Edit Inquiry' : 'New Inquiry'}</SheetTitle>
          <SheetDescription>
            Track a product inquiry. All dropdowns can be extended via &ldquo;Add option&rdquo;.
          </SheetDescription>
        </SheetHeader>
        <form
          onSubmit={(e) => { e.preventDefault(); save(); }}
          className="mt-4 space-y-3"
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Item Code</Label>
              <Input
                value={form.item_code}
                onChange={(e) => update('item_code', e.target.value)}
                placeholder="e.g. CJ-RING-001"
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Inquiry Count</Label>
              <Input
                type="number"
                min={1}
                value={form.inquiry_count}
                onChange={(e) => update('inquiry_count', Number(e.target.value) || 1)}
                className="h-9"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Product Name <span className="text-destructive">*</span></Label>
            <Input
              value={form.product_name}
              onChange={(e) => update('product_name', e.target.value)}
              required
              className="h-9"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Category</Label>
              <Select value={form.category} onValueChange={(v) => update('category', v)}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {(dropdowns.category ?? []).map(opt => (
                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <AddOptionInline type="category" onAdded={async () => onDropdownAdded()} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Last Inquired Date</Label>
              <Input
                type="date"
                value={form.last_inquired_date}
                onChange={(e) => update('last_inquired_date', e.target.value)}
                className="h-9"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Popular Inquiries / Notes</Label>
            <Textarea
              value={form.notes}
              onChange={(e) => update('notes', e.target.value)}
              rows={2}
              className="resize-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Source</Label>
              <Select value={form.source} onValueChange={(v) => update('source', v)}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {(dropdowns.source ?? []).map(opt => (
                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <AddOptionInline type="source" onAdded={async () => onDropdownAdded()} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Action Needed</Label>
              <Select value={form.action_needed} onValueChange={(v) => update('action_needed', v)}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {(dropdowns.action_needed ?? []).map(opt => (
                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <AddOptionInline type="action_needed" onAdded={async () => onDropdownAdded()} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Order Placed</Label>
              <Select value={form.order_placed} onValueChange={(v) => update('order_placed', v)}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {(dropdowns.order_placed ?? []).map(opt => (
                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <AddOptionInline type="order_placed" onAdded={async () => onDropdownAdded()} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Inquirer Name</Label>
              <Input
                value={form.inquirer_name}
                onChange={(e) => update('inquirer_name', e.target.value)}
                placeholder="Customer / lead"
                className="h-9"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Entered By</Label>
            <Select value={form.entered_by} onValueChange={(v) => update('entered_by', v)}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Select…" /></SelectTrigger>
              <SelectContent>
                {(dropdowns.entered_by ?? []).map(opt => (
                  <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <AddOptionInline type="entered_by" onAdded={async () => onDropdownAdded()} />
          </div>
          <SheetFooter className="mt-4 gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              type="submit"
              className="gold-gradient text-primary-foreground"
              disabled={saving || !form.product_name.trim()}
            >
              {saving ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Saving…</> : editing ? 'Save Changes' : 'Add Inquiry'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

// ── Demand Map tab ──────────────────────────────────────────────────────────

interface AggregatedItem {
  key: string;          // trim+lower of item_code OR product_name
  item_code: string;    // original display value, blank if grouped under product_name
  product_name: string; // most common
  total_inquiries: number;
  yes_count: number;
  row_count: number;
  conversion_rate: number; // 0–100
}

function aggregateByItem(rows: InquiryRow[]): AggregatedItem[] {
  const map = new Map<string, {
    item_code: string;
    productNames: Map<string, number>;
    total: number;
    yes: number;
    rowCount: number;
  }>();
  for (const r of rows) {
    const raw = (r.item_code && r.item_code.trim()) || r.product_name;
    if (!raw) continue;
    const key = raw.trim().toLowerCase();
    const display = (r.item_code && r.item_code.trim()) || '';
    const existing = map.get(key);
    if (existing) {
      existing.productNames.set(r.product_name, (existing.productNames.get(r.product_name) ?? 0) + 1);
      existing.total += Number(r.inquiry_count) || 0;
      if (r.order_placed === 'Yes') existing.yes += 1;
      existing.rowCount += 1;
    } else {
      const pn = new Map<string, number>();
      pn.set(r.product_name, 1);
      map.set(key, {
        item_code: display,
        productNames: pn,
        total: Number(r.inquiry_count) || 0,
        yes: r.order_placed === 'Yes' ? 1 : 0,
        rowCount: 1,
      });
    }
  }
  const out: AggregatedItem[] = [];
  for (const [key, v] of map.entries()) {
    let topName = '';
    let topCount = -1;
    for (const [name, c] of v.productNames.entries()) {
      if (c > topCount) { topCount = c; topName = name; }
    }
    out.push({
      key,
      item_code: v.item_code,
      product_name: topName,
      total_inquiries: v.total,
      yes_count: v.yes,
      row_count: v.rowCount,
      conversion_rate: v.rowCount > 0 ? Math.round((v.yes / v.rowCount) * 1000) / 10 : 0,
    });
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function DemandMap({ allRows, loading }: { allRows: InquiryRow[]; loading: boolean }) {
  const items = useMemo(() => aggregateByItem(allRows), [allRows]);

  const top20 = useMemo(() => {
    const sorted = [...items].sort((a, b) => b.total_inquiries - a.total_inquiries).slice(0, 20);
    return sorted.map(it => ({
      ...it,
      label: truncate(`${it.item_code || it.product_name}${it.item_code ? ` — ${it.product_name}` : ''}`, 30),
    }));
  }, [items]);

  const { medianX, maxRadius } = useMemo(() => {
    if (items.length === 0) return { medianX: 0, maxRadius: 1 };
    const xs = items.map(i => i.total_inquiries).sort((a, b) => a - b);
    const mid = Math.floor(xs.length / 2);
    const median = xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid];
    const max = Math.max(...xs);
    return { medianX: median, maxRadius: max };
  }, [items]);

  const maxX = useMemo(
    () => items.reduce((m, i) => Math.max(m, i.total_inquiries), 0) || 10,
    [items]
  );

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-[400px] w-full rounded-lg" />
        <Skeleton className="h-[500px] w-full rounded-lg" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-12 text-center">
        <p className="text-sm text-muted-foreground">No inquiry data yet. Add an inquiry to see the demand map.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Section A — Top 20 bar chart */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-card-foreground">Top 20 Most Inquired Items</h3>
          <span className="text-xs text-muted-foreground">By total inquiry count</span>
        </div>
        <div style={{ height: Math.max(320, top20.length * 28) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={top20}
              layout="vertical"
              margin={{ top: 4, right: 24, left: 8, bottom: 4 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis type="number" stroke="hsl(var(--muted-foreground))" tick={{ fontSize: 11 }} />
              <YAxis
                type="category"
                dataKey="label"
                width={220}
                stroke="hsl(var(--muted-foreground))"
                tick={{ fontSize: 11 }}
              />
              <Tooltip
                cursor={{ fill: 'hsl(var(--muted) / 0.3)' }}
                contentStyle={{
                  background: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 6,
                  fontSize: 12,
                }}
                formatter={(value: number, _name: string, ctx: { payload?: AggregatedItem }) => {
                  const it = ctx?.payload;
                  return [
                    `${value} inquiries · ${it?.conversion_rate ?? 0}% conversion`,
                    it?.item_code || it?.product_name || '',
                  ];
                }}
                labelFormatter={() => ''}
              />
              <Bar dataKey="total_inquiries" fill={GOLD} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Section B — Quadrant scatter */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-card-foreground">Demand Intelligence Quadrant</h3>
          <span className="text-xs text-muted-foreground">Volume vs conversion · median split</span>
        </div>
        <div className="h-[500px]">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 24, right: 32, left: 8, bottom: 24 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                type="number"
                dataKey="total_inquiries"
                name="Inquiry Volume"
                domain={[0, Math.ceil(maxX * 1.05)]}
                stroke="hsl(var(--muted-foreground))"
                tick={{ fontSize: 11 }}
                label={{ value: 'Inquiry Volume', position: 'insideBottom', offset: -10, fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
              />
              <YAxis
                type="number"
                dataKey="conversion_rate"
                name="Conversion Rate %"
                domain={[0, 100]}
                stroke="hsl(var(--muted-foreground))"
                tick={{ fontSize: 11 }}
                label={{ value: 'Conversion Rate %', angle: -90, position: 'insideLeft', offset: 0, fill: 'hsl(var(--muted-foreground))', fontSize: 12 }}
              />
              <ZAxis type="number" dataKey="total_inquiries" range={[40, 400]} />
              {/* Quadrant tints */}
              <ReferenceArea x1={medianX} y1={50} x2={Math.ceil(maxX * 1.05)} y2={100} fill="#22c55e" fillOpacity={0.06} stroke="none" />
              <ReferenceArea x1={0} y1={50} x2={medianX} y2={100} fill="#3b82f6" fillOpacity={0.06} stroke="none" />
              <ReferenceArea x1={medianX} y1={0} x2={Math.ceil(maxX * 1.05)} y2={50} fill="#f59e0b" fillOpacity={0.06} stroke="none" />
              <ReferenceArea x1={0} y1={0} x2={medianX} y2={50} fill="#6b7280" fillOpacity={0.05} stroke="none" />
              {/* Quadrant corner labels via SVG layers */}
              <ReferenceLine x={medianX} stroke="hsl(var(--border))" strokeDasharray="4 4" />
              <ReferenceLine y={50} stroke="hsl(var(--border))" strokeDasharray="4 4" />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                contentStyle={{
                  background: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 6,
                  fontSize: 12,
                }}
                content={({ active, payload }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const d = payload[0].payload as AggregatedItem;
                  return (
                    <div className="rounded-md border border-border bg-card p-2.5 text-xs">
                      <div className="font-mono font-semibold text-card-foreground">
                        {d.item_code || '—'}
                      </div>
                      <div className="text-muted-foreground">{d.product_name}</div>
                      <div className="mt-1.5 text-card-foreground">
                        {d.total_inquiries} inquiries · {d.conversion_rate}% conversion
                      </div>
                    </div>
                  );
                }}
              />
              <Scatter data={items} fill={GOLD}>
                {items.map((it) => (
                  <Cell key={it.key} fill={GOLD} fillOpacity={0.75} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
          <span className="rounded-md border border-blue-500/20 bg-blue-500/5 px-2 py-1 text-blue-300">💎 Niche — Low vol, high conv</span>
          <span className="rounded-md border border-green-500/20 bg-green-500/5 px-2 py-1 text-green-300">⭐ Star — High vol, high conv</span>
          <span className="rounded-md border border-muted bg-muted/30 px-2 py-1 text-muted-foreground">📦 Low Priority</span>
          <span className="rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1 text-amber-300">🔥 Opportunity — High vol, low conv</span>
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          Dot size scales with inquiry volume (max {maxRadius}). Quadrant split at median volume = {medianX} and 50% conversion.
        </p>
      </div>
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

export default function Inquiries() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get('tab') === 'demand' ? 'demand' : 'list';
  const [tab, setTab] = useState<'list' | 'demand'>(tabFromUrl);

  useEffect(() => {
    setTab(searchParams.get('tab') === 'demand' ? 'demand' : 'list');
  }, [searchParams]);

  const setTabAndUrl = (next: string) => {
    const v = next === 'demand' ? 'demand' : 'list';
    setTab(v);
    setSearchParams(v === 'demand' ? { tab: 'demand' } : {}, { replace: true });
  };

  // Dropdowns
  const [dropdowns, setDropdowns] = useState<DropdownMap>({});

  const loadDropdowns = useCallback(async () => {
    const { data, error } = await (supabase as any)
      .from('inquiry_dropdown_options')
      .select('dropdown_type, value, sort_order')
      .order('sort_order', { ascending: true, nullsFirst: false });
    if (error) {
      console.warn('Failed to load inquiry dropdowns:', error.message);
      return;
    }
    const grouped: DropdownMap = {};
    for (const row of (data as DropdownOption[] | null) ?? []) {
      if (!grouped[row.dropdown_type]) grouped[row.dropdown_type] = [];
      if (!grouped[row.dropdown_type].includes(row.value)) {
        grouped[row.dropdown_type].push(row.value);
      }
    }
    setDropdowns(grouped);
  }, []);

  useEffect(() => { loadDropdowns(); }, [loadDropdowns]);

  // ── List tab state ───────────────────────────────────────────────────────
  const [rows, setRows] = useState<InquiryRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState<string[]>([]);
  const [filterSource, setFilterSource] = useState<string[]>([]);
  const [filterActionNeeded, setFilterActionNeeded] = useState<string[]>([]);
  const [filterOrderPlaced, setFilterOrderPlaced] = useState<string[]>([]);
  const [filterEnteredBy, setFilterEnteredBy] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // ── Demand map state ─────────────────────────────────────────────────────
  const [allRows, setAllRows] = useState<InquiryRow[]>([]);
  const [demandLoading, setDemandLoading] = useState(true);

  // Form sheet
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<InquiryRow | null>(null);

  // Reset to page 0 whenever a filter changes
  useEffect(() => {
    setPage(0);
  }, [search, filterCategory, filterSource, filterActionNeeded, filterOrderPlaced, filterEnteredBy, dateFrom, dateTo]);

  const loadList = useCallback(async () => {
    setListLoading(true);
    try {
      const client = supabase as any;
      let q = client
        .from('product_inquiries')
        .select('*', { count: 'exact' })
        .order('last_inquired_date', { ascending: false, nullsFirst: false });

      const term = search.trim();
      if (term) {
        const escaped = term.replace(/,/g, '\\,');
        q = q.or(
          `item_code.ilike.%${escaped}%,product_name.ilike.%${escaped}%,inquirer_name.ilike.%${escaped}%`
        );
      }
      if (filterCategory.length > 0)      q = q.in('category', filterCategory);
      if (filterSource.length > 0)        q = q.in('source', filterSource);
      if (filterActionNeeded.length > 0)  q = q.in('action_needed', filterActionNeeded);
      if (filterOrderPlaced.length > 0)   q = q.in('order_placed', filterOrderPlaced);
      if (filterEnteredBy.length > 0)     q = q.in('entered_by', filterEnteredBy);
      if (dateFrom) q = q.gte('last_inquired_date', dateFrom);
      if (dateTo)   q = q.lte('last_inquired_date', dateTo);

      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      q = q.range(from, to);

      const { data, count, error } = await q;
      if (error) throw error;
      setRows((data as InquiryRow[]) ?? []);
      setTotalCount(count ?? 0);
    } catch (err: unknown) {
      console.warn('Failed to load inquiries:', (err as Error)?.message);
      toast.error('Failed to load inquiries');
    } finally {
      setListLoading(false);
    }
  }, [page, search, filterCategory, filterSource, filterActionNeeded, filterOrderPlaced, filterEnteredBy, dateFrom, dateTo]);

  const loadAll = useCallback(async () => {
    setDemandLoading(true);
    try {
      const client = supabase as any;
      const { data, error } = await client
        .from('product_inquiries')
        .select('id, item_code, product_name, category, inquiry_count, last_inquired_date, source, action_needed, order_placed, inquirer_name, entered_by');
      if (error) throw error;
      setAllRows((data as InquiryRow[]) ?? []);
    } catch (err: unknown) {
      console.warn('Failed to load inquiries for demand map:', (err as Error)?.message);
      toast.error('Failed to load demand map data');
    } finally {
      setDemandLoading(false);
    }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { if (tab === 'demand') loadAll(); }, [tab, loadAll]);

  const clearFilters = () => {
    setSearch('');
    setFilterCategory([]);
    setFilterSource([]);
    setFilterActionNeeded([]);
    setFilterOrderPlaced([]);
    setFilterEnteredBy([]);
    setDateFrom('');
    setDateTo('');
  };

  const hasActiveFilters =
    !!search.trim() || filterCategory.length || filterSource.length ||
    filterActionNeeded.length || filterOrderPlaced.length || filterEnteredBy.length ||
    !!dateFrom || !!dateTo;

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const refresh = () => {
    loadList();
    if (tab === 'demand') loadAll();
  };

  return (
    <div className="container mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-card-foreground">Product Inquiries</h1>
          <p className="text-xs text-muted-foreground">
            Track customer interest, identify demand patterns, and surface restock priorities.
          </p>
        </div>
        <Button
          className="gold-gradient text-primary-foreground"
          onClick={() => { setEditing(null); setFormOpen(true); }}
        >
          <Plus className="mr-1.5 h-4 w-4" /> New Inquiry
        </Button>
      </div>

      <Tabs value={tab} onValueChange={setTabAndUrl}>
        <TabsList>
          <TabsTrigger value="list">Inquiry List</TabsTrigger>
          <TabsTrigger value="demand">Demand Map</TabsTrigger>
        </TabsList>

        {/* ── Tab 1: Inquiry List ───────────────────────────────────────── */}
        <TabsContent value="list" className="mt-4 space-y-3">
          {/* Filters row */}
          <div className="rounded-lg border border-border bg-card p-3 space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px] max-w-sm">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search item code, product, inquirer…"
                  className="h-9 pl-8 text-xs"
                />
              </div>
              <MultiSelectFilter label="Category"      options={dropdowns.category ?? []}       selected={filterCategory}     onChange={setFilterCategory} />
              <MultiSelectFilter label="Source"        options={dropdowns.source ?? []}         selected={filterSource}       onChange={setFilterSource} />
              <MultiSelectFilter label="Action Needed" options={dropdowns.action_needed ?? []}  selected={filterActionNeeded} onChange={setFilterActionNeeded} />
              <MultiSelectFilter label="Order Placed"  options={dropdowns.order_placed ?? []}   selected={filterOrderPlaced}  onChange={setFilterOrderPlaced} />
              <MultiSelectFilter label="Entered By"    options={dropdowns.entered_by ?? []}     selected={filterEnteredBy}    onChange={setFilterEnteredBy} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5">
                <Label className="text-xs text-muted-foreground">Last inquired</Label>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="h-9 w-[140px] text-xs"
                />
                <span className="text-xs text-muted-foreground">–</span>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="h-9 w-[140px] text-xs"
                />
              </div>
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters} className="h-9 text-xs text-muted-foreground">
                  <X className="mr-1 h-3.5 w-3.5" /> Clear Filters
                </Button>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                {listLoading ? 'Loading…' : `${totalCount.toLocaleString()} inquir${totalCount === 1 ? 'y' : 'ies'}`}
              </span>
            </div>
          </div>

          {/* Table */}
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Item Code</th>
                    <th className="px-3 py-2 text-left font-medium">Product Name</th>
                    <th className="px-3 py-2 text-left font-medium">Category</th>
                    <th className="px-3 py-2 text-right font-medium">Inq.</th>
                    <th className="px-3 py-2 text-left font-medium">Last Inquired</th>
                    <th className="px-3 py-2 text-left font-medium">Source</th>
                    <th className="px-3 py-2 text-left font-medium">Action Needed</th>
                    <th className="px-3 py-2 text-left font-medium">Order Placed</th>
                    <th className="px-3 py-2 text-left font-medium">Inquirer</th>
                    <th className="px-3 py-2 text-left font-medium">Entered By</th>
                    <th className="px-3 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {listLoading ? (
                    Array.from({ length: 6 }).map((_, i) => (
                      <tr key={i} className="border-t border-border">
                        <td colSpan={11} className="px-3 py-3">
                          <Skeleton className="h-5 w-full" />
                        </td>
                      </tr>
                    ))
                  ) : rows.length === 0 ? (
                    <tr className="border-t border-border">
                      <td colSpan={11} className="px-3 py-10 text-center text-sm text-muted-foreground">
                        {hasActiveFilters ? 'No inquiries match these filters.' : 'No inquiries yet. Click "New Inquiry" to add one.'}
                      </td>
                    </tr>
                  ) : (
                    rows.map((r) => (
                      <tr key={r.id} className="border-t border-border hover:bg-muted/30">
                        <td className="px-3 py-2 font-mono text-xs">{r.item_code || '—'}</td>
                        <td className="px-3 py-2 text-card-foreground">{r.product_name}</td>
                        <td className="px-3 py-2">
                          {r.category ? (
                            <Badge variant="outline" className="border-primary/30 bg-primary/10 text-[10px] font-medium text-primary">
                              {r.category}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.inquiry_count ?? 0}</td>
                        <td className="px-3 py-2 text-xs">{formatDate(r.last_inquired_date)}</td>
                        <td className="px-3 py-2">
                          {r.source ? (
                            <Badge variant="outline" className={cn('text-[10px] font-medium', sourceBadgeClass(r.source))}>
                              {r.source}
                            </Badge>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2">
                          {r.action_needed ? (
                            <Badge variant="outline" className={cn('text-[10px] font-medium', actionNeededBadgeClass(r.action_needed))}>
                              {r.action_needed}
                            </Badge>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2">
                          {r.order_placed ? (
                            <Badge variant="outline" className={cn('text-[10px] font-medium', orderPlacedBadgeClass(r.order_placed))}>
                              {r.order_placed}
                            </Badge>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{r.inquirer_name || '—'}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{r.entered_by || '—'}</td>
                        <td className="px-3 py-2 text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0"
                            onClick={() => { setEditing(r); setFormOpen(true); }}
                            aria-label="Edit"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {!listLoading && totalCount > PAGE_SIZE && (
              <div className="flex items-center justify-between border-t border-border bg-muted/20 px-3 py-2 text-xs">
                <span className="text-muted-foreground">
                  Page {page + 1} of {totalPages} · {totalCount.toLocaleString()} total
                </span>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    disabled={page === 0}
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" /> Prev
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  >
                    Next <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── Tab 2: Demand Map ─────────────────────────────────────────── */}
        <TabsContent value="demand" className="mt-4">
          <DemandMap allRows={allRows} loading={demandLoading} />
        </TabsContent>
      </Tabs>

      <InquiryFormSheet
        open={formOpen}
        onOpenChange={(v) => { if (!v) setEditing(null); setFormOpen(v); }}
        editing={editing}
        dropdowns={dropdowns}
        onDropdownAdded={loadDropdowns}
        onSaved={refresh}
      />
    </div>
  );
}
