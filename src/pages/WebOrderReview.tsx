import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Globe, Plus, Trash2 } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { formatCurrency } from '@/lib/calculations';
import type { Currency } from '@/lib/types';

/**
 * Website orders PR 4 — the review screen for a website DRAFT
 * (docs/WEB-ORDER-DRAFTS.md). Built to look and work like the Page365 import
 * review, as its own page so the live Page365 screen is not touched.
 *
 * The screen NEVER computes money. Every figure comes from confirm-web-draft
 * { action: 'preview' }, which uses the draft's own converted subtotal and
 * layaway_quote — the same rules Confirm applies on the server.
 *
 * Locked (W2-3): customer, pieces, prices, currency, cash / layaway, term.
 * Editable: shipping, service lines, discount, courier, deadline, notes, trade,
 * loyalty product amount.
 */

type AnyRec = Record<string, unknown>;

interface Draft {
  id: string;
  customer_id: string;
  mode: 'full' | 'layaway';
  term_months: number | null;
  settlement_currency: Currency;
  subtotal: number;
  shipping: number | null;
  total: number;
  ship_to_snapshot: AnyRec | null;
  country: string | null;
  order_type: string;
  recipient_name: string | null;
  recipient_phone: string | null;
  gift_note: string | null;
  customer_lang: string | null;
  agreement_version: string | null;
  invoice_seq: number;
  web_reference: string;
  status: 'to_confirm' | 'confirmed' | 'declined' | 'expired';
  decline_reason: string | null;
  cash_order_id: string | null;
  layaway_account_id: string | null;
  created_at: string;
}
interface DraftLine { id: string; title: string; sku: string | null; qty: number; unit_price_jpy: number; line_total_jpy: number; hold_state: string }
interface Courier { id: string; provider_name: string; title: string; is_active: boolean }
interface ServiceLine { title: string; amount: string }
interface Preview {
  errors: string[];
  currency: Currency;
  products: number;
  shipping: number | null;
  services: number;
  discount: number;
  total: number;
  loyalty_jpy_amount: number;
  loyalty_default_jpy: number;
  loyalty_tier: string | null;
  deadline_hours: number | null;
  transfer_due_at: string | null;
  layaway: { term_months: number; deposit: number | null; schedule: { installment_number: number; due_date: string; amount: number }[]; eligible: boolean } | null;
}

/** Plain-words version of every refusal the server can give. */
const PROBLEM: Record<string, string> = {
  shipping_required: 'Enter the shipping fee — this order\'s shipping was left for confirmation.',
  shipping_invalid: 'Shipping must be a whole number, 0 or more.',
  discount_invalid: 'Discount must be a whole number, 0 or more.',
  discount_exceeds_products: 'The discount is larger than the pieces\' price.',
  LOYALTY_AMOUNT_REQUIRED: 'This customer is a loyalty member: the loyalty product amount (¥) must be more than 0.',
  loyalty_jpy_amount_invalid: 'Loyalty product amount must be a whole number of yen.',
  transfer_due_at_invalid: 'The payment deadline is not a valid date and time.',
  below_plan_minimum: 'This total is below the minimum for the customer\'s layaway term.',
  quote_total_mismatch: 'The layaway figures do not add up — tell Claude, do not confirm.',
  deadline_required: 'A payment deadline is required.',
  not_open: 'This order was already confirmed, declined or cancelled.',
  hold_lost: 'The piece is no longer held for this order.',
  permission_denied: 'You do not have permission to confirm this kind of order.',
  term_locked: 'The layaway term cannot be changed.',
  agreement_missing: 'The customer has not signed the layaway agreement.',
  schedule_mismatch: 'The layaway schedule does not add up to the total.',
};
function problemText(code: string): string {
  if (PROBLEM[code]) return PROBLEM[code];
  if (/^service_lines\[\d+\]\.title_required$/.test(code)) return 'Every service line needs a name.';
  if (/^service_lines\[\d+\]\.amount_invalid$/.test(code)) return 'Service amounts must be whole numbers, 0 or more.';
  return code;
}

async function readFnBody(error: unknown): Promise<AnyRec | null> {
  const ctx = (error as { context?: unknown })?.context;
  try {
    if (ctx instanceof Response) return await ctx.clone().json();
    const body = (ctx as { body?: ReadableStream } | undefined)?.body;
    if (body) return await new Response(body).json();
  } catch { /* fall through */ }
  return null;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function addressLines(s: AnyRec | null): string[] {
  if (!s) return [];
  return [s.recipient_name, s.line1, s.line2, [s.city, s.region, s.postal_code].filter(Boolean).join(' '), s.country, s.phone]
    .map((x) => (x == null ? '' : String(x).trim())).filter(Boolean);
}

export default function WebOrderReview() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['web-draft', id],
    enabled: !!id,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tables not in the generated types yet
      const db = supabase as unknown as { from: (t: string) => any };
      const { data: draft, error } = await db.from('web_order_drafts').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      if (!draft) throw new Error('That website order could not be found, or you do not have access to it.');
      const [{ data: lines, error: lErr }, { data: customer }, { data: couriers }] = await Promise.all([
        db.from('web_order_draft_lines').select('*').eq('draft_id', id).order('created_at'),
        supabase.from('customers').select('id, full_name, facebook_name, email, mobile_number, customer_code').eq('id', (draft as Draft).customer_id).maybeSingle(),
        supabase.from('shipping_methods').select('id, provider_name, title, is_active').eq('is_active', true).order('sort_order'),
      ]);
      if (lErr) throw lErr;
      return { draft: draft as Draft, lines: (lines ?? []) as DraftLine[], customer: customer as AnyRec | null, couriers: (couriers ?? []) as Courier[] };
    },
  });
  const draft = data?.draft;
  const cur = (draft?.settlement_currency ?? 'JPY') as Currency;

  // ── Editable inputs ───────────────────────────────────────────────────
  const [shipping, setShipping] = useState<string>('');
  const [discount, setDiscount] = useState<string>('0');
  const [services, setServices] = useState<ServiceLine[]>([]);
  const [courier, setCourier] = useState<string>('');
  const [deadline, setDeadline] = useState<string>(''); // datetime-local; empty = the customer's rule
  const [notes, setNotes] = useState('');
  const [isTrade, setIsTrade] = useState(false);
  const [loyalty, setLoyalty] = useState<string>(''); // empty = the default basis
  const [declineReason, setDeclineReason] = useState('');
  const [showDecline, setShowDecline] = useState(false);
  const [busy, setBusy] = useState(false);

  // Seed once from the draft: checkout's shipping, and PH's default courier (Pabitbit, W2-10).
  useEffect(() => {
    if (!data) return;
    if (data.draft.shipping != null) setShipping(String(data.draft.shipping));
    if ((data.draft.country ?? '').toUpperCase() === 'PH') {
      const pab = data.couriers.find((c) => /pabitbit/i.test(c.provider_name) || /pabitbit/i.test(c.title));
      if (pab) setCourier(pab.id);
    }
  }, [data]);

  const request = useMemo(() => ({
    draft_id: id,
    shipping: shipping.trim() === '' ? null : Number(shipping),
    discount: discount.trim() === '' ? 0 : Number(discount),
    service_lines: services.map((s) => ({ title: s.title, amount: s.amount.trim() === '' ? 0 : Number(s.amount) })),
    transfer_due_at: deadline ? new Date(deadline).toISOString() : null,
    loyalty_jpy_amount: loyalty.trim() === '' ? null : Number(loyalty),
    planned_shipping_method_id: courier || null,
    notes,
    is_trade: isTrade,
  }), [id, shipping, discount, services, deadline, loyalty, courier, notes, isTrade]);
  const debounced = useDebounced(request, 400);

  const { data: preview, isFetching: previewing } = useQuery({
    queryKey: ['web-draft-preview', debounced],
    enabled: !!draft,
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const { data: p, error } = await supabase.functions.invoke('confirm-web-draft', { body: { ...debounced, action: 'preview' } });
      if (error) throw new Error(String((await readFnBody(error))?.error ?? error.message));
      return p as Preview;
    },
  });

  const open = draft?.status === 'to_confirm';
  const needsCourier = !courier;
  const problems = preview?.errors ?? [];
  const canConfirm = open && !!preview && problems.length === 0 && !needsCourier && !busy && !previewing;

  async function confirm() {
    if (!draft) return;
    setBusy(true);
    try {
      const { data: r, error } = await supabase.functions.invoke('confirm-web-draft', { body: { ...request, action: 'confirm' } });
      if (error) {
        const body = await readFnBody(error);
        throw new Error(problemText(String(body?.error ?? error.message)));
      }
      const res = r as AnyRec;
      const email = res.email as { sent?: boolean } | undefined;
      toast.success(`${draft.web_reference} confirmed${email?.sent ? ' — the customer was emailed the payment details' : ''}.`);
      if (email && !email.sent) toast.warning('The order is confirmed, but the email to the customer was not sent. Send the payment details on Messenger.');
      qc.invalidateQueries({ queryKey: ['web-draft', id] });
      for (const key of ['web-drafts', 'web-park']) qc.invalidateQueries({ queryKey: [key] });
      const orderPath = res.entity_type === 'cash_order' ? `/cash-orders/${res.entity_id}` : `/accounts/${res.entity_id}`;
      // W2-6: the draft carried a service request — open it on Services with
      // the job dialog ready and the agreed service fee filled in, then come
      // back to the order.
      const reqs = Array.isArray(res.service_requests) ? (res.service_requests as { id: string }[]) : [];
      if (reqs.length > 0) {
        // The server's own figure: the service lines' total, in the order currency.
        const fee = Number((res.figures as AnyRec | undefined)?.services ?? 0);
        const q = new URLSearchParams({ tab: 'requests', open: reqs[0].id, convert: '1', return: orderPath });
        if (fee > 0) q.set('fee', String(fee));
        toast.info('The customer asked for a service — create the service job now.');
        navigate(`/services?${q.toString()}`);
        return;
      }
      navigate(orderPath);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    if (!declineReason.trim()) { toast.error('Write the reason the customer will be told.'); return; }
    setBusy(true);
    try {
      const { error } = await supabase.functions.invoke('confirm-web-draft', { body: { action: 'decline', draft_id: id, reason: declineReason.trim() } });
      if (error) throw new Error(problemText(String((await readFnBody(error))?.error ?? error.message)));
      toast.success('Declined. The piece is back on sale.');
      qc.invalidateQueries({ queryKey: ['web-draft', id] });
      for (const key of ['web-drafts', 'web-park']) qc.invalidateQueries({ queryKey: [key] });
      setShowDecline(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) {
    return (
      <AppLayout>
        <div className="p-4 sm:p-6 space-y-4 max-w-4xl">
          <Skeleton className="h-10 w-64" /><Skeleton className="h-48 w-full" /><Skeleton className="h-64 w-full" />
        </div>
      </AppLayout>
    );
  }
  if (loadError || !draft || !data) {
    return (
      <AppLayout>
        <div className="p-4 sm:p-6 max-w-2xl">
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-5">
            <p className="text-sm text-destructive">{(loadError as Error)?.message ?? 'That website order could not be loaded.'}</p>
            <Button variant="outline" className="mt-3" onClick={() => navigate('/sales')}>Back to Sales</Button>
          </div>
        </div>
      </AppLayout>
    );
  }

  const address = addressLines(draft.ship_to_snapshot);
  const money = (n: number | null | undefined) => (n == null ? '—' : formatCurrency(Number(n), cur));

  return (
    <AppLayout>
      <div className="p-4 sm:p-6 space-y-5 max-w-4xl" data-testid="web-order-review">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl gold-gradient">
            <Globe className="h-5 w-5 text-primary-foreground" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-foreground font-display">
              Review website order {draft.web_reference}
            </h1>
            <p className="text-sm text-muted-foreground">
              Nothing is created until you confirm. The piece stays held for this customer until then
              (auto-cancelled 72 hours after checkout).
            </p>
          </div>
        </div>

        {!open && (
          <div className="rounded-xl border border-warning/40 bg-warning/10 p-4 flex gap-2" data-testid="web-review-closed">
            <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
            <p className="text-sm text-foreground">
              {draft.status === 'confirmed' && 'Already confirmed. '}
              {draft.status === 'declined' && `Declined: ${draft.decline_reason ?? ''} `}
              {draft.status === 'expired' && 'Auto-cancelled: not confirmed within 72 hours. '}
              {draft.cash_order_id && <a className="underline" href={`/cash-orders/${draft.cash_order_id}`}>Open the order</a>}
              {draft.layaway_account_id && <a className="underline" href={`/accounts/${draft.layaway_account_id}`}>Open the layaway</a>}
            </p>
          </div>
        )}

        {/* ── Customer (locked, W2-4) ───────────────────────────────────── */}
        <section className="rounded-xl border border-border bg-card p-5 space-y-2">
          <h2 className="font-display text-base text-card-foreground">Customer</h2>
          <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
            <p className="text-card-foreground font-medium">{String(data.customer?.full_name ?? '—')}</p>
            <p className="text-xs text-muted-foreground">
              {[data.customer?.facebook_name, data.customer?.email, data.customer?.mobile_number, data.customer?.customer_code]
                .filter(Boolean).map(String).join(' · ') || 'no contact details on file'}
            </p>
          </div>
          <p className="text-[11px] text-muted-foreground">The customer who placed the order on the website. It cannot be changed here.</p>
        </section>

        {/* ── Pieces (locked) + service lines ─────────────────────────────── */}
        <section className="rounded-xl border border-border bg-card p-5 space-y-3">
          <h2 className="font-display text-base text-card-foreground">Items</h2>
          <div className="divide-y divide-border rounded-lg border border-border">
            {data.lines.map((l) => (
              <div key={l.id} className="flex items-center justify-between gap-3 p-3 text-sm" data-testid="web-review-line">
                <div className="min-w-0">
                  <p className="text-card-foreground truncate">{l.title}</p>
                  <p className="text-xs text-muted-foreground">{l.sku ?? 'no code'} · qty {l.qty}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="secondary">Product</Badge>
                  <span className="tabular-nums">{formatCurrency(l.line_total_jpy, 'JPY')}</span>
                </div>
              </div>
            ))}
            {services.map((s, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 p-3 text-sm" data-testid="web-review-service">
                <Badge>Service</Badge>
                <Input className="h-8 flex-1 min-w-[10rem]" placeholder="Service (e.g. Resize to 12)" value={s.title}
                  onChange={(e) => setServices((all) => all.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
                <Input className="h-8 w-32" inputMode="numeric" placeholder={`Amount (${cur})`} value={s.amount}
                  onChange={(e) => setServices((all) => all.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Remove service line"
                  onClick={() => setServices((all) => all.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
          </div>
          <Button size="sm" variant="outline" className="gap-1" disabled={!open} onClick={() => setServices((all) => [...all, { title: '', amount: '' }])}>
            <Plus className="h-4 w-4" /> Add service line
          </Button>
          <p className="text-[11px] text-muted-foreground">
            The customer's pieces and prices are locked. A service line is added to the total (and to a layaway's deposit), never to loyalty points. Amounts in {cur}.
          </p>
        </section>

        {/* ── Ship to + courier ─────────────────────────────────────────── */}
        <section className="rounded-xl border border-border bg-card p-5 space-y-3">
          <h2 className="font-display text-base text-card-foreground">Ship to</h2>
          <div className="rounded-lg border border-border bg-background p-3 text-sm space-y-0.5">
            {address.length ? address.map((a, i) => <p key={i} className={i === 0 ? 'text-card-foreground' : 'text-muted-foreground text-xs'}>{a}</p>)
              : <p className="text-muted-foreground text-xs">No address on the order.</p>}
            {draft.country && <div className="pt-1"><Badge variant="outline" className="text-sm">{draft.country}</Badge></div>}
            {draft.gift_note && <p className="text-xs text-muted-foreground pt-1">Gift note: {draft.gift_note}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="courier">Courier</Label>
            <select id="courier" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={courier}
              disabled={!open} onChange={(e) => setCourier(e.target.value)}>
              <option value="">Choose a courier…</option>
              {data.couriers.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
            {needsCourier && <p className="text-xs text-warning">Choose the courier before confirming.</p>}
          </div>
        </section>

        {/* ── Order ──────────────────────────────────────────────────────── */}
        <section className="rounded-xl border border-border bg-card p-5 space-y-4">
          <h2 className="font-display text-base text-card-foreground">Order</h2>
          <div className="grid gap-3 sm:grid-cols-3 text-sm">
            <div><p className="text-xs text-muted-foreground">Invoice</p><p className="text-card-foreground">{draft.invoice_seq} · {draft.web_reference}</p></div>
            <div><p className="text-xs text-muted-foreground">Currency</p><p className="text-card-foreground">{cur}</p></div>
            <div><p className="text-xs text-muted-foreground">Type</p><p className="text-card-foreground">{draft.mode === 'full' ? 'Paid in full (cash order)' : `Layaway ${draft.term_months} months`}</p></div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="shipping">Shipping ({cur})</Label>
              <Input id="shipping" inputMode="numeric" value={shipping} disabled={!open} onChange={(e) => setShipping(e.target.value)}
                placeholder={draft.shipping == null ? 'Enter the fee' : undefined} />
              <p className="text-[11px] text-muted-foreground">
                {draft.shipping == null ? 'Shipping was left for confirmation — enter it.' : 'Carried from checkout (rate card). Change it only if needed.'}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="discount">Discount ({cur})</Label>
              <Input id="discount" inputMode="numeric" value={discount} disabled={!open} onChange={(e) => setDiscount(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="deadline">Payment deadline</Label>
              <Input id="deadline" type="datetime-local" value={deadline} disabled={!open} onChange={(e) => setDeadline(e.target.value)} />
              <p className="text-[11px] text-muted-foreground">
                {deadline ? 'Your date.' : preview?.deadline_hours ? `Leave empty for the customer's rule: ${preview.deadline_hours} hours after you confirm.` : 'Leave empty for the customer\'s rule.'}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="loyalty">Loyalty product amount (¥)</Label>
              <Input id="loyalty" inputMode="numeric" value={loyalty} disabled={!open} onChange={(e) => setLoyalty(e.target.value)}
                placeholder={preview ? String(preview.loyalty_default_jpy) : ''} />
              <p className="text-[11px] text-muted-foreground">
                Leave empty for pieces − discount{preview ? ` (¥${preview.loyalty_default_jpy.toLocaleString('en-US')})` : ''}. Never shipping or services.
                {preview?.loyalty_tier ? ` ${preview.loyalty_tier} member.` : ''}
              </p>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" rows={2} value={notes} disabled={!open} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isTrade} disabled={!open} onChange={(e) => setIsTrade(e.target.checked)} />
            Trade Program
          </label>
        </section>

        {/* ── Totals (from the Hub, never computed here) ─────────────────── */}
        <section className="rounded-xl border border-border bg-card p-5 space-y-2" data-testid="web-review-totals">
          <h2 className="font-display text-base text-card-foreground">Total {previewing && <span className="text-xs text-muted-foreground">(updating…)</span>}</h2>
          <dl className="grid grid-cols-2 gap-y-1 text-sm max-w-sm">
            <dt className="text-muted-foreground">Pieces</dt><dd className="text-right tabular-nums">{money(preview?.products)}</dd>
            <dt className="text-muted-foreground">Shipping</dt><dd className="text-right tabular-nums">{money(preview?.shipping)}</dd>
            <dt className="text-muted-foreground">Services</dt><dd className="text-right tabular-nums">{money(preview?.services)}</dd>
            <dt className="text-muted-foreground">Discount</dt><dd className="text-right tabular-nums">− {money(preview?.discount)}</dd>
            <dt className="font-medium text-card-foreground">Total</dt><dd className="text-right tabular-nums font-medium" data-testid="web-review-total">{money(preview?.total)}</dd>
          </dl>
          {draft.mode === 'layaway' && preview?.layaway && (
            <div className="pt-2 space-y-1 text-sm" data-testid="web-review-layaway">
              <p>Deposit (30%): <span className="tabular-nums font-medium">{money(preview.layaway.deposit)}</span> · {preview.layaway.term_months} monthly payments</p>
              <ul className="text-xs text-muted-foreground grid sm:grid-cols-2 gap-x-6">
                {preview.layaway.schedule.map((r) => (
                  <li key={r.installment_number} className="tabular-nums">Month {r.installment_number} · {r.due_date} · {money(r.amount)}</li>
                ))}
              </ul>
            </div>
          )}
          {problems.length > 0 && (
            <ul className="pt-2 space-y-1" data-testid="web-review-problems">
              {problems.map((p) => <li key={p} className="text-sm text-destructive flex gap-1.5"><AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />{problemText(p)}</li>)}
            </ul>
          )}
        </section>

        {open && (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <Button variant="outline" disabled={busy} onClick={() => setShowDecline((v) => !v)}>Can't supply</Button>
            <Button disabled={!canConfirm} onClick={confirm} data-testid="web-review-confirm">
              {busy ? 'Confirming…' : `Confirm ${draft.mode === 'full' ? 'cash order' : 'layaway'}`}
            </Button>
          </div>
        )}
        {open && showDecline && (
          <section className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 space-y-2">
            <Label htmlFor="decline">Reason (the customer will be told)</Label>
            <Textarea id="decline" rows={2} value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} />
            <Button variant="destructive" disabled={busy} onClick={decline}>Decline and put the piece back on sale</Button>
          </section>
        )}
      </div>
    </AppLayout>
  );
}
