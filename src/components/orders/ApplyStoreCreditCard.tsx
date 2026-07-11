import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Wallet } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { usePermissions } from '@/contexts/PermissionsContext';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';

interface ApplyStoreCreditCardProps {
  orderType: 'layaway' | 'cash';
  orderId: string;
  customerId: string;
  currency: Currency;
  totalPaid: number;
  status: string;
  onApplied?: () => void;
}

// Layaway statuses on which credit may be applied (still open).
// Excludes completed / cancelled / forfeited / final_forfeited / final_settlement.
const OPEN_LAYAWAY_STATUSES = new Set(['active', 'overdue', 'extension_active', 'reactivated']);

interface PreviewData {
  currency: string;
  available: number;
  order_remaining: number;
  applicable: number;
  is_downpayment?: boolean;
}

// Surface the edge function's JSON error body (FunctionsHttpError wraps it).
async function extractFnError(error: any, fallback: string): Promise<string> {
  let msg = error?.message || fallback;
  try {
    if (error && 'context' in error && error.context?.body) {
      const b = await new Response(error.context.body).json();
      if (b?.error) msg = b.error;
    }
  } catch { /* ignore */ }
  return msg;
}

export default function ApplyStoreCreditCard({
  orderType,
  orderId,
  customerId,
  currency,
  totalPaid,
  status,
  onApplied,
}: ApplyStoreCreditCardProps) {
  const { can } = usePermissions();
  const canRedeem = can('redeem_store_credit');

  // Gate on order eligibility before we even query for credit. Store credit is
  // real money and may be applied to ANY open order (as a downpayment,
  // installment, or partial payment) regardless of how much has already been
  // paid — so eligibility is based purely on the order still being open.
  const orderEligible =
    orderType === 'cash' ? status === 'pending' : OPEN_LAYAWAY_STATUSES.has(status);

  const enabled = canRedeem && orderEligible && !!customerId;

  const { data: available } = useQuery({
    queryKey: ['store-credit-available', customerId, currency],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('store_credit_lots')
        .select('remaining_amount')
        .eq('customer_id', customerId)
        .eq('currency', currency)
        .eq('status', 'active')
        .gt('expires_at', new Date().toISOString());
      if (error) throw error;
      return ((data || []) as Array<{ remaining_amount: number }>)
        .reduce((s, r) => s + Number(r.remaining_amount), 0);
    },
  });

  const [open, setOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Amount the staff member chooses to apply — defaults to the previewed max.
  const [amount, setAmount] = useState('');

  const orderBody = orderType === 'layaway' ? { account_id: orderId } : { cash_order_id: orderId };

  const runPreview = useCallback(async () => {
    setPreviewLoading(true);
    setPreview(null);
    setPreviewError(null);
    try {
      const { data, error } = await supabase.functions.invoke('redeem-store-credit', {
        body: { ...orderBody, preview: true },
      });
      if (error) throw new Error(await extractFnError(error, 'Preview failed'));
      if ((data as any)?.error) throw new Error((data as any).error);
      const pv = data as PreviewData;
      setPreview(pv);
      // Default the amount field to the full applicable maximum.
      setAmount(String(pv.applicable ?? 0));
    } catch (err: any) {
      setPreviewError(err?.message || 'Preview failed');
    } finally {
      setPreviewLoading(false);
    }
    // orderBody is derived from stable props; safe to omit from deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, orderType]);

  const openDialog = () => {
    setOpen(true);
    runPreview();
  };

  const close = () => {
    setOpen(false);
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(false);
    setSubmitting(false);
    setAmount('');
  };

  const confirm = async () => {
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('redeem-store-credit', {
        body: { ...orderBody, amount: Number(amount) },
      });
      if (error) throw new Error(await extractFnError(error, 'Failed to apply store credit'));
      if ((data as any)?.error) throw new Error((data as any).error);
      const applied = Number((data as any)?.amount_applied ?? 0);
      toast.success(`Applied ${formatCurrency(applied, currency)} of store credit`);
      onApplied?.();
      close();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to apply store credit');
      setSubmitting(false);
    }
  };

  // Invisible unless credit is genuinely applicable.
  if (!enabled) return null;
  if (available == null || available <= 0) return null;

  const applicableMax = Number(preview?.applicable ?? 0);
  const amountNum = Number(amount);
  const amountValid =
    Number.isFinite(amountNum) && amountNum > 0 && amountNum <= applicableMax;

  const confirmDisabled =
    submitting || previewLoading || !!previewError || !preview || applicableMax <= 0 || !amountValid;

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg gold-gradient">
            <Wallet className="h-4 w-4 text-primary-foreground" />
          </div>
          <div>
            <p className="text-sm font-semibold text-card-foreground">
              Store Credit Available: {formatCurrency(available, currency)}
            </p>
            <p className="text-xs text-muted-foreground">Apply to this order ({currency})</p>
          </div>
        </div>
        <Button onClick={openDialog} variant="outline" className="border-primary/30 text-primary hover:bg-primary/10">
          Apply Store Credit
        </Button>
      </div>

      <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
        <DialogContent className="max-w-md border-border bg-card">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-display text-card-foreground">
              <Wallet className="h-5 w-5 text-primary" />
              Apply Store Credit
            </DialogTitle>
          </DialogHeader>

          {previewLoading ? (
            <p className="text-sm text-muted-foreground py-4">Calculating…</p>
          ) : previewError ? (
            <p className="text-sm text-destructive py-2">{previewError}</p>
          ) : preview ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-border bg-background p-3 space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Store credit available</span>
                  <span className="tabular-nums text-card-foreground">{formatCurrency(preview.available, currency)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Order remaining</span>
                  <span className="tabular-nums text-card-foreground">{formatCurrency(preview.order_remaining, currency)}</span>
                </div>
                <div className="flex justify-between border-t border-border pt-1 font-semibold">
                  <span className="text-card-foreground">Maximum applicable</span>
                  <span className="tabular-nums text-card-foreground">{formatCurrency(preview.applicable, currency)}</span>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="sc-apply-amount" className="text-xs">Amount to apply ({currency})</Label>
                <Input
                  id="sc-apply-amount"
                  type="number"
                  min={0}
                  step="any"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="bg-background border-border tabular-nums"
                />
                {!amountValid && amount !== '' && (
                  <p className="text-xs text-destructive">
                    Enter an amount greater than 0 and no more than{' '}
                    {formatCurrency(applicableMax, currency)}.
                  </p>
                )}
              </div>

              {orderType === 'layaway' && preview.is_downpayment === true && (
                <p className="text-[11px] text-primary">This will be applied as the downpayment.</p>
              )}

              <p className="text-[11px] text-muted-foreground">
                Store credit is never converted; any leftover stays as credit.
              </p>
            </div>
          ) : null}

          <DialogFooter className="gap-2">
            <Button variant="outline" disabled={submitting} onClick={close}>Cancel</Button>
            <Button
              disabled={confirmDisabled}
              onClick={confirm}
              className="gold-gradient text-primary-foreground"
            >
              {submitting ? 'Applying…' : 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
