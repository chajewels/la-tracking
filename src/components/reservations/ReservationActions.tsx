import { useState } from 'react';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { formatPHTDisplay } from '@/lib/date-utils';
import { deadlineHoursLabel, reservationRefusalMessage } from '@/lib/web-reservations';
import {
  useConfirmWebOrderReady, useDeclineWebReservation, usePreviewWebOrderReady,
} from '@/hooks/use-supabase-data';

/**
 * Confirm / Can't supply for ONE web reservation (reserve-first A2).
 *
 * Used on CashOrderDetail, AccountDetail and every row of the Dashboard's
 * "Reservations to confirm" card. Callers gate it on
 * can('confirm_web_order_ready'); the edge functions check the same key again.
 *
 * CONFIRM states the deadline the customer will get BEFORE staff commit to it:
 * the dialog asks confirm-web-order-ready for a preview, which reads the same
 * web_deposit_deadline_hours rule the confirmation writes (24h first order,
 * 72h returning). Nothing here computes the number.
 *
 * CAN'T SUPPLY requires a reason — the customer is emailed it.
 */
export interface ReservationActionsProps {
  entityType: 'cash_order' | 'layaway';
  entityId: string;
  reference: string;
  /** Smaller buttons for list rows. */
  compact?: boolean;
  onDone?: () => void;
}

export default function ReservationActions({ entityType, entityId, reference, compact, onDone }: ReservationActionsProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [reason, setReason] = useState('');
  const confirm = useConfirmWebOrderReady();
  const decline = useDeclineWebReservation();
  const preview = usePreviewWebOrderReady(entityType, entityId, confirmOpen);
  const isLayaway = entityType === 'layaway';

  async function doConfirm() {
    try {
      const r = await confirm.mutateAsync({ entity_type: entityType, entity_id: entityId });
      toast.success(`${reference} confirmed`, {
        description: r.email?.sent === false
          ? `Deadline ${formatPHTDisplay(r.transfer_due_at)}. The payment email was NOT sent (${r.email.reason ?? 'unknown'}) — send the details to the customer directly.`
          : `The customer has been emailed the payment details. Deadline ${formatPHTDisplay(r.transfer_due_at)}.`,
      });
      setConfirmOpen(false);
      onDone?.();
    } catch (err) {
      const e = err as Error & { code?: string; status?: string | null };
      toast.error(reservationRefusalMessage(e.code ?? '', { status: e.status }) || e.message);
    }
  }

  async function doDecline() {
    try {
      const r = await decline.mutateAsync({ entity_type: entityType, entity_id: entityId, reason: reason.trim() });
      toast.success(`${reference} cancelled — piece back in stock`, {
        description: r.email?.sent === false
          ? `The email to the customer was NOT sent (${r.email.reason ?? 'unknown'}) — let them know directly.`
          : 'The customer has been emailed the reason.',
      });
      setDeclineOpen(false);
      setReason('');
      onDone?.();
    } catch (err) {
      const e = err as Error & { code?: string; status?: string | null };
      toast.error(reservationRefusalMessage(e.code ?? '', { status: e.status }) || e.message);
    }
  }

  const size = compact ? 'sm' : 'default';
  const previewDue = preview.data?.transfer_due_at ?? null;
  const previewHours = preview.data?.deadline_hours ?? null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button size={size} className={compact ? 'h-8' : undefined} onClick={() => setConfirmOpen(true)}>
          <CheckCircle2 className="mr-1.5 h-4 w-4" />
          Confirm
        </Button>
        <Button
          size={size}
          variant="outline"
          className={`border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive ${compact ? 'h-8' : ''}`}
          onClick={() => setDeclineOpen(true)}
        >
          <XCircle className="mr-1.5 h-4 w-4" />
          Can’t supply
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm {reference} — ready for dispatch</DialogTitle>
            <DialogDescription>
              Only confirm once you have checked the piece and can send it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
              {preview.isLoading ? (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Working out the customer’s deadline…
                </p>
              ) : preview.isError ? (
                <p className="text-destructive">
                  Could not read the deadline: {(preview.error as Error).message}. You can still confirm; the
                  deadline is set by the server either way.
                </p>
              ) : (
                <p className="text-card-foreground">
                  The customer gets <strong>{deadlineHoursLabel(previewHours)}</strong> to{' '}
                  {isLayaway ? 'send the deposit' : 'pay'} — until{' '}
                  <strong>{previewDue ? formatPHTDisplay(previewDue) : '—'}</strong>.
                </p>
              )}
            </div>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>They are emailed the bank details and the deadline now, and see them on their order in the storefront.</li>
              {isLayaway && <li>The payment schedule is re-dated to start from today.</li>}
              <li>If nothing arrives by the deadline, the hourly job releases the piece as usual.</li>
            </ul>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={confirm.isPending}>Cancel</Button>
            <Button onClick={doConfirm} disabled={confirm.isPending || preview.isLoading}>
              {confirm.isPending ? 'Confirming…' : 'Confirm and email the customer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={declineOpen} onOpenChange={setDeclineOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Can’t supply {reference}?</DialogTitle>
            <DialogDescription>
              This cancels the reservation, puts the piece back in stock and emails the customer the reason
              below. Nothing was paid, so there is nothing to refund.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`decline-reason-${entityId}`}>
              Reason for the customer <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id={`decline-reason-${entityId}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. The piece did not pass our final inspection."
              rows={3}
              maxLength={500}
              className="bg-background border-border"
            />
            <p className="text-[11px] text-muted-foreground">
              Required. The customer reads this word for word{isLayaway ? ' (in English)' : ''}.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeclineOpen(false)} disabled={decline.isPending}>Back</Button>
            <Button
              variant="destructive"
              onClick={doDecline}
              disabled={decline.isPending || reason.trim().length < 3}
            >
              {decline.isPending ? 'Cancelling…' : 'Cancel reservation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
