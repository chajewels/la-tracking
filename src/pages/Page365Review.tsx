import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileInput, Image as ImageIcon, UserPlus, AlertTriangle, Info } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import NewCustomerDialog from '@/components/customers/NewCustomerDialog';
import { supabase } from '@/integrations/supabase/client';
import { usePermissions } from '@/contexts/PermissionsContext';
import { formatCurrency, generateScheduleDates } from '@/lib/calculations';
import { getPHTToday } from '@/lib/date-utils';
import type { Currency } from '@/lib/types';
import type { DbCustomer } from '@/hooks/use-supabase-data';

/* ────────────────────────────────────────────────────────────────────────────
 * The draft, exactly as page365-fetch-order returns it. Money is ALWAYS yen
 * here — Page365 invoices are JPY (owner decision 2026-09-19).
 * ──────────────────────────────────────────────────────────────────────────── */
interface DraftItem {
  /** Stable row identity, assigned at seed. NEVER key the list on the name:
   *  the name is an editable input, so a name-derived key remounts the row on
   *  every keystroke and the field loses focus. */
  rowId: string;
  kind: 'product' | 'service';
  name: string;
  sku: string | null;
  quantity: number;
  unit_price_jpy: number;
  line_total_jpy: number;
  note: string | null;
  photo_url: string | null;
  source_photo_url: string | null;
  /** What the fetch function tried and what answered, for the tooltip. Older
   *  drafts predate the field, so treat undefined as "nothing recorded". */
  photo_note?: string | null;
}

interface DraftPayload {
  page365_no: number;
  page365_slug: string;
  currency: 'JPY';
  customer: { name: string; phone: string | null; address: string | null; structural_address: unknown };
  items: DraftItem[];
  shipping_jpy: number;
  subtotal_jpy: number;
  total_jpy: number;
  fx: { php_jpy_rate: number | null; source: string; read_at: string };
  page365_stage: string | null;
  /** The invoice's own timestamps. Optional: drafts fetched before this shipped
   *  do not carry them, and the screen falls back to today as it always did. */
  page365_created_at?: string | null;
  page365_expires_on?: string | null;
  fetched_at: string;
  photo_failures: string[];
}

/** Page365 is a Japanese system and its invoice timestamps are instants. The
 *  DATE the merchant saw is therefore the Tokyo calendar date, not the Manila
 *  one — for an invoice raised late evening JST the two differ by a day, and
 *  dating the order a day early shifts every installment due date with it.
 *  This is deliberately NOT getPHTToday(): that answers "what is today here",
 *  which is a different question from "what date does this instant fall on
 *  where it was created". Both return '' on an unusable input so the caller
 *  can fall back rather than render 'Invalid Date'. */
const TOKYO = 'Asia/Tokyo';

function tokyoDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TOKYO, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** Tokyo wall-clock in the shape <input type="datetime-local"> expects. */
function tokyoDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TOKYO, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  const hh = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hh}:${get('minute')}`;
}

type OrderType = 'cash' | 'layaway';
type PlanMonths = 3 | 6 | 8 | 10 | 12;
const PLAN_OPTIONS: PlanMonths[] = [3, 6, 8, 10, 12];

/** How a suggested customer was matched — shown so the CSR can judge it. */
type MatchBasis = 'name' | 'phone' | 'name + phone';
interface Suggestion { customer: DbCustomer; basis: MatchBasis }

/** Digits only, so "+63 917 123 4567" and "09171234567" compare sensibly. */
function digits(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}

/** Surface the edge function's JSON error body (FunctionsHttpError wraps it). */
async function readFnError(error: unknown, fallback: string): Promise<string> {
  const err = error as { message?: string; context?: { body?: ReadableStream } };
  let msg = err?.message || fallback;
  try {
    if (err?.context?.body) {
      const body = await new Response(err.context.body).json();
      if (body?.error) msg = body.error;
    }
  } catch { /* keep the generic */ }
  return msg;
}

export default function Page365Review() {
  const { draftId } = useParams<{ draftId: string }>();
  const navigate = useNavigate();
  const { can } = usePermissions();

  const canCash = can('create_cash_order');
  const canLayaway = can('create_account');

  /* ── The draft ─────────────────────────────────────────────────────────── */
  const { data: draftRow, isLoading, error: loadError } = useQuery({
    queryKey: ['page365-draft', draftId],
    enabled: !!draftId,
    staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('page365_drafts')
        .select('id, page365_no, page365_slug, payload, expires_at, consumed_at')
        .eq('id', draftId!)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        throw new Error(
          'That draft has expired or was never created. Drafts last two hours — paste the Page365 link again.',
        );
      }
      // payload is `Json` in the generated types; the shape is page365-fetch-order's
      // own output. Cast at the call site — types.ts is Supabase-generated and is
      // never hand-edited (CLAUDE.md, GENERATED FILES).
      return data as unknown as {
        id: string; page365_no: number; page365_slug: string;
        payload: DraftPayload; expires_at: string; consumed_at: string | null;
      };
    },
  });

  const draft = draftRow?.payload;

  /* ── Editable state, seeded from the draft once it loads ───────────────── */
  const [orderType, setOrderType] = useState<OrderType>('cash');
  const [currency, setCurrency] = useState<Currency>('JPY');
  const [items, setItems] = useState<DraftItem[]>([]);
  const [shipping, setShipping] = useState('');   // account currency
  const [discount, setDiscount] = useState('');   // account currency
  const [totalInput, setTotalInput] = useState(''); // account currency, editable
  const [totalTouched, setTotalTouched] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [orderDate, setOrderDate] = useState(() => getPHTToday());
  const [expiresAt, setExpiresAt] = useState('');
  const [transferDueAt, setTransferDueAt] = useState('');
  const [planMonths, setPlanMonths] = useState<PlanMonths>(3);
  const [downpayment, setDownpayment] = useState('');
  const [dpTouched, setDpTouched] = useState(false);
  /** Whether the visible order date is the invoice's own, so the badge only
   *  claims "from Page365" while that is still true. Cleared the moment the
   *  CSR types over it. */
  const [orderDateFromP365, setOrderDateFromP365] = useState(false);
  const [isTrade, setIsTrade] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const seeded = useRef(false);

  /* ── Customer: suggested, never auto-selected ──────────────────────────── */
  const [customer, setCustomer] = useState<DbCustomer | null>(null);
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);

  const rate = draft?.fx?.php_jpy_rate ?? null;

  useEffect(() => {
    if (!draft || seeded.current) return;
    seeded.current = true;
    setItems(draft.items.map((i, idx) => ({ ...i, rowId: `p365-${idx}` })));
    setShipping(String(draft.shipping_jpy ?? 0));
    setTotalInput(String(draft.total_jpy ?? 0));
    setInvoiceNumber(String(draft.page365_no));
    setOrderType('cash');

    // The invoice's own date, not today's. An invoice raised on the 16th and
    // imported on the 19th is a 16th order, and every installment date follows
    // from it. Falls back to today when the draft predates these fields or
    // Page365 sent something unparseable.
    const created = tokyoDate(draft.page365_created_at);
    if (created) {
      setOrderDate(created);
      setOrderDateFromP365(true);
    }
    const expires = tokyoDateTimeLocal(draft.page365_expires_on);
    if (expires) setTransferDueAt(expires);
  }, [draft]);

  /* ── Money. Line items are ALWAYS yen (the columns are named _jpy and the
   *    loyalty basis is yen); only the account-currency figures convert. ──── */
  const productJpy = useMemo(
    () => items.filter((i) => i.kind === 'product').reduce((s, i) => s + Number(i.line_total_jpy || 0), 0),
    [items],
  );
  const serviceJpy = useMemo(
    () => items.filter((i) => i.kind === 'service').reduce((s, i) => s + Number(i.line_total_jpy || 0), 0),
    [items],
  );
  const linesJpy = productJpy + serviceJpy;

  const toAccountCurrency = (jpy: number) =>
    currency === 'JPY' ? Math.round(jpy) : Math.round(jpy * (rate ?? 0));

  /** Suggested total, in the account currency, from the lines the CSR now has. */
  const suggestedTotal = useMemo(() => {
    const shippingNum = Number(shipping) || 0;
    const discountNum = Number(discount) || 0;
    return Math.max(0, toAccountCurrency(linesJpy) + shippingNum - discountNum);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesJpy, shipping, discount, currency, rate]);

  // Keep the total in step with the lines until the CSR edits it by hand.
  useEffect(() => {
    if (!totalTouched) setTotalInput(String(suggestedTotal));
  }, [suggestedTotal, totalTouched]);

  const amount = Number(totalInput) || 0;

  /* ── Currency toggle: convert the account-currency figures with the rate the
   *    DRAFT carries (server-side system_settings.php_jpy_rate). Never
   *    getConversionRate() — that reads localStorage and is per-browser. ──── */
  const switchCurrency = (next: Currency) => {
    if (next === currency) return;
    if (next === 'PHP' && !rate) {
      toast.error('No server-side rate travelled with this draft — cannot convert to PHP.');
      return;
    }
    const conv = (v: string) => {
      const n = Number(v) || 0;
      if (!n) return v;
      // PHP = JPY × rate ; JPY = PHP ÷ rate
      return String(next === 'PHP' ? Math.round(n * rate!) : Math.round(n / rate!));
    };
    setShipping(conv(shipping));
    setDiscount(conv(discount));
    if (totalTouched) setTotalInput(conv(totalInput));
    if (dpTouched) setDownpayment(conv(downpayment));
    setCurrency(next);
  };

  /* ── Plan minimums, exactly as NewAccount enforces them ────────────────── */
  const { data: planConfigs } = useQuery({
    queryKey: ['plan-configurations'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('plan_configurations')
        .select('plan_months, min_amount_jpy, min_amount_php, dp_percentage')
        .eq('is_active', true);
      if (error) throw error;
      return (data ?? []) as Array<{
        plan_months: number; min_amount_jpy: number | null;
        min_amount_php: number | null; dp_percentage: number | null;
      }>;
    },
  });

  const planConfig = useMemo(
    () => planConfigs?.find((p) => p.plan_months === planMonths) ?? null,
    [planConfigs, planMonths],
  );
  const planMinimum = useMemo(() => {
    if (!planConfig) return null;
    const min = currency === 'JPY' ? planConfig.min_amount_jpy : planConfig.min_amount_php;
    return min != null ? Number(min) : null;
  }, [planConfig, currency]);
  const isBelowMinimum =
    orderType === 'layaway' && planMinimum !== null && planMinimum > 0 && amount > 0 && amount < planMinimum;

  // Prefill the deposit from the plan's dp_percentage until the CSR types one.
  // plan_configurations.dp_percentage is a FRACTION: every live row holds 0.30
  // and means 30%. Dividing it by 100 again produced a 0.3% deposit -- 260 pesos
  // on an 86,512 plan, which is what the first real import showed. Tolerate a
  // future row stored as 30 by reading anything above 1 as percent-out-of-100.
  const dpFraction = (pct: number) => (pct > 1 ? pct / 100 : pct);

  useEffect(() => {
    if (orderType !== 'layaway' || dpTouched) return;
    const pct = planConfig?.dp_percentage;
    if (pct != null && amount > 0) setDownpayment(String(Math.round(amount * dpFraction(Number(pct)))));
  }, [orderType, planConfig, amount, dpTouched]);

  const downpaymentAmount = Number(downpayment) || 0;
  const previewDates = orderDate && orderType === 'layaway' ? generateScheduleDates(orderDate, planMonths) : [];

  /* ── Schedule preview ───────────────────────────────────────────────────
   * This screen sends NO custom_installments, so create-layaway-account does
   * the split itself (index.ts:250-266):
   *     base      = floor(baseForInstallments / months)
   *     remainder = baseForInstallments - base * months   -> on the LAST row
   * Reproduced exactly here so the CSR is shown the schedule that will
   * actually be written, not an approximation of it. NOTE: this is the
   * remainder-on-LAST rule the edge function uses, which is NOT what
   * calculateInstallments() in src/lib/calculations.ts does (it puts the
   * remainder on the FIRST row) -- see the PR description. */
  const baseForInstallments = Math.max(0, amount - downpaymentAmount);
  const previewInstallments = useMemo(() => {
    if (orderType !== 'layaway' || planMonths <= 0 || baseForInstallments <= 0) return [];
    const base = Math.floor(baseForInstallments / planMonths);
    const rem = baseForInstallments - base * planMonths;
    return Array.from({ length: planMonths }, (_, i) => (i === planMonths - 1 ? base + rem : base));
  }, [orderType, planMonths, baseForInstallments]);
  const monthlyAmount = previewInstallments[0] ?? 0;
  const lastAmount = previewInstallments[previewInstallments.length - 1] ?? 0;

  /* ── Customer suggestions: name OR phone, same shape as NewAccount's search,
   *    but each result carries WHY it matched and nothing is auto-selected. ─ */
  const { data: suggestions } = useQuery({
    queryKey: ['page365-customer-suggestions', draft?.customer?.name, draft?.customer?.phone],
    enabled: !!draft,
    staleTime: 60_000,
    queryFn: async (): Promise<Suggestion[]> => {
      const name = draft!.customer.name?.trim() ?? '';
      const phoneDigits = digits(draft!.customer.phone);
      const filters: string[] = [];
      if (name) filters.push(`full_name.ilike.%${name}%`);
      // Match on the last 9 digits so +63/0 prefixes do not defeat it.
      if (phoneDigits.length >= 7) filters.push(`mobile_number.ilike.%${phoneDigits.slice(-9)}%`);
      if (filters.length === 0) return [];
      const { data } = await supabase
        .from('customers')
        .select('id, full_name, mobile_number, email, facebook_name, messenger_link, location, customer_code')
        .or(filters.join(','))
        .order('full_name', { ascending: true })
        .limit(10);
      const rows = ((data as unknown) || []) as DbCustomer[];
      const wantName = name.toLowerCase();
      return rows.map((c) => {
        const nameHit = !!wantName && (c.full_name ?? '').toLowerCase().includes(wantName);
        const phoneHit =
          phoneDigits.length >= 7 && digits(c.mobile_number).endsWith(phoneDigits.slice(-9));
        const basis: MatchBasis = nameHit && phoneHit ? 'name + phone' : phoneHit ? 'phone' : 'name';
        return { customer: c, basis };
      });
    },
  });

  /* ── Loyalty basis: PRODUCT lines only, always yen. A service (a resize fee)
   *    is labour the customer paid for and must never inflate tier progress. ─ */
  const loyaltyJpyAmount = productJpy > 0 ? Math.round(productJpy) : null;

  const setItem = (idx: number, patch: Partial<DraftItem>) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  /* ── Submit ────────────────────────────────────────────────────────────── */
  const canSubmitType = orderType === 'cash' ? canCash : canLayaway;
  const missing: string[] = [];
  if (!customer) missing.push('a customer');
  if (!invoiceNumber.trim()) missing.push('an invoice number');
  if (!(amount > 0)) missing.push('a total');
  if (!orderDate) missing.push('an order date');
  if (orderType === 'cash' && !expiresAt) missing.push('an expiry date');
  if (orderType === 'layaway' && isBelowMinimum) missing.push('a total at or above the plan minimum');
  const ready = missing.length === 0 && canSubmitType && !submitting;

  const submit = async () => {
    if (!draft || !draftRow || !customer) return;
    setSubmitting(true);
    setSubmitError(null);

    const submitDiscount = Number(discount) || 0;
    const itemPayload = items.map((i) => ({
      title: i.name,
      sku: i.sku,
      quantity: i.quantity,
      unit_price_jpy: Math.round(Number(i.unit_price_jpy) || 0),
      line_total_jpy: Math.round(Number(i.line_total_jpy) || 0),
      image_url: i.photo_url,
    }));

    const shared = {
      customer_id: customer.id,
      invoice_number: invoiceNumber.trim(),
      currency,
      total_amount: amount,
      order_date: orderDate,
      items: itemPayload,
      // discount_type stays null when nothing was entered — the same shape
      // NewAccount / NewCashOrder write for an untouched discount field. The
      // string '0' is truthy, so test the NUMBER, not the input.
      discount: submitDiscount > 0
        ? { amount: submitDiscount, type: 'amount', value: submitDiscount }
        : { amount: 0, type: null, value: null },
      shipping_fee: Number(shipping) || 0,
      page365_no: draft.page365_no,
      page365_slug: draft.page365_slug,
      is_trade: isTrade,
      ...(loyaltyJpyAmount ? { loyalty_jpy_amount: loyaltyJpyAmount } : {}),
    };

    const fn = orderType === 'cash' ? 'create-cash-order' : 'create-layaway-account';
    const body =
      orderType === 'cash'
        ? { ...shared, expires_at: expiresAt, notes: notes.trim() || undefined }
        : {
            ...shared,
            payment_plan_months: planMonths,
            downpayment_amount: downpaymentAmount,
            downpayment_paid: 0,
            transfer_due_at: transferDueAt || undefined,
            initial_note: notes.trim() || undefined,
          };

    try {
      const { data, error } = await supabase.functions.invoke(fn, { body });
      if (error) throw new Error(await readFnError(error, 'Could not create the order'));
      const payload = data as { error?: string; cash_order?: { id: string }; account?: { id: string } };
      if (payload?.error) throw new Error(payload.error);

      const newId = orderType === 'cash' ? payload?.cash_order?.id : payload?.account?.id;
      if (!newId) throw new Error('The order was not returned by the server.');

      // Best-effort: the order already exists and is authoritative. The real
      // double-import guard is the unique index on page365_no plus the 409 both
      // create functions return — not this flag.
      try {
        // Cast: consume_page365_draft ships in this PR's migration and is not in
        // the generated RPC union until Lovable regenerates types.ts.
        await (supabase.rpc as unknown as (
          fn: string, args: Record<string, unknown>,
        ) => Promise<unknown>)('consume_page365_draft', { p_draft_id: draftRow.id });
      } catch { /* the order stands regardless */ }

      toast.success(`Imported Page365 invoice ${draft.page365_no}`);
      navigate(orderType === 'cash' ? `/cash-orders/${newId}` : `/accounts/${newId}`);
    } catch (e) {
      // Nothing partial: both edge functions roll their own writes back, so a
      // failure here means no order, no lines, no draft consumed.
      setSubmitError((e as Error)?.message ?? 'Could not create the order');
      setSubmitting(false);
    }
  };

  /* ── Render ────────────────────────────────────────────────────────────── */
  if (isLoading) {
    return (
      <AppLayout>
        <div className="p-4 sm:p-6 space-y-4 max-w-4xl">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </AppLayout>
    );
  }

  if (loadError || !draft) {
    return (
      <AppLayout>
        <div className="p-4 sm:p-6 max-w-2xl">
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-5">
            <p className="text-sm text-destructive">
              {(loadError as Error)?.message ?? 'That draft could not be loaded.'}
            </p>
            <Button variant="outline" className="mt-3" onClick={() => navigate('/sales?tab=cash')}>
              Back to Sales
            </Button>
          </div>
        </div>
      </AppLayout>
    );
  }

  const alreadyConsumed = !!draftRow?.consumed_at;

  return (
    <AppLayout>
      <div className="p-4 sm:p-6 space-y-5 max-w-4xl">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl gold-gradient">
            <FileInput className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground font-display">
              Review Page365 invoice {draft.page365_no}
            </h1>
            <p className="text-sm text-muted-foreground">
              Nothing is created until you confirm. Every field below is editable.
            </p>
          </div>
        </div>

        {alreadyConsumed && (
          <div className="rounded-xl border border-warning/40 bg-warning/10 p-4 flex gap-2">
            <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
            <p className="text-sm text-foreground">
              This draft has already been used to create an order. Submitting again will be refused.
            </p>
          </div>
        )}

        {draft.photo_failures?.length > 0 && (
          <div className="rounded-xl border border-border bg-card p-4 flex gap-2">
            <ImageIcon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <div className="text-sm text-muted-foreground">
              <p className="text-card-foreground">Some lines have no photo:</p>
              <ul className="list-disc pl-5 mt-1 text-xs">
                {draft.photo_failures.map((f) => <li key={f}>{f}</li>)}
              </ul>
            </div>
          </div>
        )}

        {/* ── Customer ──────────────────────────────────────────────────── */}
        <section className="rounded-xl border border-border bg-card p-5 space-y-3">
          <h2 className="font-display text-base text-card-foreground">Customer</h2>
          <div className="rounded-lg border border-border bg-background p-3 text-sm space-y-0.5">
            <p className="text-card-foreground">{draft.customer.name}</p>
            {draft.customer.phone && <p className="text-muted-foreground text-xs">{draft.customer.phone}</p>}
            {draft.customer.address && <p className="text-muted-foreground text-xs">{draft.customer.address}</p>}
            <p className="text-[11px] text-muted-foreground pt-1">As Page365 has it. Page365 supplies no email.</p>
          </div>

          {customer ? (
            <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 flex items-center justify-between gap-3">
              <div className="text-sm">
                <p className="text-card-foreground font-medium">{customer.full_name}</p>
                <p className="text-xs text-muted-foreground">
                  {customer.mobile_number || 'no phone on file'}
                  {customer.customer_code ? ` · ${customer.customer_code}` : ''}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setCustomer(null)}>Change</Button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Suggested matches — none is selected for you. Check the phone before choosing.
              </p>
              {(suggestions ?? []).length === 0 && (
                <p className="text-sm text-muted-foreground">No existing customer matched.</p>
              )}
              {(suggestions ?? []).map(({ customer: c, basis }) => (
                <div key={c.id} className="rounded-lg border border-border bg-background p-3 flex items-center justify-between gap-3">
                  <div className="text-sm min-w-0">
                    <p className="text-card-foreground truncate">{c.full_name}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {c.mobile_number || 'no phone on file'}
                      {c.customer_code ? ` · ${c.customer_code}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline" className="text-[10px]">matched on {basis}</Badge>
                    <Button size="sm" variant="outline" onClick={() => setCustomer(c)}>Use this</Button>
                  </div>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="border-primary/30 text-primary hover:bg-primary/10"
                onClick={() => setNewCustomerOpen(true)}
              >
                <UserPlus className="mr-1.5 h-3.5 w-3.5" />
                Create new customer
              </Button>
            </div>
          )}
        </section>

        {/* ── Items ─────────────────────────────────────────────────────── */}
        <section className="rounded-xl border border-border bg-card p-5 space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="font-display text-base text-card-foreground">Items</h2>
            <p className="text-xs text-muted-foreground">Line prices stay in yen — the columns and the loyalty basis are yen.</p>
          </div>

          {items.map((it, idx) => (
            <div key={it.rowId} className="rounded-lg border border-border bg-background p-3 space-y-2">
              <div className="flex gap-3">
                {/* A blank box says nothing. The draft knows WHY there is no
                  * picture -- no URL came with the line at all, or one came and
                  * the copy into Hub storage failed -- and the CSR is told
                  * which. A photo is cosmetic and never blocks the import. */}
                {it.photo_url ? (
                  <img
                    src={it.photo_url}
                    alt={it.name}
                    loading="lazy"
                    className="h-16 w-16 rounded-md object-cover border border-border shrink-0"
                  />
                ) : (
                  <div
                    className="h-16 w-16 rounded-md border border-dashed border-border bg-muted flex flex-col items-center justify-center gap-0.5 shrink-0 text-center px-1"
                    title={it.photo_note
                      ?? (it.source_photo_url
                        ? 'Page365 had a photo for this line but it could not be copied into Hub storage.'
                        : 'This Page365 line carried no photo.')}
                  >
                    <ImageIcon className="h-4 w-4 text-muted-foreground" />
                    <span className="text-[8px] leading-tight text-muted-foreground">
                      {it.source_photo_url ? 'copy failed' : 'no photo'}
                    </span>
                  </div>
                )}
                <div className="flex-1 min-w-0 space-y-2">
                  <Input
                    value={it.name}
                    onChange={(e) => setItem(idx, { name: e.target.value })}
                    className="bg-card border-border text-sm"
                    aria-label={`Item ${idx + 1} name`}
                  />
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div>
                      <Label className="text-[11px]">SKU</Label>
                      <Input value={it.sku ?? ''} onChange={(e) => setItem(idx, { sku: e.target.value || null })}
                        className="bg-card border-border h-8 text-xs" />
                    </div>
                    <div>
                      <Label className="text-[11px]">Qty</Label>
                      <Input type="number" min={1} value={it.quantity}
                        onChange={(e) => setItem(idx, { quantity: Math.max(1, Number(e.target.value) || 1) })}
                        className="bg-card border-border h-8 text-xs tabular-nums" />
                    </div>
                    <div>
                      <Label className="text-[11px]">Unit ¥</Label>
                      <Input type="number" value={it.unit_price_jpy}
                        onChange={(e) => setItem(idx, { unit_price_jpy: Number(e.target.value) || 0 })}
                        className="bg-card border-border h-8 text-xs tabular-nums" />
                    </div>
                    <div>
                      <Label className="text-[11px]">Line ¥</Label>
                      <Input type="number" value={it.line_total_jpy}
                        onChange={(e) => setItem(idx, { line_total_jpy: Number(e.target.value) || 0 })}
                        className="bg-card border-border h-8 text-xs tabular-nums" />
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant={it.kind === 'product' ? 'default' : 'outline'}
                    className={it.kind === 'product' ? 'h-7 gold-gradient text-primary-foreground text-xs' : 'h-7 text-xs'}
                    onClick={() => setItem(idx, { kind: 'product' })}
                  >
                    Product
                  </Button>
                  <Button
                    size="sm"
                    variant={it.kind === 'service' ? 'default' : 'outline'}
                    className={it.kind === 'service' ? 'h-7 gold-gradient text-primary-foreground text-xs' : 'h-7 text-xs'}
                    onClick={() => setItem(idx, { kind: 'service' })}
                  >
                    Service
                  </Button>
                  {it.kind === 'service' && (
                    <span className="text-[11px] text-muted-foreground">excluded from loyalty</span>
                  )}
                </div>
                <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive"
                  onClick={() => setItems((p) => p.filter((_, i) => i !== idx))}>
                  Remove
                </Button>
              </div>

              {it.note && (
                <div className="rounded-md border border-border bg-card px-2.5 py-1.5">
                  <p className="text-[11px] text-muted-foreground">
                    <span className="text-card-foreground">Page365 note:</span> {it.note}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Shown as written. Nothing here is applied — set the term and dates yourself.
                  </p>
                </div>
              )}
            </div>
          ))}

          <div className="text-xs text-muted-foreground space-y-0.5 pt-1">
            <p>Products ¥{productJpy.toLocaleString()} · Services ¥{serviceJpy.toLocaleString()}</p>
            <p>Loyalty basis (products only): {loyaltyJpyAmount ? `¥${loyaltyJpyAmount.toLocaleString()}` : '—'}</p>
          </div>
        </section>

        {/* ── Order ─────────────────────────────────────────────────────── */}
        <section className="rounded-xl border border-border bg-card p-5 space-y-4">
          <h2 className="font-display text-base text-card-foreground">Order</h2>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant={orderType === 'cash' ? 'default' : 'outline'} disabled={!canCash}
              className={orderType === 'cash' ? 'gold-gradient text-primary-foreground' : ''}
              onClick={() => setOrderType('cash')}>Cash order</Button>
            <Button size="sm" variant={orderType === 'layaway' ? 'default' : 'outline'} disabled={!canLayaway}
              className={orderType === 'layaway' ? 'gold-gradient text-primary-foreground' : ''}
              onClick={() => setOrderType('layaway')}>Layaway plan</Button>
            <span className="mx-2 h-5 w-px bg-border" />
            <Button size="sm" variant={currency === 'JPY' ? 'default' : 'outline'}
              className={currency === 'JPY' ? 'gold-gradient text-primary-foreground' : ''}
              onClick={() => switchCurrency('JPY')}>JPY</Button>
            <Button size="sm" variant={currency === 'PHP' ? 'default' : 'outline'}
              className={currency === 'PHP' ? 'gold-gradient text-primary-foreground' : ''}
              onClick={() => switchCurrency('PHP')}>PHP</Button>
          </div>

          <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
            <Info className="h-3.5 w-3.5 shrink-0 mt-px" />
            {rate
              ? <>Rate ¥1 = ₱{rate} — from <code>{draft.fx.source}</code>, read {new Date(draft.fx.read_at).toLocaleString()}. Totals, shipping and discount convert with it; line prices stay in yen.</>
              : <>No server-side rate travelled with this draft, so PHP is unavailable. Yen only.</>}
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="p365-invoice" className="text-xs">Invoice number</Label>
              <Input id="p365-invoice" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)}
                className="bg-background border-border tabular-nums" />
            </div>
            <div>
              <Label htmlFor="p365-total" className="text-xs">Total ({currency})</Label>
              <Input id="p365-total" type="number" value={totalInput}
                onChange={(e) => { setTotalInput(e.target.value); setTotalTouched(true); }}
                className="bg-background border-border tabular-nums" />
              {!totalTouched && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  From the lines: {formatCurrency(suggestedTotal, currency)}. Edit to override.
                </p>
              )}
              {isBelowMinimum && planMinimum !== null && (
                <p className="text-[11px] text-destructive mt-1">
                  Below the {planMonths}-month minimum of {formatCurrency(planMinimum, currency)}.
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="p365-shipping" className="text-xs">Shipping ({currency})</Label>
              <Input id="p365-shipping" type="number" value={shipping}
                onChange={(e) => setShipping(e.target.value)} className="bg-background border-border tabular-nums" />
            </div>
            <div>
              <Label htmlFor="p365-discount" className="text-xs">Discount ({currency})</Label>
              <Input id="p365-discount" type="number" value={discount}
                onChange={(e) => setDiscount(e.target.value)} className="bg-background border-border tabular-nums" />
            </div>
            <div>
              <Label htmlFor="p365-orderdate" className="text-xs flex items-center gap-1.5">
                Order date
                {orderDateFromP365 && (
                  <span className="rounded-full border border-primary/40 px-1.5 py-px text-[9px] font-medium text-primary">
                    from Page365
                  </span>
                )}
              </Label>
              <Input id="p365-orderdate" type="date" value={orderDate}
                onChange={(e) => { setOrderDate(e.target.value); setOrderDateFromP365(false); }}
                className="bg-background border-border" />
            </div>
            {orderType === 'cash' ? (
              <div>
                <Label htmlFor="p365-expires" className="text-xs">Expires at</Label>
                <Input id="p365-expires" type="date" value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)} className="bg-background border-border" />
              </div>
            ) : (
              <div>
                <Label htmlFor="p365-transferdue" className="text-xs">Deposit deadline (optional)</Label>
                <Input id="p365-transferdue" type="datetime-local" value={transferDueAt}
                  onChange={(e) => setTransferDueAt(e.target.value)} className="bg-background border-border" />
              </div>
            )}
          </div>

          {orderType === 'layaway' && (
            <div className="space-y-3 pt-1">
              <div>
                <Label className="text-xs">Plan</Label>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {PLAN_OPTIONS.map((m) => {
                    const cfg = planConfigs?.find((p) => p.plan_months === m);
                    const min = cfg ? (currency === 'JPY' ? cfg.min_amount_jpy : cfg.min_amount_php) : null;
                    return (
                      <Button key={m} size="sm" variant={planMonths === m ? 'default' : 'outline'}
                        className={planMonths === m ? 'gold-gradient text-primary-foreground' : ''}
                        onClick={() => setPlanMonths(m)}>
                        <span className="flex flex-col items-center leading-tight">
                          <span>{m}M</span>
                          {min != null && Number(min) > 0 && (
                            <span className="text-[9px] opacity-80">min {formatCurrency(Number(min), currency)}</span>
                          )}
                        </span>
                      </Button>
                    );
                  })}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="p365-dp" className="text-xs">Downpayment ({currency})</Label>
                  <Input id="p365-dp" type="number" value={downpayment}
                    onChange={(e) => { setDownpayment(e.target.value); setDpTouched(true); }}
                    className="bg-background border-border tabular-nums" />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Never marked paid at creation — it clears through the payment flow.
                  </p>
                </div>
                <div>
                  <Label className="text-xs">Remaining for installments</Label>
                  <p className="text-sm text-card-foreground mt-1.5 tabular-nums font-semibold">
                    {formatCurrency(baseForInstallments, currency)}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {formatCurrency(amount, currency)} total − {formatCurrency(downpaymentAmount, currency)} deposit
                  </p>
                </div>
              </div>

              {/* Schedule preview — the exact rows create-layaway-account will write. */}
              <div className="rounded-lg border border-primary/20 bg-background p-3">
                <div className="flex items-baseline justify-between mb-2">
                  <h3 className="text-xs font-semibold text-card-foreground">
                    Schedule preview ({planMonths} months)
                  </h3>
                  {previewInstallments.length > 0 && (
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {formatCurrency(monthlyAmount, currency)} × {planMonths}
                      {lastAmount !== monthlyAmount && <> · last {formatCurrency(lastAmount, currency)}</>}
                    </span>
                  )}
                </div>

                {previewDates.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Set an order date to preview the schedule.</p>
                ) : previewInstallments.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Enter a total above the deposit to preview the monthly amounts.
                  </p>
                ) : (
                  <>
                    <div className="space-y-1">
                      {previewDates.map((date, i) => (
                        <div key={date} className="flex items-center justify-between gap-3 text-xs py-1 border-b border-border last:border-0">
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground shrink-0">
                              {i + 1}
                            </span>
                            <span className="text-card-foreground truncate">
                              {new Date(date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                            </span>
                          </span>
                          <span className="tabular-nums text-card-foreground shrink-0">
                            {formatCurrency(previewInstallments[i] ?? 0, currency)}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center justify-between pt-2 mt-1 text-xs font-semibold text-card-foreground">
                      <span>Deposit + installments</span>
                      <span className="tabular-nums">
                        {formatCurrency(
                          downpaymentAmount + previewInstallments.reduce((a, b) => a + b, 0),
                          currency,
                        )}
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          <div>
            <Label htmlFor="p365-notes" className="text-xs">Notes</Label>
            <Textarea id="p365-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              className="bg-background border-border" placeholder="Optional" />
          </div>

          <label className="flex items-center gap-2 text-sm text-card-foreground">
            <input type="checkbox" checked={isTrade} onChange={(e) => setIsTrade(e.target.checked)}
              className="h-4 w-4 accent-[hsl(var(--primary))]" />
            Trade Program
          </label>
        </section>

        {submitError && (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">{submitError}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Nothing was created — the order, its lines and the draft are all unchanged.
            </p>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pb-2">
          <Button variant="outline" onClick={() => navigate('/sales?tab=cash')} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={!ready} className="gold-gradient text-primary-foreground">
            {submitting ? 'Creating…' : orderType === 'cash' ? 'Create cash order' : 'Create layaway plan'}
          </Button>
        </div>
        {!canSubmitType && (
          <p className="text-xs text-destructive text-right -mt-2">
            You do not have permission to create a {orderType === 'cash' ? 'cash order' : 'layaway plan'}.
          </p>
        )}
        {missing.length > 0 && canSubmitType && (
          <p className="text-xs text-muted-foreground text-right -mt-2">Still needs {missing.join(', ')}.</p>
        )}

        <NewCustomerDialog
          open={newCustomerOpen}
          onOpenChange={setNewCustomerOpen}
          initialFullName={draft.customer.name}
          onCreated={(c) => { setCustomer(c); setNewCustomerOpen(false); }}
        />
      </div>
    </AppLayout>
  );
}
