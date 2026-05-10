import { useState, useRef, useEffect } from 'react';
import { FileText, Plus, ExternalLink, CheckCircle2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { type AppRole } from '@/lib/role-permissions';
import { formatCurrency } from '@/lib/calculations';
import { toast } from 'sonner';
import { useQuery, useQueryClient } from '@tanstack/react-query';

const MAX_ITEMS = 13;

interface AddressInput {
  name: string;
  address_line1: string;
  city: string;
  postal_code: string;
  country: string;
  phone: string;
}

interface ItemInput {
  description: string;
  qty: number;
  unit_price_jpy_inclusive: number;
}

export interface InvoiceGeneratorSheetProps {
  // Exactly one of accountId or cashOrderId must be provided.
  // Edge function rejects otherwise.
  accountId?: string;
  cashOrderId?: string;
  // Display only — header line in the Sheet.
  parentInvoiceNumber: string;
  // Optional pre-fill from customer record (Step 1a address columns).
  prefillAddress?: {
    name: string;
    address_line1: string | null;
    city: string | null;
    postal_code: string | null;
    country: string | null;
    phone: string | null;
  };
  // Optional success callback (parent can refresh recent-invoices, etc.).
  onInvoiceGenerated?: (invoice: {
    sheet_url: string;
    sheet_id: string;
    total_jpy: number;
  }) => void;
}

const emptyAddress = (): AddressInput => ({
  name: '',
  address_line1: '',
  city: '',
  postal_code: '',
  country: '',
  phone: '',
});

const emptyItem = (): ItemInput => ({
  description: '',
  qty: 1,
  unit_price_jpy_inclusive: 0,
});

export default function InvoiceGeneratorSheet({
  accountId,
  cashOrderId,
  parentInvoiceNumber,
  prefillAddress,
  onInvoiceGenerated,
}: InvoiceGeneratorSheetProps) {
  const { roles } = useAuth();
  const r = roles as AppRole[];
  const isAuthorized = r.includes('admin') || r.includes('finance') || r.includes('staff');

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'form' | 'success'>('form');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const initShipTo = (): AddressInput => {
    if (!prefillAddress) return emptyAddress();
    return {
      name: prefillAddress.name || '',
      address_line1: prefillAddress.address_line1 || '',
      city: prefillAddress.city || '',
      postal_code: prefillAddress.postal_code || '',
      country: prefillAddress.country || '',
      phone: prefillAddress.phone || '',
    };
  };

  const [shipTo, setShipTo] = useState<AddressInput>(initShipTo());
  const [billTo, setBillTo] = useState<AddressInput>(emptyAddress());
  const [billSameAsShip, setBillSameAsShip] = useState(true);
  const [items, setItems] = useState<ItemInput[]>([emptyItem()]);
  const [discount, setDiscount] = useState<string>('0');
  const [shipping, setShipping] = useState<string>('0');
  const [terms, setTerms] = useState<string>('');
  const [result, setResult] = useState<{ sheet_url: string; sheet_id: string; total_jpy: number } | null>(null);

  // Dev-only sanity check on parent-id invariant
  useEffect(() => {
    if ((accountId && cashOrderId) || (!accountId && !cashOrderId)) {
      console.error('[InvoiceGeneratorSheet] must receive exactly one of accountId or cashOrderId');
    }
  }, [accountId, cashOrderId]);

  // Count of prior generations for this parent — surfaced as a badge on the trigger
  const queryClient = useQueryClient();
  const parentField: 'account_id' | 'cash_order_id' = accountId ? 'account_id' : 'cash_order_id';
  const parentId = accountId || cashOrderId;
  const { data: invoiceCount = 0 } = useQuery({
    queryKey: ['generated-invoice-count', parentField, parentId],
    enabled: !!parentId && isAuthorized,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('generated_invoices')
        .select('*', { count: 'exact', head: true })
        .eq(parentField, parentId!);
      if (error) throw error;
      return count || 0;
    },
  });

  const updateShipTo = <K extends keyof AddressInput>(key: K, value: AddressInput[K]) => {
    setShipTo((prev) => ({ ...prev, [key]: value }));
  };
  const updateBillTo = <K extends keyof AddressInput>(key: K, value: AddressInput[K]) => {
    setBillTo((prev) => ({ ...prev, [key]: value }));
  };
  const updateItem = <K extends keyof ItemInput>(idx: number, key: K, value: ItemInput[K]) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, [key]: value } : it)));
  };
  const addItem = () => {
    if (items.length >= MAX_ITEMS) return;
    setItems((prev) => [...prev, emptyItem()]);
  };
  const removeItem = (idx: number) => {
    if (items.length <= 1) return; // keep at least one
    setItems((prev) => prev.filter((_, i) => i !== idx));
  };

  // Live total preview — matches Invoice-Use this tab's display math
  // (subtotal of inclusive amounts − discount + shipping). The edge
  // function's pretax/tax decomposition is computed server-side; this
  // preview shows the customer-facing total only.
  const subtotalInclusive = items.reduce(
    (sum, it) => sum + it.qty * it.unit_price_jpy_inclusive,
    0,
  );
  const discountNum = Math.max(0, parseFloat(discount) || 0);
  const shippingNum = Math.max(0, parseFloat(shipping) || 0);
  const totalPreview = Math.max(0, subtotalInclusive - discountNum + shippingNum);

  const isFormValid = (() => {
    if (!shipTo.name.trim() || !shipTo.address_line1.trim()) return false;
    if (!billSameAsShip && (!billTo.name.trim() || !billTo.address_line1.trim())) return false;
    if (items.length < 1 || items.length > MAX_ITEMS) return false;
    for (const it of items) {
      if (!it.description.trim()) return false;
      if (!Number.isInteger(it.qty) || it.qty < 1) return false;
      if (it.unit_price_jpy_inclusive < 0) return false;
    }
    if (discountNum < 0 || shippingNum < 0) return false;
    return true;
  })();

  const resetAll = () => {
    setStep('form');
    setShipTo(initShipTo());
    setBillTo(emptyAddress());
    setBillSameAsShip(true);
    setItems([emptyItem()]);
    setDiscount('0');
    setShipping('0');
    setTerms('');
    setResult(null);
  };

  const generateAnother = () => {
    // Preserve shipTo (likely same customer); clear everything else.
    setStep('form');
    setBillTo(emptyAddress());
    setBillSameAsShip(true);
    setItems([emptyItem()]);
    setDiscount('0');
    setShipping('0');
    setTerms('');
    setResult(null);
  };

  const handleClose = () => {
    setOpen(false);
    resetAll();
  };

  const handleSubmit = async () => {
    if (submittingRef.current) return;
    if (!isFormValid) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const finalBillTo = billSameAsShip ? shipTo : billTo;
      const body: Record<string, unknown> = {
        ship_to: shipTo,
        bill_to: finalBillTo,
        items: items.map((it) => ({
          description: it.description.trim(),
          qty: it.qty,
          unit_price_jpy_inclusive: it.unit_price_jpy_inclusive,
        })),
        discount_jpy: discountNum,
        shipping_fee_jpy: shippingNum,
      };
      if (terms.trim()) body.terms = terms.trim();
      if (accountId) body.account_id = accountId;
      if (cashOrderId) body.cash_order_id = cashOrderId;

      const { data, error } = await supabase.functions.invoke('generate-invoice', { body });
      if (error) throw error;
      const invoice = (data as any)?.invoice;
      if (!invoice?.sheet_url) {
        throw new Error('Invoice generated but response missing sheet_url');
      }
      setResult({
        sheet_url: invoice.sheet_url,
        sheet_id: invoice.sheet_id,
        total_jpy: invoice.total_jpy,
      });
      setStep('success');
      toast.success(`Invoice generated · ${formatCurrency(invoice.total_jpy, 'JPY')}`);
      queryClient.invalidateQueries({ queryKey: ['generated-invoice-count', parentField, parentId] });
      onInvoiceGenerated?.({
        sheet_url: invoice.sheet_url,
        sheet_id: invoice.sheet_id,
        total_jpy: invoice.total_jpy,
      });
    } catch (err: any) {
      toast.error(err?.message || 'Failed to generate invoice');
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  if (!isAuthorized) return null;

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) handleClose(); else setOpen(v); }}>
      <SheetTrigger asChild>
        <Button variant="outline" className="border-primary/30 text-primary hover:bg-primary/10">
          <FileText className="h-4 w-4 mr-1" /> Generate Invoice
          {invoiceCount > 0 && (
            <Badge variant="secondary" className="ml-2 h-5 px-1.5 text-xs">
              {invoiceCount}
            </Badge>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Generate Invoice — {parentInvoiceNumber}</SheetTitle>
          <SheetDescription>JPY only · Tax-inclusive prices</SheetDescription>
        </SheetHeader>

        {step === 'form' && (
          <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="space-y-5 py-4">
            <div className="space-y-2">
              <Label>Terms (optional)</Label>
              <Textarea
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                placeholder="e.g., 6 Months"
                rows={2}
                className="resize-none"
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="bill-same-as-ship"
                checked={billSameAsShip}
                onChange={(e) => setBillSameAsShip(e.target.checked)}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              <Label htmlFor="bill-same-as-ship" className="cursor-pointer text-sm">
                Bill To = Ship To (skip Bill To section)
              </Label>
            </div>

            <div className="space-y-3 rounded-lg border border-border p-4">
              <h3 className="text-sm font-semibold text-card-foreground">Ship To</h3>
              <div className="space-y-2">
                <Label>Name *</Label>
                <Input
                  value={shipTo.name}
                  onChange={(e) => updateShipTo('name', e.target.value)}
                  placeholder="Customer name"
                />
              </div>
              <div className="space-y-2">
                <Label>Street / Building *</Label>
                <Input
                  value={shipTo.address_line1}
                  onChange={(e) => updateShipTo('address_line1', e.target.value)}
                  placeholder="1-2-3 Building Name"
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-2">
                  <Label>City</Label>
                  <Input
                    value={shipTo.city}
                    onChange={(e) => updateShipTo('city', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Postal Code</Label>
                  <Input
                    value={shipTo.postal_code}
                    onChange={(e) => updateShipTo('postal_code', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Country</Label>
                  <Input
                    value={shipTo.country}
                    onChange={(e) => updateShipTo('country', e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Phone</Label>
                <Input
                  value={shipTo.phone}
                  onChange={(e) => updateShipTo('phone', e.target.value)}
                />
              </div>
            </div>

            {!billSameAsShip && (
              <div className="space-y-3 rounded-lg border border-border p-4">
                <h3 className="text-sm font-semibold text-card-foreground">Bill To</h3>
                <div className="space-y-2">
                  <Label>Name *</Label>
                  <Input
                    value={billTo.name}
                    onChange={(e) => updateBillTo('name', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Street / Building *</Label>
                  <Input
                    value={billTo.address_line1}
                    onChange={(e) => updateBillTo('address_line1', e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-2">
                    <Label>City</Label>
                    <Input
                      value={billTo.city}
                      onChange={(e) => updateBillTo('city', e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Postal Code</Label>
                    <Input
                      value={billTo.postal_code}
                      onChange={(e) => updateBillTo('postal_code', e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Country</Label>
                    <Input
                      value={billTo.country}
                      onChange={(e) => updateBillTo('country', e.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Phone</Label>
                  <Input
                    value={billTo.phone}
                    onChange={(e) => updateBillTo('phone', e.target.value)}
                  />
                </div>
              </div>
            )}

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-card-foreground">
                  Items ({items.length} of {MAX_ITEMS})
                </h3>
              </div>
              <div className="space-y-2">
                {items.map((it, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2 items-end">
                    <div className="col-span-6 space-y-1">
                      {idx === 0 && <Label className="text-xs">Description</Label>}
                      <Input
                        value={it.description}
                        onChange={(e) => updateItem(idx, 'description', e.target.value)}
                        placeholder="Item name"
                      />
                    </div>
                    <div className="col-span-2 space-y-1">
                      {idx === 0 && <Label className="text-xs">Qty</Label>}
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        value={it.qty}
                        onChange={(e) => updateItem(idx, 'qty', parseInt(e.target.value, 10) || 1)}
                      />
                    </div>
                    <div className="col-span-3 space-y-1">
                      {idx === 0 && <Label className="text-xs">Unit ¥ (incl.)</Label>}
                      <Input
                        type="number"
                        min={0}
                        step="any"
                        value={it.unit_price_jpy_inclusive}
                        onChange={(e) => updateItem(idx, 'unit_price_jpy_inclusive', parseFloat(e.target.value) || 0)}
                      />
                    </div>
                    <div className="col-span-1 flex justify-center pb-1">
                      <button
                        type="button"
                        onClick={() => removeItem(idx)}
                        disabled={items.length <= 1}
                        className="text-muted-foreground hover:text-destructive disabled:opacity-30 disabled:cursor-not-allowed"
                        aria-label="Remove item"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {items.length < MAX_ITEMS && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addItem}
                  className="w-full"
                >
                  <Plus className="h-4 w-4 mr-1" /> Add Item
                </Button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Discount (¥)</Label>
                <Input
                  type="number"
                  min={0}
                  step="any"
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Shipping Fee (¥)</Label>
                <Input
                  type="number"
                  min={0}
                  step="any"
                  value={shipping}
                  onChange={(e) => setShipping(e.target.value)}
                />
              </div>
            </div>

            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Total preview (customer pays)</span>
              <span className="text-lg font-bold text-primary tabular-nums">
                {formatCurrency(totalPreview, 'JPY')}
              </span>
            </div>

            <SheetFooter className="gap-2 pt-2">
              <Button type="button" variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!isFormValid || submitting}
                className="gold-gradient text-primary-foreground"
              >
                {submitting ? 'Generating…' : 'Generate Invoice'}
                <FileText className="h-4 w-4 ml-1" />
              </Button>
            </SheetFooter>
          </form>
        )}

        {step === 'success' && result && (
          <div className="space-y-5 py-4">
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-5 space-y-3 text-center">
              <CheckCircle2 className="h-12 w-12 text-primary mx-auto" />
              <h3 className="text-lg font-semibold text-card-foreground">Invoice generated</h3>
              <div className="space-y-1">
                <div className="text-sm text-muted-foreground">{parentInvoiceNumber}</div>
                <div className="text-2xl font-bold text-primary tabular-nums">
                  {formatCurrency(result.total_jpy, 'JPY')}
                </div>
              </div>
              <Button
                type="button"
                onClick={() => window.open(result.sheet_url, '_blank', 'noopener,noreferrer')}
                className="w-full gold-gradient text-primary-foreground"
              >
                <ExternalLink className="h-4 w-4 mr-1" /> Open in Drive
              </Button>
            </div>
            <SheetFooter className="gap-2">
              <Button type="button" variant="outline" onClick={generateAnother}>
                Generate Another
              </Button>
              <Button type="button" onClick={handleClose}>
                Done
              </Button>
            </SheetFooter>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
