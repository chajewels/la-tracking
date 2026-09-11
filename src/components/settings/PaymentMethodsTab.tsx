import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Landmark, Smartphone, Wallet, CircleDollarSign, Loader2, Eye, EyeOff, Save, ShieldAlert,
  Clock, Plus, Trash2, ChevronUp, ChevronDown, Pencil, X,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { formatPHTDisplay } from '@/lib/date-utils';

/**
 * Settings -> Payment Details. Admin-only editor for the transfer methods the
 * storefront offers a customer who chooses bank transfer at checkout.
 *
 * A LIST, not a form. The previous design had one row per country with one bank
 * block welded into it, so a second Japanese account or a Maya wallet alongside
 * GCash needed a schema change. Here each method is a row that can be added,
 * reordered, switched off, or deleted.
 *
 * Three rules shape the screen:
 *
 * 1. TWO REGIONS, NEVER MIXED. Japan covers orders shipping inside Japan;
 *    Overseas covers every other destination. A customer is shown one region's
 *    methods and never learns the other exists.
 *
 * 2. NO PLACEHOLDERS, EVER. Empty means empty. The website function drops any
 *    method that is not COMPLETE for its type, and a region with nothing
 *    complete offers no transfer at all — better than showing an account that
 *    does not exist. The per-card badge says exactly what the site is doing.
 *
 * 3. ACCOUNT NUMBERS ARE MASKED until clicked. They are the only thing here
 *    worth something to someone reading over a shoulder, and the Hub gets used
 *    on shared screens.
 */

type Region = 'JP' | 'OVERSEAS';
type MethodType = 'bank' | 'gcash' | 'maya' | 'other';

interface MethodRow {
  id: string;
  region: Region;
  method_type: MethodType;
  label_ja: string | null;
  label_en: string | null;
  bank_name: string | null;
  bank_branch: string | null;
  account_type: string | null;
  account_number: string | null;
  account_holder: string | null;
  wallet_number: string | null;
  wallet_name: string | null;
  note_ja: string | null;
  note_en: string | null;
  sort_order: number;
  is_active: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

type Draft = Pick<
  MethodRow,
  'label_ja' | 'label_en' | 'bank_name' | 'bank_branch' | 'account_type'
  | 'account_number' | 'account_holder' | 'wallet_number' | 'wallet_name'
  | 'note_ja' | 'note_en'
>;

const EDITABLE: (keyof Draft)[] = [
  'label_ja', 'label_en',
  'bank_name', 'bank_branch', 'account_type', 'account_number', 'account_holder',
  'wallet_number', 'wallet_name', 'note_ja', 'note_en',
];

const EMPTY_DRAFT: Draft = {
  label_ja: null, label_en: null,
  bank_name: null, bank_branch: null, account_type: null,
  account_number: null, account_holder: null,
  wallet_number: null, wallet_name: null, note_ja: null, note_en: null,
};

const REGIONS: { code: Region; title: string; blurb: string }[] = [
  { code: 'JP', title: 'Japan — 日本', blurb: 'Shown when the order ships to a Japanese address.' },
  { code: 'OVERSEAS', title: 'Overseas — 海外', blurb: 'Shown for every other destination, the Philippines included.' },
];

const METHOD_TYPES: {
  type: MethodType;
  label: string;
  icon: typeof Landmark;
  /** Which field groups this type shows. */
  bank: boolean;
  wallet: boolean;
  defaults: { ja: string; en: string };
}[] = [
  { type: 'bank', label: 'Bank account', icon: Landmark, bank: true, wallet: false, defaults: { ja: '銀行振込', en: 'Bank transfer' } },
  { type: 'gcash', label: 'GCash', icon: Smartphone, bank: false, wallet: true, defaults: { ja: 'GCash', en: 'GCash' } },
  { type: 'maya', label: 'Maya', icon: Wallet, bank: false, wallet: true, defaults: { ja: 'Maya', en: 'Maya' } },
  { type: 'other', label: 'Other method', icon: CircleDollarSign, bank: true, wallet: true, defaults: { ja: '', en: '' } },
];

const typeSpec = (t: MethodType) => METHOD_TYPES.find((m) => m.type === t) ?? METHOD_TYPES[3];

const clean = (v: string | null | undefined) => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};

/**
 * Mirrors the website function's completeness rule EXACTLY (see methodIsComplete
 * in supabase/functions/website/index.ts). If these two drift apart, an admin
 * sees "live" on a method the storefront is silently dropping — so change them
 * together or not at all.
 */
function isComplete(type: MethodType, d: Draft): boolean {
  switch (type) {
    case 'bank':
      return !!(clean(d.bank_name) && clean(d.account_number) && clean(d.account_holder));
    case 'gcash':
    case 'maya':
      return !!(clean(d.wallet_number) && clean(d.wallet_name));
    case 'other':
      return !!(
        (clean(d.label_ja) || clean(d.label_en)) &&
        (clean(d.note_ja) || clean(d.note_en) || clean(d.account_number) || clean(d.wallet_number))
      );
    default:
      return false;
  }
}

/** What is missing, in the admin's words — a badge saying "incomplete" is not help. */
function missingFields(type: MethodType, d: Draft): string[] {
  if (type === 'bank') {
    return [
      !clean(d.bank_name) && 'bank name',
      !clean(d.account_number) && 'account number',
      !clean(d.account_holder) && 'account holder',
    ].filter(Boolean) as string[];
  }
  if (type === 'gcash' || type === 'maya') {
    return [
      !clean(d.wallet_number) && 'wallet number',
      !clean(d.wallet_name) && 'wallet name',
    ].filter(Boolean) as string[];
  }
  return [
    !(clean(d.label_ja) || clean(d.label_en)) && 'a label',
    !(clean(d.note_ja) || clean(d.note_en) || clean(d.account_number) || clean(d.wallet_number)) && 'at least one detail',
  ].filter(Boolean) as string[];
}

function maskAccount(value: string | null) {
  const v = (value ?? '').trim();
  if (!v) return '—';
  if (v.length <= 4) return '•'.repeat(v.length);
  return '•'.repeat(Math.max(v.length - 4, 4)) + v.slice(-4);
}

const draftOf = (row: MethodRow): Draft =>
  Object.fromEntries(EDITABLE.map((f) => [f, row[f] ?? null])) as Draft;

export default function PaymentMethodsTab() {
  const { user, roles } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isAdmin = roles.includes('admin' as never);
  const userId = user?.id ?? null;

  const { data: rows, isLoading } = useQuery({
    queryKey: ['transfer-payment-methods'],
    staleTime: 30_000,
    // Staff can SELECT this table under RLS, but nothing here is for them —
    // don't fetch account details for a non-admin at all.
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('transfer_payment_methods' as never)
        .select('*')
        .order('region')
        .order('sort_order')
        .order('created_at');
      if (error) throw error;
      return (data ?? []) as unknown as MethodRow[];
    },
  });

  const refresh = useCallback(
    () => qc.invalidateQueries({ queryKey: ['transfer-payment-methods'] }),
    [qc],
  );

  /**
   * Every mutation writes an audit row. The account number itself is never
   * written there — only whether it changed. An audit trail that copies the
   * secret into a second, more widely-readable table defeats masking it here.
   */
  const audit = useCallback(async (
    action: string,
    methodId: string,
    payload: Json,
  ) => {
    await supabase.from('audit_logs').insert({
      entity_type: 'transfer_payment_method',
      entity_id: methodId,
      action,
      old_value_json: null,
      new_value_json: payload,
      performed_by_user_id: userId,
    });
  }, [userId]);

  const byRegion = useMemo(() => {
    const m: Record<Region, MethodRow[]> = { JP: [], OVERSEAS: [] };
    for (const r of rows ?? []) if (m[r.region]) m[r.region].push(r);
    return m;
  }, [rows]);

  if (!isAdmin) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 flex items-start gap-3">
        <ShieldAlert className="h-4 w-4 text-warning mt-0.5" />
        <div>
          <p className="text-sm font-medium text-card-foreground">Admins only</p>
          <p className="text-sm text-muted-foreground mt-1">
            Transfer account details can be viewed and changed by administrators only.
          </p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading payment methods…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-sm font-semibold text-card-foreground">Transfer payment methods</h3>
        <p className="text-sm text-muted-foreground mt-1.5 max-w-[74ch]">
          Shown to a customer who chooses bank transfer at website checkout, in Japanese and
          English, in the order set here. Saved here, live on the site immediately — there is
          no deploy. A customer sees only their own region: a Japanese address gets the Japan
          methods, everywhere else gets Overseas. A region with no complete, active method
          does not offer transfer at all, and the customer is asked to contact us instead.
          Leave a field blank rather than filling it with anything provisional.
        </p>
      </div>

      {REGIONS.map(({ code, title, blurb }) => (
        <RegionSection
          key={code}
          region={code}
          title={title}
          blurb={blurb}
          methods={byRegion[code]}
          userId={userId}
          audit={audit}
          onChanged={refresh}
          toast={toast}
        />
      ))}
    </div>
  );
}

type Toast = (o: { title: string; description?: string; variant?: 'destructive' }) => void;
type Audit = (action: string, methodId: string, payload: Json) => Promise<void>;

function RegionSection({
  region, title, blurb, methods, userId, audit, onChanged, toast,
}: {
  region: Region;
  title: string;
  blurb: string;
  methods: MethodRow[];
  userId: string | null;
  audit: Audit;
  onChanged: () => void;
  toast: Toast;
}) {
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<MethodType | null>(null);
  const liveCount = methods.filter((m) => m.is_active && isComplete(m.method_type, draftOf(m))).length;

  const addMethod = async (type: MethodType) => {
    setBusy(true);
    try {
      const spec = typeSpec(type);
      const nextOrder = methods.reduce((max, m) => Math.max(max, m.sort_order), 0) + 10;
      const { data, error } = await supabase
        .from('transfer_payment_methods' as never)
        .insert({
          region,
          method_type: type,
          label_ja: spec.defaults.ja || null,
          label_en: spec.defaults.en || null,
          sort_order: nextOrder,
          // A new method starts switched ON but is empty, so it is incomplete
          // and the storefront ignores it until the details are filled in.
          is_active: true,
          updated_by: userId,
        } as never)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      const newId = (data as { id?: string } | null)?.id ?? null;
      // The insert selected its own id, so this is only ever skipped if the
      // select came back empty — never silently, the toast below still fires.
      if (newId) {
        await audit('payment_method_added', newId, {
          region, method_type: type, sort_order: nextOrder,
        });
      }
      setAdding(type);
      onChanged();
    } catch (e) {
      toast({ title: 'Could not add method', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Up/down swaps this row's sort_order with its neighbour's. Two writes rather
   * than renumbering the whole list: fewer rows touched, and a failure between
   * them leaves a duplicate order value, which created_at already breaks.
   */
  const move = async (index: number, delta: -1 | 1) => {
    const a = methods[index];
    const b = methods[index + delta];
    if (!a || !b) return;
    setBusy(true);
    try {
      const { error: e1 } = await supabase.from('transfer_payment_methods' as never)
        .update({ sort_order: b.sort_order, updated_by: userId } as never).eq('id', a.id);
      if (e1) throw e1;
      const { error: e2 } = await supabase.from('transfer_payment_methods' as never)
        .update({ sort_order: a.sort_order, updated_by: userId } as never).eq('id', b.id);
      if (e2) throw e2;
      await audit('payment_method_reordered', a.id, {
        region, moved: a.id, swapped_with: b.id,
        from_sort_order: a.sort_order, to_sort_order: b.sort_order,
      });
      onChanged();
    } catch (e) {
      toast({ title: 'Could not reorder', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-card-foreground">{title}</h3>
          <p className="text-sm text-muted-foreground mt-1">{blurb}</p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
              liveCount > 0
                ? 'border-success/40 bg-success/10 text-success'
                : 'border-warning/40 bg-warning/10 text-warning'
            }`}
          >
            {liveCount > 0
              ? `${liveCount} method${liveCount === 1 ? '' : 's'} live at checkout`
              : 'Transfer not offered'}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={busy}>
                <Plus className="h-4 w-4 mr-1.5" /> Add method
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {METHOD_TYPES.map(({ type, label, icon: Icon }) => (
                <DropdownMenuItem key={type} onSelect={() => void addMethod(type)}>
                  <Icon className="h-4 w-4 mr-2" /> {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {methods.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No methods yet. Until one is added and filled in, bank transfer is not offered for
          this region at checkout.
        </p>
      ) : (
        <ul className="space-y-3">
          {methods.map((m, i) => (
            <MethodCard
              key={m.id}
              method={m}
              startEditing={adding === m.method_type && i === methods.length - 1}
              isFirst={i === 0}
              isLast={i === methods.length - 1}
              onMoveUp={() => void move(i, -1)}
              onMoveDown={() => void move(i, 1)}
              userId={userId}
              audit={audit}
              onChanged={onChanged}
              toast={toast}
              busy={busy}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function MethodCard({
  method, startEditing, isFirst, isLast, onMoveUp, onMoveDown, userId, audit, onChanged, toast, busy,
}: {
  method: MethodRow;
  startEditing: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  userId: string | null;
  audit: Audit;
  onChanged: () => void;
  toast: Toast;
  busy: boolean;
}) {
  const spec = typeSpec(method.method_type);
  const saved = draftOf(method);

  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState<Draft>(saved);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = useCallback((field: keyof Draft, value: string) => {
    setDraft((d) => ({ ...d, [field]: value }));
  }, []);

  const complete = isComplete(method.method_type, draft);
  const missing = missingFields(method.method_type, draft);
  const dirty = EDITABLE.some((f) => clean(draft[f]) !== clean(saved[f]));
  const heading = clean(draft.label_en) ?? clean(draft.label_ja) ?? spec.label;

  const save = async () => {
    setSaving(true);
    try {
      const payload = Object.fromEntries(EDITABLE.map((f) => [f, clean(draft[f])])) as Record<string, string | null>;
      const { error } = await supabase
        .from('transfer_payment_methods' as never)
        .update({ ...payload, updated_by: userId } as never)
        .eq('id', method.id);
      if (error) throw error;

      await audit('payment_method_updated', method.id, {
        region: method.region,
        method_type: method.method_type,
        changed_fields: EDITABLE.filter((f) => clean(draft[f]) !== clean(saved[f])),
        account_number_changed: clean(draft.account_number) !== clean(saved.account_number),
        wallet_number_changed: clean(draft.wallet_number) !== clean(saved.wallet_number),
        complete_after: complete,
      });

      toast({ title: 'Saved', description: `${heading} updated.` });
      setEditing(false);
      setRevealed(false);
      onChanged();
    } catch (e) {
      toast({ title: 'Save failed', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (next: boolean) => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from('transfer_payment_methods' as never)
        .update({ is_active: next, updated_by: userId } as never)
        .eq('id', method.id);
      if (error) throw error;
      await audit(next ? 'payment_method_activated' : 'payment_method_deactivated', method.id, {
        region: method.region, method_type: method.method_type,
      });
      onChanged();
    } catch (e) {
      toast({ title: 'Could not change status', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      // Audit BEFORE the delete: once the row is gone the audit row is the only
      // record that it existed, and it must not depend on the delete succeeding
      // silently. Field values are not copied into it — only what it was.
      await audit('payment_method_deleted', method.id, {
        region: method.region,
        method_type: method.method_type,
        label_en: clean(saved.label_en),
        label_ja: clean(saved.label_ja),
        had_account_number: !!clean(saved.account_number),
        had_wallet_number: !!clean(saved.wallet_number),
      });
      const { error } = await supabase
        .from('transfer_payment_methods' as never)
        .delete()
        .eq('id', method.id);
      if (error) throw error;
      toast({ title: 'Deleted', description: `${heading} removed.` });
      onChanged();
    } catch (e) {
      toast({ title: 'Delete failed', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setSaving(false);
      setConfirmDelete(false);
    }
  };

  const Icon = spec.icon;

  return (
    <li className="rounded-lg border border-border/70 bg-background/40">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="flex flex-col">
          <Button variant="ghost" size="icon" className="h-6 w-6" disabled={isFirst || busy || saving}
            onClick={onMoveUp} aria-label={`Move ${heading} up`}>
            <ChevronUp className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" disabled={isLast || busy || saving}
            onClick={onMoveDown} aria-label={`Move ${heading} down`}>
            <ChevronDown className="h-4 w-4" />
          </Button>
        </div>

        <Icon className="h-4 w-4 text-primary shrink-0" />

        <div className="min-w-[12rem] flex-1">
          <p className="text-sm font-medium text-card-foreground">{heading}</p>
          <p className="text-xs text-muted-foreground font-mono mt-0.5">
            {method.method_type === 'bank'
              ? [clean(saved.bank_name), maskAccount(saved.account_number)].filter(Boolean).join(' · ')
              : [clean(saved.wallet_name), maskAccount(saved.wallet_number)].filter(Boolean).join(' · ') || '—'}
          </p>
        </div>

        <span
          className={`rounded-md border px-2 py-0.5 text-xs font-medium ${
            !method.is_active
              ? 'border-border bg-muted text-muted-foreground'
              : complete
                ? 'border-success/40 bg-success/10 text-success'
                : 'border-warning/40 bg-warning/10 text-warning'
          }`}
        >
          {!method.is_active ? 'Off' : complete ? 'Live' : `Needs ${missing.join(', ')}`}
        </span>

        <div className="flex items-center gap-1.5">
          <Switch
            checked={method.is_active}
            onCheckedChange={(v) => void toggleActive(v)}
            disabled={saving || busy}
            aria-label={`${method.is_active ? 'Deactivate' : 'Activate'} ${heading}`}
          />
          <Button variant="ghost" size="icon" onClick={() => setEditing((e) => !e)} aria-label={`Edit ${heading}`}>
            {editing ? <X className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => setConfirmDelete(true)}
            aria-label={`Delete ${heading}`} disabled={saving || busy}>
            <Trash2 className="h-4 w-4 text-danger" />
          </Button>
        </div>
      </div>

      {editing && (
        <div className="space-y-5 border-t border-border/70 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Label (日本語)" value={draft.label_ja} onChange={(v) => set('label_ja', v)} placeholder={spec.defaults.ja} />
            <Field label="Label (English)" value={draft.label_en} onChange={(v) => set('label_en', v)} placeholder={spec.defaults.en} />
          </div>

          {spec.wallet && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Wallet number" value={draft.wallet_number} onChange={(v) => set('wallet_number', v)} mono />
              <Field label="Registered name" value={draft.wallet_name} onChange={(v) => set('wallet_name', v)} />
            </div>
          )}

          {spec.bank && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Bank name" value={draft.bank_name} onChange={(v) => set('bank_name', v)} />
              <Field label="Branch" value={draft.bank_branch} onChange={(v) => set('bank_branch', v)} />
              <Field
                label="Account type"
                value={draft.account_type}
                onChange={(v) => set('account_type', v)}
                placeholder={method.region === 'JP' ? '普通 / 当座' : 'Savings / Current'}
              />
              <Field label="Account holder" value={draft.account_holder} onChange={(v) => set('account_holder', v)} />

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={`acct-${method.id}`} className="text-xs text-muted-foreground">
                  Account number
                </Label>
                <div className="flex items-center gap-2">
                  {revealed ? (
                    <Input
                      id={`acct-${method.id}`}
                      value={draft.account_number ?? ''}
                      onChange={(e) => set('account_number', e.target.value)}
                      className="font-mono"
                      autoComplete="off"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setRevealed(true)}
                      className="flex h-10 w-full items-center rounded-md border border-input bg-background px-3 text-left font-mono text-sm text-muted-foreground hover:border-primary/50"
                      aria-label="Reveal and edit account number"
                    >
                      {maskAccount(draft.account_number)}
                    </button>
                  )}
                  <Button
                    type="button" variant="ghost" size="icon"
                    onClick={() => setRevealed((r) => !r)}
                    aria-label={revealed ? 'Hide account number' : 'Reveal account number'}
                  >
                    {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`note-ja-${method.id}`} className="text-xs text-muted-foreground">
                Extra note (日本語) — optional
              </Label>
              <Textarea id={`note-ja-${method.id}`} rows={2} value={draft.note_ja ?? ''} onChange={(e) => set('note_ja', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`note-en-${method.id}`} className="text-xs text-muted-foreground">
                Extra note (English) — optional
              </Label>
              <Textarea id={`note-en-${method.id}`} rows={2} value={draft.note_en ?? ''} onChange={(e) => set('note_en', e.target.value)} />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              {method.updated_at
                ? <>Last updated {formatPHTDisplay(method.updated_at)}{method.updated_by ? ' · by an admin' : ''}</>
                : <>Never updated</>}
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => { setDraft(saved); setRevealed(false); setEditing(false); }} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving || !dirty}>
                {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
                Save
              </Button>
            </div>
          </div>
        </div>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {heading}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the method and its account details permanently. If you only want to
              stop offering it for now, switch it off instead — that keeps the details and takes
              it off the storefront immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

function Field({
  label, value, onChange, placeholder, mono,
}: {
  label: string;
  value: string | null;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={mono ? 'font-mono' : undefined}
        autoComplete="off"
      />
    </div>
  );
}
