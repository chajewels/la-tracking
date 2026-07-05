import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { getPHTToday } from '@/lib/date-utils';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';

export const RESALE_STATUSES = ['In stock', 'Sold'] as const;
export type ResaleStatus = typeof RESALE_STATUSES[number];

export interface TradeInRow {
  id: string;
  date_trade: string;
  customer_id: string | null;
  old_invoice_number: string;
  new_invoice_number: string | null;
  item_code: string;
  item_description: string;
  trade_amount: number;
  resale_amount: number | null;
  resale_status: ResaleStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
  customers?: { id: string; full_name: string } | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'add' | 'edit';
  initialTradeIn?: TradeInRow | null;
}

type LookupResult = { customerId: string | null; customerName: string } | null;

async function lookupInvoice(inv: string): Promise<LookupResult> {
  if (!inv) return null;
  if (!/^[0-9]+$/.test(inv)) return null;
  const [laRes, coRes] = await Promise.all([
    supabase
      .from('layaway_accounts')
      .select('customer_id, customers:customer_id (full_name)')
      .eq('invoice_number', inv)
      .maybeSingle(),
    supabase
      .from('cash_orders')
      .select('customer_id, customers:customer_id (full_name)')
      .eq('invoice_number', inv)
      .maybeSingle(),
  ]);
  const la = laRes.data as { customer_id: string | null; customers: { full_name: string } | null } | null;
  const co = coRes.data as { customer_id: string | null; customers: { full_name: string } | null } | null;
  if (la) return { customerId: la.customer_id, customerName: la.customers?.full_name ?? '' };
  if (co) return { customerId: co.customer_id, customerName: co.customers?.full_name ?? '' };
  return null;
}

export default function TradeInDialog({ open, onOpenChange, mode, initialTradeIn }: Props) {
  const qc = useQueryClient();
  const isEdit = mode === 'edit';

  const [dateTrade, setDateTrade] = useState<string>(getPHTToday());
  const [oldInvoice, setOldInvoice] = useState<string>('');
  const [newInvoice, setNewInvoice] = useState<string>('');
  const [itemCode, setItemCode] = useState<string>('');
  const [itemDescription, setItemDescription] = useState<string>('');
  const [tradeAmount, setTradeAmount] = useState<string>('');
  const [resaleAmount, setResaleAmount] = useState<string>('');
  const [resaleStatus, setResaleStatus] = useState<ResaleStatus>('In stock');
  const [notes, setNotes] = useState<string>('');

  // Old invoice resolution (drives customer_id)
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [oldCustomerName, setOldCustomerName] = useState<string>('');
  const [oldResolving, setOldResolving] = useState(false);
  const [oldError, setOldError] = useState<string>('');

  // New invoice resolution (info only — no customer_id)
  const [newCustomerName, setNewCustomerName] = useState<string>('');
  const [newResolving, setNewResolving] = useState(false);
  const [newWarning, setNewWarning] = useState<string>('');

  const [attemptedSave, setAttemptedSave] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAttemptedSave(false);
    if (isEdit && initialTradeIn) {
      setDateTrade(initialTradeIn.date_trade);
      setOldInvoice(initialTradeIn.old_invoice_number);
      setNewInvoice(initialTradeIn.new_invoice_number ?? '');
      setItemCode(initialTradeIn.item_code);
      setItemDescription(initialTradeIn.item_description);
      setTradeAmount(String(Math.round(Number(initialTradeIn.trade_amount))));
      setResaleAmount(initialTradeIn.resale_amount != null ? String(Math.round(Number(initialTradeIn.resale_amount))) : '');
      setResaleStatus(initialTradeIn.resale_status);
      setNotes(initialTradeIn.notes ?? '');
      setCustomerId(initialTradeIn.customer_id);
      setOldCustomerName(initialTradeIn.customers?.full_name ?? '');
      setNewCustomerName('');
      setOldError('');
      setNewWarning('');
    } else {
      setDateTrade(getPHTToday());
      setOldInvoice('');
      setNewInvoice('');
      setItemCode('');
      setItemDescription('');
      setTradeAmount('');
      setResaleAmount('');
      setResaleStatus('In stock');
      setNotes('');
      setCustomerId(null);
      setOldCustomerName('');
      setNewCustomerName('');
      setOldError('');
      setNewWarning('');
    }
  }, [open, isEdit, initialTradeIn]);

  const resolveOld = async (raw: string) => {
    const inv = raw.trim();
    if (!inv) {
      setCustomerId(null);
      setOldCustomerName('');
      setOldError('');
      return;
    }
    setOldResolving(true);
    setOldError('');
    try {
      const r = await lookupInvoice(inv);
      if (r) {
        setCustomerId(r.customerId);
        setOldCustomerName(r.customerName);
      } else {
        setCustomerId(null);
        setOldCustomerName('');
        setOldError('Invoice # not found');
      }
    } catch (err) {
      setOldError('Lookup failed: ' + ((err as Error).message || String(err)));
    } finally {
      setOldResolving(false);
    }
  };

  const resolveNew = async (raw: string) => {
    const inv = raw.trim();
    if (!inv) {
      setNewCustomerName('');
      setNewWarning('');
      return;
    }
    setNewResolving(true);
    setNewWarning('');
    try {
      const r = await lookupInvoice(inv);
      if (r) {
        setNewCustomerName(r.customerName);
      } else {
        setNewCustomerName('');
        setNewWarning('Invoice # not found');
      }
    } catch (err) {
      setNewWarning('Lookup failed: ' + ((err as Error).message || String(err)));
    } finally {
      setNewResolving(false);
    }
  };

  const errors = useMemo(() => {
    const e: Record<string, string> = {};
    if (!oldInvoice.trim()) e.oldInvoice = 'Old Invoice # is required';
    else if (oldError) e.oldInvoice = oldError;
    else if (!customerId && !isEdit) e.oldInvoice = 'Old Invoice # not found';
    if (!itemCode.trim()) e.itemCode = 'Item Code is required';
    if (!itemDescription.trim()) e.itemDescription = 'Item Description is required';
    if (!tradeAmount.trim()) e.tradeAmount = 'Trade Amount is required';
    return e;
  }, [oldInvoice, oldError, customerId, isEdit, itemCode, itemDescription, tradeAmount]);

  const canSave = Object.keys(errors).length === 0;

  const mutation = useMutation({
    mutationFn: async () => {
      const tradeNum = Math.round(Number(tradeAmount));
      const resaleNum = resaleAmount === '' ? null : Math.round(Number(resaleAmount));
      const basePayload = {
        date_trade: dateTrade,
        customer_id: customerId as string,
        old_invoice_number: oldInvoice.trim(),
        new_invoice_number: newInvoice.trim() || null,
        item_code: itemCode.trim(),
        item_description: itemDescription.trim(),
        trade_amount: tradeNum,
        resale_amount: resaleNum,
        resale_status: resaleStatus,
        notes: notes.trim() || null,
      };
      if (isEdit && initialTradeIn) {
        const { error } = await supabase
          .from('trade_ins')
          .update({ ...basePayload, updated_at: new Date().toISOString() })
          .eq('id', initialTradeIn.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('trade_ins')
          .insert(basePayload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success('Trade-in saved');
      qc.invalidateQueries({ queryKey: ['trade-ins'] });
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast.error('Save failed', { description: err.message });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Trade-In' : 'New Trade-In'}</DialogTitle>
          <DialogDescription>
            {isEdit ? 'Update an existing trade-in entry.' : 'Record a trade-in against an existing invoice.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="date_trade">Date Trade</Label>
              <Input
                id="date_trade"
                type="date"
                value={dateTrade}
                onChange={(e) => setDateTrade(e.target.value)}
              />
            </div>
            <div>
              <Label>Resale Status</Label>
              <Select value={resaleStatus} onValueChange={(v) => setResaleStatus(v as ResaleStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESALE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="old_invoice">Old Invoice # (item from)</Label>
              <Input
                id="old_invoice"
                value={oldInvoice}
                onChange={(e) => setOldInvoice(e.target.value)}
                onBlur={() => resolveOld(oldInvoice)}
                placeholder="e.g. 19105"
              />
              <div className="mt-1 min-h-[18px] text-xs">
                {oldResolving && (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Resolving…
                  </span>
                )}
                {!oldResolving && oldCustomerName && !oldError && (
                  <span className="inline-flex items-center gap-1 text-emerald-500">
                    <CheckCircle2 className="h-3 w-3" /> {oldCustomerName}
                  </span>
                )}
                {!oldResolving && oldError && (
                  <span className="inline-flex items-center gap-1 text-destructive">
                    <XCircle className="h-3 w-3" /> {oldError}
                  </span>
                )}
                {!oldResolving && !oldError && attemptedSave && errors.oldInvoice && !oldCustomerName && (
                  <span className="text-destructive">{errors.oldInvoice}</span>
                )}
              </div>
            </div>
            <div>
              <Label htmlFor="new_invoice">New Invoice # (credit applied to)</Label>
              <Input
                id="new_invoice"
                value={newInvoice}
                onChange={(e) => setNewInvoice(e.target.value)}
                onBlur={() => resolveNew(newInvoice)}
                placeholder="optional"
              />
              <div className="mt-1 min-h-[18px] text-xs">
                {newResolving && (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Resolving…
                  </span>
                )}
                {!newResolving && newCustomerName && !newWarning && (
                  <span className="inline-flex items-center gap-1 text-emerald-500">
                    <CheckCircle2 className="h-3 w-3" /> {newCustomerName}
                  </span>
                )}
                {!newResolving && newWarning && (
                  <span className="inline-flex items-center gap-1 text-destructive">
                    <XCircle className="h-3 w-3" /> {newWarning}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="item_code">Item Code</Label>
              <Input
                id="item_code"
                value={itemCode}
                onChange={(e) => setItemCode(e.target.value)}
                placeholder="e.g. R1234"
              />
              {attemptedSave && errors.itemCode && (
                <p className="mt-1 text-xs text-destructive">{errors.itemCode}</p>
              )}
            </div>
            <div>
              <Label htmlFor="item_description">Item Description</Label>
              <Input
                id="item_description"
                value={itemDescription}
                onChange={(e) => setItemDescription(e.target.value)}
                placeholder="Brief item description"
              />
              {attemptedSave && errors.itemDescription && (
                <p className="mt-1 text-xs text-destructive">{errors.itemDescription}</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Trade Amount (¥)</Label>
              <Input
                inputMode="numeric"
                placeholder="0"
                value={tradeAmount}
                onChange={(e) => setTradeAmount(e.target.value.replace(/[^0-9]/g, ''))}
              />
              {attemptedSave && errors.tradeAmount && (
                <p className="mt-1 text-xs text-destructive">{errors.tradeAmount}</p>
              )}
            </div>
            <div>
              <Label>Resale Amount (¥)</Label>
              <Input
                inputMode="numeric"
                placeholder="(blank until sold)"
                value={resaleAmount}
                onChange={(e) => setResaleAmount(e.target.value.replace(/[^0-9]/g, ''))}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Optional notes"
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setAttemptedSave(true);
              if (!canSave) return;
              mutation.mutate();
            }}
            disabled={mutation.isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {mutation.isPending ? 'Saving…' : (isEdit ? 'Save Changes' : 'Create Trade-In')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
