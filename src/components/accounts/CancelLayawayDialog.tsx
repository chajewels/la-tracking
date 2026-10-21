import { useEffect, useState } from 'react';
import { XCircle, AlertTriangle, Info } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import TypedConfirmField from '@/components/forms/TypedConfirmField';
import { useCancelLayaway, useCancelLayawayPreview } from '@/hooks/use-supabase-data';
import { formatCurrency } from '@/lib/calculations';

/**
 * Staff Cancel for a layaway plan (owner 2026-10-21; docs/LAYAWAY-CANCEL.md).
 *
 * CANCEL = the customer VOLUNTARILY asked to cancel. FORFEIT = she could not
 * settle her dues. The dialog says so first, so staff pick the right action.
 *
 * Everything shown comes from the server preview (cancel-layaway, preview:true,
 * writes nothing): money received (kept on the account — a layaway never
 * auto-issues store credit), earned points that will be reversed, redeemed
 * points that are NOT returned, whether web pieces go back on sale, and the
 * refusal when a payment submission is still waiting. A reason and the typed
 * invoice number are required; the server enforces both again.
 */
interface CancelLayawayDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  invoiceNumber: string;
}

export default function CancelLayawayDialog({ open, onOpenChange, accountId, invoiceNumber }: CancelLayawayDialogProps) {
  const [reason, setReason] = useState('');
  const [armed, setArmed] = useState(false);
  const preview = useCancelLayawayPreview(accountId, open);
  const cancelLayaway = useCancelLayaway();

  useEffect(() => {
    if (!open) {
      setReason('');
      setArmed(false);
    }
  }, [open]);

  const p = preview.data;
  const refusal = p?.refusal ?? null;
  const canSubmit = !!p && !refusal && reason.trim().length > 0 && armed && !cancelLayaway.isPending;

  const submit = async () => {
    try {
      await cancelLayaway.mutateAsync({ accountId, reason: reason.trim() });
      toast.success(`Layaway INV #${invoiceNumber} cancelled`);
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error((err as Error).message || 'Failed to cancel the layaway');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto grid-cols-[minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle className="font-display flex items-center gap-2">
            <XCircle className="h-5 w-5 text-destructive" /> Cancel Layaway Plan?
          </DialogTitle>
          <DialogDescription>INV #{invoiceNumber}</DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm flex gap-2">
          <Info className="h-4 w-4 mt-0.5 shrink-0 text-info" />
          <span>
            Use <strong>Cancel</strong> only when the customer asked to cancel. If she could not pay, use{' '}
            <strong>Forfeit</strong> instead.
          </span>
        </div>

        {preview.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
          </div>
        )}

        {preview.isError && (
          <p className="text-sm text-destructive">
            Could not load what the cancel would do: {(preview.error as Error)?.message}
          </p>
        )}

        {p && (
          <div className="space-y-2 text-sm">
            {refusal === 'payment_submission_pending' && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 flex gap-2 text-destructive">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  {p.pending_submissions} payment submission(s) on this plan are still waiting. Confirm or reject them
                  first, then cancel.
                </span>
              </div>
            )}
            {refusal === 'not_cancellable' && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 flex gap-2 text-destructive">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>This plan is already closed ({p.status}) and cannot be cancelled.</span>
              </div>
            )}
            <ul className="space-y-1.5 text-muted-foreground">
              <li>
                Money received:{' '}
                <span className="text-foreground font-medium tabular-nums">
                  {formatCurrency(Number(p.money_received ?? 0), p.currency)}
                </span>{' '}
                — stays on the account. No store credit is issued automatically.
              </li>
              <li>
                {p.earned_points_will_be_revoked ? (
                  <>
                    Earned points reversed:{' '}
                    <span className="text-foreground font-medium tabular-nums">
                      {Number(p.earned_points_on_order).toLocaleString()} pts
                    </span>{' '}
                    (from what remains of them).
                  </>
                ) : (
                  <>No points were earned on this plan.</>
                )}
              </li>
              {Number(p.redeemed_points_not_returned) > 0 && (
                <li>
                  Redeemed points <strong>not returned</strong>:{' '}
                  <span className="text-foreground font-medium tabular-nums">
                    {Number(p.redeemed_points_not_returned).toLocaleString()} pts
                  </span>
                </li>
              )}
              {p.web_stock_will_be_released && <li>Web plan: its pieces go back on sale on the website.</li>}
              <li>The customer is emailed that the plan was cancelled. The reason below is not sent to her.</li>
              <li>A cancelled plan cannot be reactivated.</li>
            </ul>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="cancel-layaway-reason" className="text-xs text-muted-foreground">
            Reason (internal) *
          </Label>
          <Textarea
            id="cancel-layaway-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Customer asked to cancel on Messenger on 21 Oct"
            rows={3}
            disabled={!!refusal}
          />
        </div>

        {!refusal && <TypedConfirmField word={invoiceNumber} onArmedChange={setArmed} />}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={cancelLayaway.isPending}>
            Keep Plan
          </Button>
          <Button variant="destructive" onClick={submit} disabled={!canSubmit}>
            {cancelLayaway.isPending ? 'Cancelling…' : 'Cancel Plan'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
