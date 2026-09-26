import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileInput, Image as ImageIcon, UserPlus, AlertTriangle, Info, Wand2 } from 'lucide-react';
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
import {
  CHIP_CLASS, flaggedTitle, importSummary, previewChip, stockModeFrom,
  type ImportStockResult, type Page365StockMatch,
} from '@/lib/page365-stock';
import { suggestCustomers, searchCustomers, MIN_SEARCH_LENGTH } from '@/lib/page365-customer-match';

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
  /** 1-based position in the draft as fetched. Stock is taken from the DRAFT's
   *  line at this position, so it survives the CSR removing rows above it. */
  lineNo: number;
  /** Read-only stock preview written at fetch time. Older drafts predate it. */
  stock_match?: Page365StockMatch | null;
}

interface DraftPayload {
  page365_no: number;
  page365_slug: string;
  currency: 'JPY';
  customer: { name: string; phone: string | null; address: string | null; structural_address: unknown };
  items: DraftItem[];
  shipping_jpy: number;
  subtotal_jpy: number;
  /** subtotal + shipping − discount = total. Page365 discounts the INVOICE, not
   *  the lines, so the item subtotals above are at full price. Optional because
   *  drafts fetched before the discount shipped do not carry them — treat a
   *  missing value as no discount, which is what those invoices had. */
  discount_jpy?: number;
  discount_breakdown?: { price_discount_jpy: number; campaign_discount_jpy: number };
  /** Shown to the CSR beside the discount. Never written to the order. */
  promotion_code?: string | null;
  discount_campaign_name?: string | null;
  total_jpy: number;
  fx: { php_jpy_rate: number | null; source: string; read_at: string };
  page365_stage: string | null;
  /** The invoice's own timestamps. Optional: drafts fetched before this shipped
   *  do not carry them, and the screen falls back to today as it always did. */
  page365_created_at?: string | null;
  page365_expires_on?: string | null;
  fetched_at: string;
  photo_failures: string[];
  /** PR 2: which import behaviour was live at fetch time. Absent on older
   *  drafts — stockModeFrom reads that as inventory_sync, the live mode. */
  stock_mode?: string;
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

/** Equal installments, or amounts the CSR types per month (as NewAccount). */
type InstallmentMode = 'equal' | 'custom';

/**
 * create-layaway-account's own equal split (index.ts, "equal-distribution"):
 * floor per month, the remainder on the LAST row. Used for the Equal preview
 * and to pre-fill the Custom boxes.
 */
function equalSplit(total: number, months: number): number[] {
  if (months <= 0 || total <= 0) return [];
  const base = Math.floor(total / months);
  const rem = total - base * months;
  return Array.from({ length: months }, (_, i) => (i === months - 1 ? base + rem : base));
}

/** Columns loaded for the customer directory the suggestions and search run on. */
const CUSTOMER_DIRECTORY_COLUMNS =
  'id, full_name, mobile_number, email, facebook_name, messenger_link, location, customer_code';
/** PostgREST returns at most 1,000 rows per request; the directory pages through. */
const DIRECTORY_PAGE = 1000;

/**
 * Every customer, for matching in code. Phones are compared on digits only
 * (src/lib/page365-customer-match.ts), which a database text filter cannot do
 * on a stored "949-247-9913" — the reason invoice 19794 found no one.
 */
async function loadCustomerDirectory(): Promise<DbCustomer[]> {
  const all: DbCustomer[] = [];
  for (let from = 0; ; from += DIRECTORY_PAGE) {
    const { data, error } = await supabase
      .from('customers')
      .select(CUSTOMER_DIRECTORY_COLUMNS)
      .order('id', { ascending: true })
      .range(from, from + DIRECTORY_PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = ((data as unknown) || []) as DbCustomer[];
    all.push(...rows);
    if (rows.length < DIRECTORY_PAGE) return all;
  }
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

/** One pickable customer — used by the suggestions and the manual search. */
function CustomerOption({ c, badge, onUse }: { c: DbCustomer; badge?: string; onUse: () => void }) {
  const fb = (c.facebook_name ?? '').trim();
  const showFb = !!fb && fb.toLowerCase() !== (c.full_name ?? '').trim().toLowerCase();
  return (
    <div className="rounded-lg border border-border bg-background p-3 flex items-center justify-between gap-3">
      <div className="text-sm min-w-0">
        <p className="text-card-foreground truncate">{c.full_name}</p>
        {showFb && <p className="text-xs text-muted-foreground truncate">FB: {fb}</p>}
        <p className="text-xs text-muted-foreground truncate">
          {c.mobile_number || 'no phone on file'}
          {c.customer_code ? ` · ${c.customer_code}` : ''}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {badge && <Badge variant="outline" className="text-[10px]">{badge}</Badge>}
        <Button size="sm" variant="outline" onClick={onUse}>Use this</Button>
      </div>
    </div>
  );
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
  /** Whether the CSR has typed over the discount Page365 supplied. While false,
   *  the loyalty basis uses the draft's exact yen figure rather than converting
   *  the input back — a PHP round trip loses yen to rounding twice. */
  const [discountTouched, setDiscountTouched] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [orderDate, setOrderDate] = useState(() => getPHTToday());
  const [expiresAt, setExpiresAt] = useState('');
  const [transferDueAt, setTransferDueAt] = useState('');
  const [planMonths, setPlanMonths] = useState<PlanMonths>(3);
  const [downpayment, setDownpayment] = useState('');
  const [dpTouched, setDpTouched] = useState(false);
  /** Custom installments (layaway only) — the same option NewAccount offers. */
  const [installmentMode, setInstallmentMode] = useState<InstallmentMode>('equal');
  const [customAmounts, setCustomAmounts] = useState<string[]>([]);
  /** Once the CSR types a month, the boxes stop following the equal split. */
  const [customEdited, setCustomEdited] = useState(false);
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
    setItems(draft.items.map((i, idx) => ({ ...i, rowId: `p365-${idx}`, lineNo: idx + 1 })));
    setShipping(String(draft.shipping_jpy ?? 0));
    // The invoice's own discount, in yen. Currency is still JPY at seed time,
    // so a later switch to PHP converts it through switchCurrency at the
    // draft's rate, exactly like shipping.
    if ((draft.discount_jpy ?? 0) > 0) setDiscount(String(draft.discount_jpy));
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
    // Typed custom amounts were in the old currency: start again from the
    // equal split in the new one.
    setCustomEdited(false);
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
   * EQUAL (default): this screen sends NO custom_installments, so
   * create-layaway-account does the split itself — floor per month, the
   * remainder on the LAST row (equalSplit above). Reproduced exactly so the
   * CSR sees the schedule that will actually be written. NOTE: this is NOT
   * what calculateInstallments() in src/lib/calculations.ts does (it puts the
   * remainder on the FIRST row).
   * CUSTOM (owner request 2026-09-26, same option as NewAccount): the CSR
   * types each month; custom_installments is sent and create-layaway-account
   * refuses it unless it adds up to total − deposit. */
  const baseForInstallments = Math.max(0, amount - downpaymentAmount);
  const previewInstallments = useMemo(
    () => (orderType === 'layaway' ? equalSplit(baseForInstallments, planMonths) : []),
    [orderType, planMonths, baseForInstallments],
  );
  const monthlyAmount = previewInstallments[0] ?? 0;
  const lastAmount = previewInstallments[previewInstallments.length - 1] ?? 0;

  const isCustom = orderType === 'layaway' && installmentMode === 'custom';
  // Until the CSR types a month, the Custom boxes follow the equal split (plan,
  // total, deposit or currency changes). A plan change always refills them —
  // the number of months is different.
  useEffect(() => {
    if (!isCustom) return;
    if (customEdited && customAmounts.length === planMonths) return;
    const split = equalSplit(baseForInstallments, planMonths);
    setCustomAmounts(split.length ? split.map(String) : Array(planMonths).fill(''));
    setCustomEdited(false);
  }, [isCustom, customEdited, customAmounts.length, planMonths, baseForInstallments]);

  // Whole amounts, as NewAccount sends them (parseInt).
  const customValues = customAmounts.map((v) => parseInt(v, 10) || 0);
  const customTotal = customValues.reduce((a, b) => a + b, 0);
  const customReady = isCustom && customAmounts.length === planMonths;
  const customMismatch = customReady && customTotal !== baseForInstallments;
  const customHasEmpty = isCustom && (!customReady || customValues.some((v) => v <= 0));
  const scheduleAmounts = customReady ? customValues : previewInstallments;

  const updateCustomAmount = (index: number, value: string) => {
    setCustomAmounts((prev) => prev.map((v, i) => (i === index ? value : v)));
    setCustomEdited(true);
  };
  /** Same as NewAccount: the last month takes whatever the others leave. */
  const autoAdjustLastMonth = () => {
    if (customAmounts.length !== planMonths) return;
    const sumExceptLast = customValues.slice(0, -1).reduce((a, b) => a + b, 0);
    const last = Math.max(0, baseForInstallments - sumExceptLast);
    setCustomAmounts((prev) => prev.map((v, i) => (i === prev.length - 1 ? String(last) : v)));
    setCustomEdited(true);
  };

  /* ── Customer suggestions (owner rules 2026-09-26): the Page365 name is
   *    checked against full name AND Facebook name; a phone matches whenever
   *    the digits are identical, whatever dashes/spaces sit between them.
   *    Matching runs in code on the whole directory (never a text filter on
   *    the stored number), phone matches are never cut off, each result says
   *    WHY it matched, and nothing is auto-selected. ─────────────────────── */
  const {
    data: customerDirectory,
    isLoading: directoryLoading,
    error: directoryError,
  } = useQuery({
    queryKey: ['page365-customer-directory'],
    enabled: !!draft,
    staleTime: 60_000,
    queryFn: loadCustomerDirectory,
  });
  const suggestions = useMemo(
    () => (draft && customerDirectory
      ? suggestCustomers(customerDirectory, draft.customer.name, draft.customer.phone)
      : []),
    [draft, customerDirectory],
  );
  const [customerSearch, setCustomerSearch] = useState('');
  const searchResults = useMemo(
    () => (customerDirectory ? searchCustomers(customerDirectory, customerSearch) : []),
    [customerDirectory, customerSearch],
  );

  /* ── Loyalty basis: PRODUCT lines MINUS the discount, always yen. A service
   *    (a resize fee) is labour the customer paid for and must never inflate
   *    tier progress, and neither must money the customer never spent — the
   *    whole discount comes off the product amount (owner rule 2026-09-23:
   *    "loyalty excludes the discount and the shipping fee"). Shipping was
   *    already outside the basis because it is not a line item.
   *
   *    While the discount is still the one Page365 supplied, use the draft's
   *    exact yen figure. Converting the PHP input back rounds twice — at 0.42,
   *    ¥2,998 shows as ₱1,259 and returns as ¥2,997.6, which happens to round
   *    home; at other rates it does not, and the basis must never drift because
   *    the CSR toggled the currency. ─────────────────────────────────────── */
  const discountJpy =
    !discountTouched && (draft?.discount_jpy ?? 0) > 0
      ? Number(draft!.discount_jpy)
      : currency === 'JPY'
        ? Number(discount) || 0
        : rate ? Math.round((Number(discount) || 0) / rate) : 0;
  const loyaltyBasisJpy = Math.max(0, Math.round(productJpy - discountJpy));
  const loyaltyJpyAmount = loyaltyBasisJpy > 0 ? loyaltyBasisJpy : null;

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
  if (customHasEmpty) missing.push('an installment amount above zero for every month');
  if (customMismatch) missing.push('custom installments that add up to the remaining balance');
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
      // Website stock is taken from the stored draft's own lines (owner rule
      // D1); the browser only names the draft and the lines it booked as a
      // service, which are skipped.
      page365_draft_id: draftRow.id,
      page365_service_lines: items.filter((i) => i.kind === 'service').map((i) => i.lineNo),
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
            // Custom only; Equal sends nothing and the function splits it.
            ...(customReady ? { custom_installments: customValues } : {}),
          };

    try {
      const { data, error } = await supabase.functions.invoke(fn, { body });
      if (error) throw new Error(await readFnError(error, 'Could not create the order'));
      const payload = data as {
        error?: string; cash_order?: { id: string }; account?: { id: string };
        page365_stock?: ImportStockResult | null;
      };
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

      const stockLine = importSummary(payload?.page365_stock);
      toast.success(`Imported Page365 invoice ${draft.page365_no}`, stockLine ? { description: stockLine } : undefined);
      if ((payload?.page365_stock?.flagged ?? 0) > 0) {
        toast.warning(flaggedTitle(payload?.page365_stock?.mode), {
          description: 'They are listed under Website → Page365 stock and on the order page.',
        });
      }
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
              {directoryLoading && (
                <p className="text-sm text-muted-foreground">Looking for existing customers…</p>
              )}
              {directoryError && (
                <p className="text-sm text-destructive">
                  Could not load customers, so no match check ran — do not create a new customer yet.
                  Refresh the page and try again. ({(directoryError as Error).message})
                </p>
              )}
              {!directoryLoading && !directoryError && suggestions.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No existing customer matched on name, Facebook name or phone. Search below before creating one.
                </p>
              )}
              {suggestions.map(({ customer: c, basis }) => (
                <CustomerOption
                  key={c.id}
                  c={c}
                  badge={`matched on ${basis.join(' + ')}`}
                  onUse={() => setCustomer(c)}
                />
              ))}

              <div className="space-y-2 pt-2">
                <Label htmlFor="page365-customer-search" className="text-xs">Find a customer</Label>
                <Input
                  id="page365-customer-search"
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  placeholder="Search name, Facebook name, phone, email or customer code"
                  disabled={!customerDirectory}
                />
                {customerSearch.trim().length >= MIN_SEARCH_LENGTH && searchResults.length === 0 && (
                  <p className="text-sm text-muted-foreground">No customer found for “{customerSearch.trim()}”.</p>
                )}
                {searchResults.map((c) => (
                  <CustomerOption key={`s-${c.id}`} c={c} onUse={() => setCustomer(c)} />
                ))}
              </div>

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
          <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
            <Info className="h-3.5 w-3.5 shrink-0 mt-px" />
            Website stock follows the Page365 invoice as fetched: each line’s first word is its product code, and stock is taken only when you import. Editing a name or quantity here does not change what is taken; marking a line Service skips it.
          </p>

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
                <div className="flex flex-wrap items-center gap-1.5">
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
                  {(() => {
                    const chip = previewChip(it.stock_match, draft?.items[it.lineNo - 1]?.quantity ?? it.quantity, it.kind,
                      stockModeFrom(draft?.stock_mode));
                    return (
                      <span
                        className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${CHIP_CLASS[chip.tone]}`}
                        title={stockModeFrom(draft?.stock_mode) === 'invoice'
                          ? 'Website stock, checked when the link was fetched. Nothing is taken until you import.'
                          : 'Checked when the link was fetched. Importing records the match; website stock follows the Page365 inventory fetch (Website → Page365 stock).'}
                        data-testid={`p365-stock-chip-${it.lineNo}`}
                      >
                        {chip.label}
                      </span>
                    );
                  })()}
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
            <p>Loyalty basis (products − discount): {loyaltyJpyAmount ? `¥${loyaltyJpyAmount.toLocaleString()}` : '—'}</p>
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
                onChange={(e) => { setDiscount(e.target.value); setDiscountTouched(true); }}
                className="bg-background border-border tabular-nums" />
              {(draft.discount_jpy ?? 0) > 0 && !discountTouched && (
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  From Page365
                  {draft.promotion_code ? ` · promo code ${draft.promotion_code}` : ''}
                </p>
              )}
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

              {/* Installment structure — the same Equal / Custom choice as NewAccount. */}
              <div>
                <Label className="text-xs">Installment structure</Label>
                <div className="flex gap-2 mt-1">
                  {(['equal', 'custom'] as const).map((mode) => (
                    <Button
                      key={mode}
                      type="button"
                      size="sm"
                      variant={installmentMode === mode ? 'default' : 'outline'}
                      className={`flex-1 ${installmentMode === mode ? 'gold-gradient text-primary-foreground' : ''}`}
                      onClick={() => {
                        if (mode === installmentMode) return;
                        setCustomEdited(false);
                        setInstallmentMode(mode);
                      }}
                    >
                      {mode === 'equal' ? 'Equal installments' : 'Custom installments'}
                    </Button>
                  ))}
                </div>
              </div>

              {/* Schedule preview — the exact rows create-layaway-account will write. */}
              <div className="rounded-lg border border-primary/20 bg-background p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <h3 className="text-xs font-semibold text-card-foreground">
                    {isCustom ? 'Custom schedule' : 'Schedule preview'} ({planMonths} months)
                  </h3>
                  {isCustom ? (
                    <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-[11px]"
                      onClick={autoAdjustLastMonth} disabled={!customReady || previewInstallments.length === 0}>
                      <Wand2 className="h-3.5 w-3.5" />
                      Auto-adjust last month
                    </Button>
                  ) : previewInstallments.length > 0 && (
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
                          {isCustom ? (
                            <Input
                              type="number"
                              inputMode="numeric"
                              aria-label={`Installment ${i + 1} amount`}
                              value={customAmounts[i] ?? ''}
                              onChange={(e) => updateCustomAmount(i, e.target.value)}
                              className="w-28 h-7 bg-background border-border text-right text-xs tabular-nums shrink-0"
                              placeholder="Amount"
                            />
                          ) : (
                            <span className="tabular-nums text-card-foreground shrink-0">
                              {formatCurrency(previewInstallments[i] ?? 0, currency)}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>

                    {isCustom && (
                      <div className={`mt-2 rounded-md border p-2 text-xs ${
                        customMismatch ? 'border-destructive/50 bg-destructive/5' : 'border-primary/20 bg-primary/5'}`}>
                        <div className="flex items-center justify-between font-medium text-card-foreground">
                          <span>Installment total</span>
                          <span className={`tabular-nums font-bold ${customMismatch ? 'text-destructive' : 'text-primary'}`}>
                            {formatCurrency(customTotal, currency)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between mt-0.5 text-muted-foreground">
                          <span>Required (total − downpayment)</span>
                          <span className="tabular-nums">{formatCurrency(baseForInstallments, currency)}</span>
                        </div>
                        {customMismatch && (
                          <p className="text-destructive mt-1.5 font-medium">
                            Mismatch of {formatCurrency(Math.abs(customTotal - baseForInstallments), currency)} — installments must equal the remaining balance.
                          </p>
                        )}
                      </div>
                    )}

                    <div className="flex items-center justify-between pt-2 mt-1 text-xs font-semibold text-card-foreground">
                      <span>Deposit + installments</span>
                      <span className="tabular-nums">
                        {formatCurrency(
                          downpaymentAmount + scheduleAmounts.reduce((a, b) => a + b, 0),
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
          // Page365 usually carries the Facebook name (owner decision
          // 2026-09-26), so it seeds Facebook Name too and the duplicate
          // check catches a customer already saved under it.
          initialFacebookName={draft.customer.name}
          onCreated={(c) => { setCustomer(c); setNewCustomerOpen(false); }}
        />
      </div>
    </AppLayout>
  );
}
