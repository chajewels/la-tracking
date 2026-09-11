import { useState, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Landmark, Smartphone, Loader2, Eye, EyeOff, Save, ShieldAlert, Clock } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatPHTDisplay } from '@/lib/date-utils';

/**
 * Settings -> Payment Details. Admin-only editor for the bank / GCash details
 * the storefront shows a customer who chose bank transfer at checkout.
 *
 * Two rules shape this screen:
 *
 * 1. NO PLACEHOLDERS, EVER. Empty means empty. The website function treats a
 *    country with no COMPLETE method as "transfer not offered" and checkout
 *    hides it — better than showing a customer an account that does not exist.
 *    So this form never pre-fills example values, and the completeness badge
 *    tells the admin exactly what the site is doing right now.
 *
 * 2. THE ACCOUNT NUMBER IS MASKED until clicked. It is the one field on this
 *    screen that is worth something to a shoulder-surfer, and the Hub is used
 *    on shared screens.
 */

type Country = 'JP' | 'PH';

interface InstructionRow {
  country: string;
  method_label_ja: string | null;
  method_label_en: string | null;
  bank_name: string | null;
  bank_branch: string | null;
  account_type: string | null;
  account_number: string | null;
  account_holder: string | null;
  gcash_number: string | null;
  gcash_name: string | null;
  note_ja: string | null;
  note_en: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

/** Editable subset. `country` is the key and is never edited here. */
type Draft = Omit<InstructionRow, 'country' | 'updated_at' | 'updated_by'>;

const EDITABLE_FIELDS: (keyof Draft)[] = [
  'method_label_ja', 'method_label_en',
  'bank_name', 'bank_branch', 'account_type', 'account_number', 'account_holder',
  'gcash_number', 'gcash_name', 'note_ja', 'note_en',
];

const COUNTRIES: { code: Country; label: string; gcash: boolean }[] = [
  { code: 'JP', label: 'Japan — 日本', gcash: false },
  { code: 'PH', label: 'Philippines — Pilipinas', gcash: true },
];

const clean = (v: string | null | undefined) => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};

/**
 * Mirrors the website function's completeness rule exactly. If these two ever
 * disagree, the admin sees "ready" while checkout hides transfer — so keep
 * them in step.
 */
function methodState(d: Draft) {
  const bank = !!(clean(d.bank_name) && clean(d.account_number) && clean(d.account_holder));
  const gcash = !!(clean(d.gcash_number) && clean(d.gcash_name));
  return { bank, gcash, ready: bank || gcash };
}

function maskAccount(value: string | null) {
  const v = (value ?? '').trim();
  if (!v) return '—';
  if (v.length <= 4) return '•'.repeat(v.length);
  return '•'.repeat(Math.max(v.length - 4, 4)) + v.slice(-4);
}

export default function PaymentInstructionsTab() {
  const { user, roles } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isAdmin = roles.includes('admin' as never);

  const { data: rows, isLoading } = useQuery({
    queryKey: ['payment-instructions'],
    staleTime: 30_000,
    // Staff can SELECT this table under RLS, but nothing here is for them —
    // don't even fetch the account details for a non-admin.
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payment_instructions' as never)
        .select('*')
        .order('country');
      if (error) throw error;
      return (data ?? []) as unknown as InstructionRow[];
    },
  });

  const byCountry = useMemo(() => {
    const m = new Map<string, InstructionRow>();
    for (const r of rows ?? []) m.set(r.country, r);
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
        <Loader2 className="h-4 w-4 animate-spin" /> Loading payment details…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-sm font-semibold text-card-foreground">Transfer payment details</h3>
        <p className="text-sm text-muted-foreground mt-1.5 max-w-[70ch]">
          Shown to a customer who chooses bank transfer at website checkout, in Japanese and
          English. Saved here, live on the site immediately — there is no deploy.
          A country with no complete method does not offer transfer at checkout at all;
          the customer is asked to contact us instead. Leave a field blank rather than
          filling it with anything provisional.
        </p>
      </div>

      {COUNTRIES.map(({ code, label, gcash }) => (
        <CountryCard
          key={code}
          country={code}
          label={label}
          showGcash={gcash}
          row={byCountry.get(code) ?? null}
          userId={user?.id ?? null}
          onSaved={() => qc.invalidateQueries({ queryKey: ['payment-instructions'] })}
          toast={toast}
        />
      ))}
    </div>
  );
}

function CountryCard({
  country, label, showGcash, row, userId, onSaved, toast,
}: {
  country: Country;
  label: string;
  showGcash: boolean;
  row: InstructionRow | null;
  userId: string | null;
  onSaved: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toast: (o: any) => void;
}) {
  const emptyDraft: Draft = {
    method_label_ja: null, method_label_en: null,
    bank_name: null, bank_branch: null, account_type: null,
    account_number: null, account_holder: null,
    gcash_number: null, gcash_name: null, note_ja: null, note_en: null,
  };
  const initial: Draft = row
    ? Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, row[f] ?? null])) as Draft
    : emptyDraft;

  const [draft, setDraft] = useState<Draft>(initial);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedBy, setSavedBy] = useState<string | null>(null);

  const set = useCallback((field: keyof Draft, value: string) => {
    setDraft((d) => ({ ...d, [field]: value }));
  }, []);

  const state = methodState(draft);
  const dirty = EDITABLE_FIELDS.some((f) => clean(draft[f]) !== clean(initial[f]));

  const save = async () => {
    setSaving(true);
    try {
      const payload = Object.fromEntries(
        EDITABLE_FIELDS.map((f) => [f, clean(draft[f])]),
      ) as Record<string, string | null>;

      const { error } = await supabase
        .from('payment_instructions' as never)
        .update({ ...payload, updated_at: new Date().toISOString(), updated_by: userId } as never)
        .eq('country', country);
      if (error) throw error;

      // Audit every save. The account number itself is NOT written to the audit
      // row — only whether it changed. An audit trail that copies the secret
      // into a second, more widely-readable table defeats masking it here.
      const changed = EDITABLE_FIELDS.filter((f) => clean(draft[f]) !== clean(initial[f]));
      await supabase.from('audit_logs').insert({
        entity_type: 'payment_instructions',
        entity_id: row?.country ?? country,
        action: 'payment_details_updated',
        old_value_json: { country, methods_before: methodState(initial) },
        new_value_json: {
          country,
          changed_fields: changed,
          account_number_changed: clean(draft.account_number) !== clean(initial.account_number),
          methods_after: state,
        },
        performed_by_user_id: userId,
      });

      setSavedBy(userId);
      toast({ title: 'Saved', description: `${country} transfer details updated.` });
      onSaved();
    } catch (e) {
      toast({
        title: 'Save failed',
        description: (e as Error).message,
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Landmark className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-card-foreground">{label}</h3>
        </div>
        <span
          className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
            state.ready
              ? 'border-success/40 bg-success/10 text-success'
              : 'border-warning/40 bg-warning/10 text-warning'
          }`}
        >
          {state.ready ? 'Transfer offered at checkout' : 'Not offered — details incomplete'}
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Method label (日本語)" value={draft.method_label_ja} onChange={(v) => set('method_label_ja', v)} placeholder="銀行振込" />
        <Field label="Method label (English)" value={draft.method_label_en} onChange={(v) => set('method_label_en', v)} placeholder="Bank transfer" />
      </div>

      {showGcash && (
        <section className="space-y-3 rounded-lg border border-border/70 p-4">
          <div className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-primary" />
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">GCash</h4>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="GCash number" value={draft.gcash_number} onChange={(v) => set('gcash_number', v)} />
            <Field label="GCash name" value={draft.gcash_name} onChange={(v) => set('gcash_name', v)} />
          </div>
          <p className="text-xs text-muted-foreground">
            Both fields are needed before GCash appears at checkout.
          </p>
        </section>
      )}

      <section className="space-y-3 rounded-lg border border-border/70 p-4">
        <div className="flex items-center gap-2">
          <Landmark className="h-4 w-4 text-primary" />
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Bank</h4>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bank name" value={draft.bank_name} onChange={(v) => set('bank_name', v)} />
          <Field label="Branch" value={draft.bank_branch} onChange={(v) => set('bank_branch', v)} />
          <Field label="Account type" value={draft.account_type} onChange={(v) => set('account_type', v)} placeholder={country === 'JP' ? '普通 / 当座' : 'Savings / Current'} />
          <Field label="Account holder" value={draft.account_holder} onChange={(v) => set('account_holder', v)} />

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={`acct-${country}`} className="text-xs text-muted-foreground">
              Account number
            </Label>
            <div className="flex items-center gap-2">
              {revealed ? (
                <Input
                  id={`acct-${country}`}
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
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setRevealed((r) => !r)}
                aria-label={revealed ? 'Hide account number' : 'Reveal account number'}
              >
                {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Bank name, account number and account holder are all needed before bank transfer
          appears at checkout. Branch and account type are shown when filled.
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`note-ja-${country}`} className="text-xs text-muted-foreground">
            Extra note (日本語) — optional
          </Label>
          <Textarea id={`note-ja-${country}`} rows={3} value={draft.note_ja ?? ''} onChange={(e) => set('note_ja', e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`note-en-${country}`} className="text-xs text-muted-foreground">
            Extra note (English) — optional
          </Label>
          <Textarea id={`note-en-${country}`} rows={3} value={draft.note_en ?? ''} onChange={(e) => set('note_en', e.target.value)} />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          {row?.updated_at
            ? <>Last updated {formatPHTDisplay(row.updated_at)}{(savedBy ?? row.updated_by) ? ' · by an admin' : ''}</>
            : <>Never updated</>}
        </p>
        <Button onClick={save} disabled={saving || !dirty}>
          {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
          Save {country}
        </Button>
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, placeholder,
}: {
  label: string;
  value: string | null;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
      />
    </div>
  );
}
