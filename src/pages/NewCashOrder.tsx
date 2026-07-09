import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { ArrowLeft, UserPlus, Banknote, Loader2, AlertTriangle, X, Lock } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import CurrencyInput from '@/components/forms/CurrencyInput';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Currency } from '@/lib/types';
import { formatCurrency } from '@/lib/calculations';
import { fetchPhpJpyRate } from '@/lib/promo-media';
import { getConversionRate } from '@/lib/currency-converter';
import { useCustomers, DbCustomer } from '@/hooks/use-supabase-data';
import { supabase } from '@/integrations/supabase/client';
import NewCustomerDialog from '@/components/customers/NewCustomerDialog';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { getPHTToday } from '@/lib/date-utils';
import { useCustomerLoyaltyTier } from '@/hooks/useCustomerLoyaltyTier';

type InvoiceCheck = 'idle' | 'checking' | 'available' | 'taken';

// Shopify catalog mirror (public.products) — picker source for Path A orders.
interface CatalogProduct {
  id: string;
  title: string;
  sku: string | null;
  price_jpy: number | null;
  inventory_quantity: number | null;
  status: string;
  image_url: string | null;
}

// Local line item, written to public.cash_order_items after the order is created.
interface CashOrderLineItem {
  product_id: string;
  title: string;
  sku: string | null;
  unit_price_jpy: number;
  quantity: number;
  line_total_jpy: number;
  image_url: string | null;
}

// Status tint for the picker (products are pre-filtered to non-archived).
function productStatusBadgeClass(status: string): string {
  if (status === 'active') return 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30';
  if (status === 'draft') return 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30';
  return 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30'; // unlisted / other
}

export default function NewCashOrder() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const presetCustomerId = searchParams.get('customer_id');
  const customerLocked = !!presetCustomerId;

  // AI-command URL params (CREATE_CASH_ORDER intent) seed initial state.
  const urlCustomerName = searchParams.get('customer_name');
  const urlAmount = searchParams.get('amount');
  const urlCurrency = searchParams.get('currency');
  const initialCurrency: Currency =
    urlCurrency === 'JPY' || urlCurrency === 'PHP' ? urlCurrency : 'JPY';

  const { roles, loading: authLoading } = useAuth();
  const { can, loading: permLoading } = usePermissions();
  const { data: customers } = useCustomers();
  const rolesArr = roles as any[];
  const canSeeLoyaltyField = rolesArr.includes('admin') || rolesArr.includes('finance') || rolesArr.includes('staff');

  // Permission gate — driven by role_permissions via usePermissions().can()
  const isAuthorized = can('create_cash_order');
  useEffect(() => {
    if (authLoading || permLoading) return;
    if (!isAuthorized) navigate('/', { replace: true });
  }, [authLoading, permLoading, isAuthorized, navigate]);

  // Form state
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [customerId, setCustomerId] = useState(presetCustomerId || '');
  const [currency, setCurrency] = useState<Currency>(initialCurrency);
  const [totalAmount, setTotalAmount] = useState(urlAmount ?? '');
  const [loyaltyJpyInput, setLoyaltyJpyInput] = useState('');
  const [orderDate, setOrderDate] = useState(() => getPHTToday());
  const [expiresAt, setExpiresAt] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [acceptAgreement, setAcceptAgreement] = useState(false);
  const [isTrade, setIsTrade] = useState(false);

  // Shopify product picker state (Path A). Optional — an order with zero line
  // items submits exactly as before (plain order, source_channel = hub_manual).
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [lineItems, setLineItems] = useState<CashOrderLineItem[]>([]);
  // Once the user types in the Total Amount field, stop auto-suggesting from
  // items. A URL-seeded amount (AI command) counts as already-set.
  const [totalAmountManuallyEdited, setTotalAmountManuallyEdited] = useState(!!urlAmount);
  // Live PHP↔JPY rate for the auto-suggest (catalog prices are JPY; a PHP order
  // suggests total = JPY subtotal × rate). Default to the localStorage rate
  // until the live system_settings value resolves on mount.
  const [phpJpyRate, setPhpJpyRate] = useState<number>(() => getConversionRate());
  // Discount & shipping (account currency). total_amount stays authoritative —
  // these only feed the suggested total until the user edits it.
  const [discountMode, setDiscountMode] = useState<'amount' | 'percent'>('amount');
  const [discountInput, setDiscountInput] = useState('');
  const [shippingInput, setShippingInput] = useState('');

  // Loyalty tier of the selected customer. Non-null => the customer is a
  // loyalty member (any tier) and Loyalty Product Amount (JPY) is required.
  // Mirrors NewAccount.tsx; create-cash-order edge function is the authoritative gate.
  const { data: loyaltyTier } = useCustomerLoyaltyTier(customerId);
  const isLoyaltyAmountRequired = !!loyaltyTier;
  const loyaltyAmountMissing =
    isLoyaltyAmountRequired &&
    (!loyaltyJpyInput.trim() || !(Number(loyaltyJpyInput) > 0));

  // Customer search combobox (matches NewAccount pattern)
  const [customerSearch, setCustomerSearch] = useState(urlCustomerName ?? '');
  const [customerResults, setCustomerResults] = useState<DbCustomer[]>([]);
  const [customerSearching, setCustomerSearching] = useState(false);
  const [customerDropdownOpen, setCustomerDropdownOpen] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<DbCustomer | null>(null);
  const customerSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Invoice uniqueness check
  const [invoiceCheck, setInvoiceCheck] = useState<InvoiceCheck>('idle');

  // Submission + dirty state
  const [submitting, setSubmitting] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);
  const submittedRef = useRef(false);
  const pendingNavRef = useRef<string | null>(null);

  const markDirty = useCallback(() => {
    if (!formDirty) setFormDirty(true);
  }, [formDirty]);

  // Fetch the Shopify catalog once (~173 rows; filter client-side).
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('products')
        .select('id, title, sku, price_jpy, inventory_quantity, status, image_url')
        .neq('status', 'archived')
        .order('title', { ascending: true });
      setCatalog((data ?? []) as CatalogProduct[]);
    })();
  }, []);

  const itemsSubtotal = lineItems.reduce((sum, li) => sum + li.line_total_jpy, 0);
  // Items subtotal in the ACCOUNT currency (line items are stored in JPY).
  const itemsSubtotalAcct = currency === 'PHP' ? Math.round(itemsSubtotal * phpJpyRate) : itemsSubtotal;
  // Discount & shipping are entered/stored in the account currency.
  const discountAmount = discountMode === 'percent'
    ? Math.round(itemsSubtotalAcct * (parseFloat(discountInput) || 0) / 100)
    : Math.round(parseFloat(discountInput) || 0);
  const shippingFee = Math.round(parseFloat(shippingInput) || 0);

  const filteredProducts = productSearch.trim()
    ? catalog
        .filter((p) => {
          const term = productSearch.trim().toLowerCase();
          return p.title.toLowerCase().includes(term) || (p.sku ?? '').toLowerCase().includes(term);
        })
        .slice(0, 8)
    : [];

  const addLineItem = useCallback((p: CatalogProduct) => {
    const price = p.price_jpy ?? 0;
    setLineItems((prev) => {
      const idx = prev.findIndex((li) => li.product_id === p.id);
      if (idx >= 0) {
        const next = [...prev];
        const quantity = next[idx].quantity + 1;
        next[idx] = { ...next[idx], quantity, line_total_jpy: next[idx].unit_price_jpy * quantity };
        return next;
      }
      return [...prev, { product_id: p.id, title: p.title, sku: p.sku, unit_price_jpy: price, quantity: 1, line_total_jpy: price, image_url: p.image_url }];
    });
    markDirty();
  }, [markDirty]);

  const updateLineItemQty = useCallback((productId: string, raw: string) => {
    const quantity = Math.max(1, Math.floor(Number(raw) || 1));
    setLineItems((prev) => prev.map((li) => (
      li.product_id === productId
        ? { ...li, quantity, line_total_jpy: li.unit_price_jpy * quantity }
        : li
    )));
    markDirty();
  }, [markDirty]);

  const removeLineItem = useCallback((productId: string) => {
    setLineItems((prev) => prev.filter((li) => li.product_id !== productId));
    markDirty();
  }, [markDirty]);

  // Resolve the live php_jpy_rate once on mount (falls back to the default).
  useEffect(() => {
    let active = true;
    fetchPhpJpyRate().then((r) => { if (active) setPhpJpyRate(r); });
    return () => { active = false; };
  }, []);

  // Auto-suggest the total from the items subtotal (account currency), minus
  // discount plus shipping, until the user edits the total field. Catalog
  // prices are JPY, so a PHP order converts (PHP = JPY × rate). total_amount
  // stays authoritative & fully editable. Recomputes on currency/discount/
  // shipping change unless the user has already edited the total.
  useEffect(() => {
    if (totalAmountManuallyEdited || lineItems.length === 0) return;
    const suggested = Math.max(0, itemsSubtotalAcct - discountAmount + shippingFee);
    setTotalAmount(String(suggested));
  }, [lineItems, totalAmountManuallyEdited, currency, phpJpyRate, itemsSubtotalAcct, discountAmount, shippingFee]);

  // Customer search — same debounced pattern as NewAccount
  useEffect(() => {
    if (customerSearchTimer.current) clearTimeout(customerSearchTimer.current);
    const term = customerSearch.trim();
    if (!term) {
      setCustomerResults([]);
      setCustomerSearching(false);
      return;
    }
    setCustomerSearching(true);
    customerSearchTimer.current = setTimeout(async () => {
      const { data } = await supabase
        .from('customers')
        .select('id, full_name, mobile_number, email, facebook_name, messenger_link, location')
        .or(`full_name.ilike.%${term}%,mobile_number.ilike.%${term}%`)
        .order('full_name', { ascending: true })
        .limit(10);
      setCustomerResults(((data as any) || []) as DbCustomer[]);
      setCustomerSearching(false);
    }, 300);
    return () => {
      if (customerSearchTimer.current) clearTimeout(customerSearchTimer.current);
    };
  }, [customerSearch]);

  // Sync selected customer from customerId when set via dialog or initial load
  useEffect(() => {
    if (customerId && !selectedCustomer && customers) {
      const match = customers.find(c => c.id === customerId);
      if (match) {
        setSelectedCustomer(match as DbCustomer);
        setCustomerSearch(match.full_name);
      }
    }
  }, [customerId, customers, selectedCustomer]);

  // beforeunload guard
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (formDirty && !submittedRef.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [formDirty]);

  const guardedNavigate = useCallback((path: string) => {
    if (formDirty && !submittedRef.current) {
      pendingNavRef.current = path;
      setShowLeaveDialog(true);
    } else {
      navigate(path);
    }
  }, [formDirty, navigate]);

  // Check invoice uniqueness (blur handler — hits both tables)
  const checkInvoiceUnique = useCallback(async () => {
    const trimmed = invoiceNumber.trim();
    if (!trimmed) {
      setInvoiceCheck('idle');
      return;
    }
    setInvoiceCheck('checking');
    const [cashRes, layawayRes] = await Promise.all([
      supabase.from('cash_orders').select('id').eq('invoice_number', trimmed).maybeSingle(),
      supabase.from('layaway_accounts').select('id').eq('invoice_number', trimmed).maybeSingle(),
    ]);
    if (cashRes.data || layawayRes.data) setInvoiceCheck('taken');
    else setInvoiceCheck('available');
  }, [invoiceNumber]);

  const amount = Number(totalAmount) || 0;

  // Full form validity (for enabling submit)
  const isFormValid =
    !!customerId &&
    !!invoiceNumber.trim() &&
    invoiceCheck !== 'taken' &&
    !!currency &&
    amount > 0 &&
    !!orderDate &&
    !!expiresAt;

  // Warn if expiry is in the past — order will be auto-expired by cron
  const today = getPHTToday();
  const expiresAtIsPast = !!expiresAt && expiresAt < today;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid) {
      toast.error('Please complete all required fields');
      return;
    }
    if (loyaltyAmountMissing) {
      toast.error(
        `This customer is a ${loyaltyTier?.current_tier_name} loyalty member. Loyalty Product Amount (JPY) is required.`
      );
      return;
    }
    if ((invoiceCheck as InvoiceCheck) === 'taken') {
      toast.error(`Invoice number "${invoiceNumber}" already exists`);
      return;
    }
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        customer_id: customerId,
        invoice_number: invoiceNumber.trim(),
        currency,
        total_amount: amount,
        order_date: orderDate,
        expires_at: expiresAt,
      };
      const loyaltyJpyParsed = Number(loyaltyJpyInput);
      if (
        loyaltyJpyInput.trim() !== '' &&
        Number.isFinite(loyaltyJpyParsed) &&
        loyaltyJpyParsed > 0
      ) {
        payload.loyalty_jpy_amount = Math.round(loyaltyJpyParsed);
      }
      if (notes.trim()) payload.notes = notes.trim();
      if (acceptAgreement) payload.agreement_version = 'v1';
      payload.is_trade = isTrade;

      const { data, error } = await supabase.functions.invoke('create-cash-order', { body: payload });

      if (error) {
        // Try to extract detailed error message from the FunctionsHttpError body
        let msg = error.message || 'Failed to create cash order';
        try {
          if ('context' in error && (error as any).context?.body) {
            const body = await new Response((error as any).context.body).json();
            if (body?.error) msg = body.error;
          }
        } catch { /* ignore parse errors */ }
        throw new Error(msg);
      }

      const newId = data?.cash_order?.id;

      // Path A: write line items + origin tag CLIENT-SIDE (create-cash-order is
      // unchanged). Optional — skipped entirely when no items were picked. The
      // order (authoritative record) exists regardless of these writes.
      if (newId && lineItems.length > 0) {
        try {
          const { error: itemsErr } = await supabase.from('cash_order_items').insert(
            lineItems.map((li) => ({
              cash_order_id: newId,
              product_id: li.product_id,
              title: li.title,
              sku: li.sku,
              quantity: li.quantity,
              unit_price_jpy: li.unit_price_jpy,
              line_total_jpy: li.line_total_jpy,
              image_url: li.image_url,
            })),
          );
          if (itemsErr) throw itemsErr;
          // Best-effort origin tag — swallow silently if the role lacks
          // cash_orders UPDATE (order stays hub_manual); never surfaced.
          try {
            await supabase.from('cash_orders').update({ source_channel: 'social_manual' }).eq('id', newId);
          } catch { /* stays hub_manual — not an error */ }
        } catch {
          toast.warning('Order created, but item details could not be saved. You can add them from the order page.');
        }
      }

      // Persist discount & shipping (account currency, client-side best-effort).
      // total_amount is already authoritative; these are informational columns.
      if (newId && (discountAmount > 0 || shippingFee > 0 || discountInput !== '')) {
        try {
          const { error: dsErr } = await supabase.from('cash_orders').update({
            discount_amount: discountAmount,
            discount_type: discountInput === '' ? null : discountMode,
            discount_value: discountInput === '' ? null : (parseFloat(discountInput) || 0),
            shipping_fee: shippingFee,
          }).eq('id', newId);
          if (dsErr) throw dsErr;
        } catch {
          toast.warning('Order created, but discount/shipping could not be saved. You can edit it from the order page.');
        }
      }

      submittedRef.current = true;
      setFormDirty(false);
      toast.success(`Cash order #${invoiceNumber.trim()} created successfully`);
      if (newId) navigate(`/cash-orders/${newId}`);
      else navigate('/customers?tab=cash');
    } catch (err: unknown) {
      const msg = (err as Error).message || 'Failed to create cash order';
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  // Avoid rendering the form for unauthorized users while the redirect runs
  if (!authLoading && !isAuthorized) return null;

  return (
    <AppLayout>
      <div className="animate-fade-in max-w-2xl space-y-6">
        <div className="flex items-center gap-4">
          <Link to="/customers?tab=cash" onClick={(e) => {
            e.preventDefault();
            guardedNavigate('/customers?tab=cash');
          }}>
            <Button variant="ghost" size="icon" className="text-muted-foreground">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex items-center gap-3 flex-1">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl gold-gradient">
              <Banknote className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground font-display">Create Cash Order</h1>
              <p className="text-sm text-muted-foreground mt-0.5">One-time full payment — no schedule or downpayment</p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="rounded-xl border border-primary/20 bg-card p-6 space-y-4">
            {/* Customer */}
            <div className="space-y-2">
              <Label className="text-card-foreground flex items-center gap-2">
                Customer *
                {selectedCustomer && (
                  <Badge variant="outline" className="text-[10px] bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30">
                    ✓ Existing customer selected
                  </Badge>
                )}
                {customerLocked && (
                  <Badge variant="outline" className="text-[10px] bg-muted text-muted-foreground border-border gap-1">
                    <Lock className="h-2.5 w-2.5" /> Locked
                  </Badge>
                )}
              </Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    value={customerSearch}
                    disabled={customerLocked}
                    onChange={(e) => {
                      if (customerLocked) return;
                      const v = e.target.value;
                      setCustomerSearch(v);
                      if (selectedCustomer) {
                        setSelectedCustomer(null);
                        setCustomerId('');
                      }
                      setCustomerDropdownOpen(true);
                      markDirty();
                    }}
                    onFocus={() => { if (!customerLocked && customerSearch) setCustomerDropdownOpen(true); }}
                    onBlur={() => { setTimeout(() => setCustomerDropdownOpen(false), 150); }}
                    placeholder="Search customer by name or mobile…"
                    className="bg-background border-border pr-8 disabled:opacity-80 disabled:cursor-not-allowed"
                    autoComplete="off"
                  />
                  {customerSearch && !customerLocked && (
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setCustomerSearch('');
                        setSelectedCustomer(null);
                        setCustomerId('');
                        setCustomerResults([]);
                        setCustomerDropdownOpen(false);
                        markDirty();
                      }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-destructive"
                      aria-label="Clear customer">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {!customerLocked && customerDropdownOpen && customerSearch.trim() && (
                    <div
                      className="absolute left-0 right-0 top-full mt-1 max-h-60 overflow-y-auto rounded-md border border-border bg-background shadow-xl"
                      style={{ zIndex: 60 }}
                    >
                      {customerSearching ? (
                        <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
                        </div>
                      ) : customerResults.length === 0 ? (
                        <div className="px-3 py-2 text-xs text-muted-foreground italic">
                          No customer found — use Create New Customer →
                        </div>
                      ) : (
                        customerResults.map(c => (
                          <button
                            key={c.id}
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setSelectedCustomer(c);
                              setCustomerId(c.id);
                              setCustomerSearch(c.full_name || '');
                              setCustomerDropdownOpen(false);
                              markDirty();
                            }}
                            className="block w-full text-left px-3 py-2 text-sm hover:bg-muted/60 border-b border-border/40 last:border-0"
                          >
                            <span className="font-medium text-foreground">{c.full_name}</span>
                            {c.mobile_number && (
                              <span className="text-muted-foreground ml-2">{c.mobile_number}</span>
                            )}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
                {!customerLocked && (
                  <NewCustomerDialog
                    onCreated={(c) => {
                      setCustomerId(c.id);
                      setSelectedCustomer(c as DbCustomer);
                      setCustomerSearch(c.full_name || '');
                      markDirty();
                    }}
                    trigger={
                      <Button type="button" variant="outline" size="icon" className="shrink-0" title="Create new customer">
                        <UserPlus className="h-4 w-4" />
                      </Button>
                    }
                  />
                )}
              </div>
              {selectedCustomer && (
                <div className="rounded-md border border-green-500/30 bg-green-500/5 p-3 text-xs space-y-1">
                  {selectedCustomer.mobile_number && (
                    <div>
                      <span className="text-muted-foreground">Mobile:</span>{' '}
                      <span className="text-foreground">{selectedCustomer.mobile_number}</span>
                    </div>
                  )}
                  {selectedCustomer.email && (
                    <div>
                      <span className="text-muted-foreground">Email:</span>{' '}
                      <span className="text-foreground">{selectedCustomer.email}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Items (optional) — Shopify product picker (Path A / social-manual) */}
            <div className="rounded-lg border border-border bg-background/40 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-card-foreground">Items (optional)</Label>
                <span className="text-[10px] text-muted-foreground">From Shopify catalog</span>
              </div>

              <div className="relative">
                <Input
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                  placeholder="Search products by title or SKU…"
                  className="bg-background border-border"
                  autoComplete="off"
                />
                {productSearch.trim() && (
                  <div className="mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-background divide-y divide-border/40">
                    {filteredProducts.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground italic">No products match your search.</div>
                    ) : (
                      filteredProducts.map((p) => {
                        const inStock = (p.inventory_quantity ?? 0) > 0;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => addLineItem(p)}
                            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/60"
                          >
                            {p.image_url && (
                              <img
                                src={p.image_url}
                                alt=""
                                className="h-9 w-9 shrink-0 rounded border border-border object-cover"
                              />
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium text-foreground">{p.title}</span>
                                <Badge variant="outline" className={`shrink-0 text-[9px] ${productStatusBadgeClass(p.status)}`}>
                                  {p.status}
                                </Badge>
                              </span>
                              <span className="mt-0.5 flex items-center gap-2 text-[11px]">
                                {p.sku && <span className="text-muted-foreground">SKU {p.sku}</span>}
                                {inStock ? (
                                  <span className="text-green-600 dark:text-green-400">In stock ({p.inventory_quantity})</span>
                                ) : (
                                  <span className="text-muted-foreground">Out of stock</span>
                                )}
                              </span>
                            </span>
                            <span className="shrink-0 text-sm font-semibold text-card-foreground tabular-nums">
                              {formatCurrency(p.price_jpy ?? 0, 'JPY')}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>

              {lineItems.length > 0 && (
                <div className="space-y-2">
                  {lineItems.map((li) => (
                    <div key={li.product_id} className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
                      {li.image_url && (
                        <img
                          src={li.image_url}
                          alt=""
                          className="h-9 w-9 shrink-0 rounded border border-border object-cover"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-foreground">{li.title}</div>
                        <div className="text-[11px] text-muted-foreground tabular-nums">
                          {formatCurrency(li.unit_price_jpy, 'JPY')} each
                        </div>
                      </div>
                      <input
                        type="number"
                        min={1}
                        value={li.quantity}
                        onChange={(e) => updateLineItemQty(li.product_id, e.target.value)}
                        className="w-14 rounded border border-border bg-background px-2 py-1 text-center text-sm tabular-nums"
                        aria-label={`Quantity for ${li.title}`}
                      />
                      <span className="w-24 shrink-0 text-right text-sm font-medium text-card-foreground tabular-nums">
                        {formatCurrency(li.line_total_jpy, 'JPY')}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeLineItem(li.product_id)}
                        className="text-muted-foreground hover:text-destructive"
                        aria-label={`Remove ${li.title}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <div className="flex items-center justify-between border-t border-border/40 pt-2 text-sm">
                    <span className="text-muted-foreground">Items subtotal</span>
                    <span className="text-right">
                      <span className="font-semibold text-card-foreground tabular-nums">{formatCurrency(itemsSubtotal, 'JPY')}</span>
                      {currency === 'PHP' && (
                        <span className="block text-[11px] text-muted-foreground tabular-nums">
                          ≈ {formatCurrency(Math.round(itemsSubtotal * phpJpyRate), 'PHP')} at current rate
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Discount & Shipping (optional) — account currency. Feeds the
                suggested total until the user edits it; never forces total. */}
            <div className="rounded-lg border border-border bg-background/40 p-4 space-y-3">
              <Label className="text-card-foreground">Discount &amp; Shipping (optional)</Label>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Discount</span>
                    <div className="flex rounded-md border border-border overflow-hidden">
                      <button
                        type="button"
                        onClick={() => { setDiscountMode('amount'); markDirty(); }}
                        className={`px-2 py-0.5 text-[11px] ${discountMode === 'amount' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'}`}
                      >
                        {currency === 'PHP' ? '₱' : '¥'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setDiscountMode('percent'); markDirty(); }}
                        className={`px-2 py-0.5 text-[11px] ${discountMode === 'percent' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'}`}
                      >
                        %
                      </button>
                    </div>
                  </div>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      {discountMode === 'percent' ? '%' : (currency === 'PHP' ? '₱' : '¥')}
                    </span>
                    <Input
                      type="number"
                      min={0}
                      value={discountInput}
                      onChange={(e) => { setDiscountInput(e.target.value); markDirty(); }}
                      placeholder="0"
                      className="bg-background border-border pl-6 tabular-nums"
                    />
                  </div>
                  {discountMode === 'percent' && (
                    <p className="text-[11px] text-muted-foreground">of items subtotal</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <span className="text-xs text-muted-foreground">Shipping fee</span>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      {currency === 'PHP' ? '₱' : '¥'}
                    </span>
                    <Input
                      type="number"
                      min={0}
                      value={shippingInput}
                      onChange={(e) => { setShippingInput(e.target.value); markDirty(); }}
                      placeholder="0"
                      className="bg-background border-border pl-6 tabular-nums"
                    />
                  </div>
                </div>
              </div>

              {/* Reconciliation — all in account currency */}
              <div className="space-y-1 border-t border-border/40 pt-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Items subtotal</span>
                  <span className="tabular-nums text-card-foreground">{formatCurrency(itemsSubtotalAcct, currency)}</span>
                </div>
                {discountAmount > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">− Discount</span>
                    <span className="tabular-nums text-card-foreground">{formatCurrency(discountAmount, currency)}</span>
                  </div>
                )}
                {shippingFee > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">+ Shipping</span>
                    <span className="tabular-nums text-card-foreground">{formatCurrency(shippingFee, currency)}</span>
                  </div>
                )}
                <div className="flex items-center justify-between border-t border-border/40 pt-1">
                  <span className="text-muted-foreground">Suggested total</span>
                  <span className="font-semibold tabular-nums text-card-foreground">
                    {formatCurrency(Math.max(0, itemsSubtotalAcct - discountAmount + shippingFee), currency)}
                  </span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* Invoice Number */}
              <div className="space-y-2">
                <Label className="text-card-foreground">Invoice Number *</Label>
                <Input
                  value={invoiceNumber}
                  onChange={(e) => { setInvoiceNumber(e.target.value); setInvoiceCheck('idle'); markDirty(); }}
                  onBlur={checkInvoiceUnique}
                  placeholder="Manually entered"
                  className={`bg-background border-border ${invoiceCheck === 'taken' ? 'border-destructive' : ''}`}
                />
                {invoiceCheck === 'checking' && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" /> Checking…
                  </p>
                )}
                {invoiceCheck === 'taken' && (
                  <p className="text-xs text-destructive">Invoice number already exists</p>
                )}
                {invoiceCheck === 'available' && (
                  <p className="text-xs text-green-600 dark:text-green-400">✓ Available</p>
                )}
              </div>

              {/* Currency */}
              <div className="space-y-2">
                <Label className="text-card-foreground">Currency *</Label>
                <div className="flex gap-2">
                  {(['JPY', 'PHP'] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => { setCurrency(c); markDirty(); }}
                      className={`flex-1 rounded-lg border py-2 text-sm font-medium transition-colors ${
                        currency === c
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border bg-background text-muted-foreground hover:border-primary/50'
                      }`}
                    >
                      {c === 'JPY' ? 'JPY ¥' : 'PHP ₱'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              {/* Total Amount */}
              <div className="space-y-2">
                <Label className="text-card-foreground">Total Amount *</Label>
                <CurrencyInput
                  currency={currency as Currency}
                  value={totalAmount === '' ? '' : Number(totalAmount)}
                  onValueChange={(v) => { setTotalAmount(v === '' ? '' : String(v)); setTotalAmountManuallyEdited(true); markDirty(); }}
                  error={totalAmount !== '' && amount <= 0 ? ' ' : undefined}
                  className="bg-background"
                />
                {totalAmount !== '' && amount <= 0 && (
                  <p className="text-xs text-destructive">Amount must be greater than zero</p>
                )}
              </div>

              {/* Order Date */}
              <div className="space-y-2">
                <Label className="text-card-foreground">Order Date *</Label>
                <Input
                  type="date"
                  value={orderDate}
                  onChange={(e) => { setOrderDate(e.target.value); markDirty(); }}
                  className="bg-background border-border"
                />
              </div>
            </div>

            {/* Expiration Date */}
            <div className="space-y-2">
              <Label className="text-card-foreground">Expiration Date *</Label>
              <Input
                type="date"
                value={expiresAt}
                onChange={(e) => { setExpiresAt(e.target.value); markDirty(); }}
                className={`bg-background border-border ${expiresAtIsPast ? 'border-destructive' : ''}`}
              />
              <p className="text-[10px] text-muted-foreground">
                Manual entry — staff sets per customer arrangement. Order will
                be auto-expired the morning after this date.
              </p>
              {expiresAtIsPast && (
                <p className="text-xs text-destructive">
                  ⚠️ This date has already passed — order will be auto-expired
                  tomorrow morning.
                </p>
              )}
            </div>

            {/* Loyalty product amount (admin/finance only) */}
            {canSeeLoyaltyField && (
              <div className="space-y-2">
                {isLoyaltyAmountRequired ? (
                  <Label className="text-destructive">
                    Loyalty Product Amount (JPY) <span className="text-destructive">*</span>
                  </Label>
                ) : (
                  <Label className="text-card-foreground">
                    Product Amount (JPY) — Loyalty Only
                  </Label>
                )}
                <Input
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={loyaltyJpyInput}
                  onChange={(e) => { setLoyaltyJpyInput(e.target.value); markDirty(); }}
                  placeholder="e.g. 107143"
                  className="bg-background border-border"
                />
                {loyaltyAmountMissing && (
                  <p className="text-xs text-destructive font-medium">
                    Required for loyalty tier members
                  </p>
                )}
                <p className="text-[10px] text-muted-foreground">
                  Product value in JPY only. Exclude shipping, service fees,
                  and insurance. Used for loyalty points — not shown to
                  customer.
                </p>
              </div>
            )}

            {/* Notes */}
            <div className="space-y-2">
              <Label className="text-card-foreground">Notes (optional)</Label>
              <textarea
                className="w-full rounded-md border border-border bg-background p-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                rows={3}
                maxLength={1000}
                placeholder="Internal notes about this cash order…"
                value={notes}
                onChange={e => { setNotes(e.target.value); markDirty(); }}
              />
              <p className="text-[10px] text-muted-foreground">{notes.length}/1000</p>
            </div>

            {/* Agreement */}
            <div className="flex items-start gap-3 rounded-lg border border-border bg-background/50 p-3">
              <Checkbox
                id="accept-agreement"
                checked={acceptAgreement}
                onCheckedChange={(checked) => { setAcceptAgreement(!!checked); markDirty(); }}
                className="mt-0.5"
              />
              <Label htmlFor="accept-agreement" className="text-sm cursor-pointer text-card-foreground leading-snug">
                Customer accepts payment agreement
                <span className="block text-[11px] text-muted-foreground mt-0.5">
                  Records agreement_version='v1' and the acceptance timestamp on the cash order
                </span>
              </Label>
            </div>

            {/* Trade Program flag (locked after creation) */}
            <div
              className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${
                isTrade
                  ? 'bg-amber-50 dark:bg-amber-950/20 border-amber-300 dark:border-amber-800'
                  : 'border-border bg-background/50'
              }`}
            >
              <Checkbox
                id="is-trade"
                checked={isTrade}
                onCheckedChange={(checked) => { setIsTrade(checked === true); markDirty(); }}
                className="mt-0.5"
              />
              <div className="flex-1 space-y-1">
                <Label htmlFor="is-trade" className="text-sm cursor-pointer text-card-foreground font-medium leading-snug">
                  Trade Program
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  This account originated from a fully-paid layaway trade-in. Cannot be changed after creation.
                </p>
                <a
                  href="https://chajewelstrade.chajewelsjp.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block text-[11px] text-primary hover:underline"
                >
                  View Trade Program Policy →
                </a>
              </div>
            </div>
          </div>

          {/* Summary preview */}
          {amount > 0 && (
            <div className="rounded-xl border border-border bg-card p-4 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Total due on creation</span>
              <span className="text-lg font-bold text-card-foreground tabular-nums">
                {formatCurrency(amount, currency)}
              </span>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => guardedNavigate('/customers?tab=cash')}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting || !isFormValid || invoiceCheck === 'checking' || loyaltyAmountMissing}
              className={`gold-gradient text-primary-foreground font-medium ${loyaltyAmountMissing ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  Creating…
                </>
              ) : 'Create Cash Order'}
            </Button>
          </div>
        </form>
      </div>

      {/* Leave Confirmation */}
      <Dialog open={showLeaveDialog} onOpenChange={setShowLeaveDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Unsaved Changes
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            You have unsaved changes. Are you sure you want to leave this page?
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowLeaveDialog(false)}>
              Stay
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setShowLeaveDialog(false);
                setFormDirty(false);
                submittedRef.current = true;
                navigate(pendingNavRef.current || '/customers?tab=cash');
                pendingNavRef.current = null;
              }}
            >
              Leave Page
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
