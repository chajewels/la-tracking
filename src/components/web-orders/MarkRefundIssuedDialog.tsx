import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { getPHTToday } from '@/lib/date-utils';

/**
 * MARK REFUND ISSUED (payment lifecycle addendum §9 #8, owner directive
 * 2026-10-06). A cancelled WEBSITE order whose refund decision was "Refund
 * pending" stays pending until staff record here that the money went back —
 * how and on which day. The mark-refund-issued edge function does it
 * (permission cancel_cash_order, audited, one database writer) and emails the
 * customer 「返金が完了しました」 with the amount, method and date. It moves no
 * money: send the refund first (bank, Paidy or Square dashboard), then record it.
 *
 * B01 (Square QA, owner 2026-10-08): a CARD-paid order is refunded in Square.
 * The dialog then offers Card only, shows what Square has COMPLETED, and the
 * Hub records exactly that amount (partial refunds included); it refuses
 * while Square shows no completed refund. Pressing it again after it worked
 * returns the same answer and sends no second email.
 */

const METHODS = [
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'paidy', label: 'Paidy (refunded in the Paidy dashboard)' },
  { value: 'card', label: 'Card (refunded in the Square Dashboard)' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
] as const;

const REFUSAL: Record<string, string> = {
  not_cancelled: 'This order is not cancelled.',
  not_refund_pending: 'This order is not waiting for a refund (it may already be marked refunded).',
  not_web_order: 'Only website orders use this.',
  bad_method: 'Choose how the refund was sent.',
  bad_date: 'Enter the day the refund was sent (not a future day).',
  not_found: 'Order not found.',
  method_mismatch: 'The method does not match how she paid. A card payment is refunded in Square and recorded as Card; a Paidy payment is refunded in the Paidy dashboard and recorded as Paidy.',
  no_completed_card_refund: 'Square does not show a completed refund for this order yet. Refund it in the Square Dashboard first; a pending refund is not enough.',
  // PA03 (2026-10-08): only a Paidy refund the Hub has read back counts.
  no_verified_paidy_refund: 'The Hub has not recorded a Paidy refund for this order yet. Refund it in the Paidy merchant dashboard first; the hourly check records it, then mark it here. The amount recorded is what Paidy refunded, never the full receipt.',
};

/** What the dialog needs to know about card money on the order (B01). */
interface CardRefundFacts { paidByCard: boolean; cardPaid: number; refundedCompleted: number; refundedPending: number }

async function loadCardRefundFacts(orderId: string): Promise<CardRefundFacts> {
  const [pays, refunds] = await Promise.all([
    supabase.from('cash_payments').select('amount_paid, payment_method').eq('cash_order_id', orderId).is('voided_at', null),
    supabase.from('square_refunds').select('amount_jpy, status').eq('cash_order_id', orderId),
  ]);
  if (pays.error) throw pays.error;
  if (refunds.error) throw refunds.error;
  const card = (pays.data ?? []).filter((p) => p.payment_method === 'square');
  const rows = (refunds.data ?? []) as { amount_jpy: number | string | null; status: string | null }[];
  const sum = (xs: { amount_jpy: number | string | null }[]) => xs.reduce((t, r) => t + Number(r.amount_jpy ?? 0), 0);
  return {
    paidByCard: card.length > 0,
    cardPaid: card.reduce((t, p) => t + Number(p.amount_paid ?? 0), 0),
    refundedCompleted: sum(rows.filter((r) => r.status === 'COMPLETED')),
    refundedPending: sum(rows.filter((r) => r.status !== 'COMPLETED' && r.status !== 'FAILED' && r.status !== 'REJECTED')),
  };
}

const yen = (n: number) => `¥${Math.round(n).toLocaleString('en-US')}`;

async function errorCode(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown })?.context;
  try {
    if (ctx instanceof Response) return String((await ctx.clone().json())?.error ?? '');
  } catch { /* fall through */ }
  return (error as Error)?.message ?? 'error';
}

/** Shown only for a cancelled web order whose refund decision is still pending. */
export function canMarkRefundIssued(o: { source_channel?: string | null; status?: string | null; refund_status?: string | null } | null | undefined): boolean {
  return !!o && o.source_channel === 'web' && o.status === 'cancelled' && o.refund_status === 'refund_pending';
}

export function MarkRefundIssuedDialog({
  open, onOpenChange, orderId, reference, onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  orderId: string;
  reference: string;
  onDone: () => void;
}) {
  const [method, setMethod] = useState<string>('bank_transfer');
  const [day, setDay] = useState<string>(getPHTToday());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [card, setCard] = useState<CardRefundFacts | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setCard(null); setCardError(null);
    loadCardRefundFacts(orderId)
      .then((f) => { if (!live) return; setCard(f); if (f.paidByCard) setMethod('card'); })
      .catch((e) => { if (live) setCardError((e as Error)?.message ?? 'Could not read the card payment.'); });
    return () => { live = false; };
  }, [open, orderId]);

  const cardOnly = card?.paidByCard === true;
  const cardBlocked = cardOnly && (card?.refundedCompleted ?? 0) <= 0;
  const methods = cardOnly ? METHODS.filter((m) => m.value === 'card') : METHODS;

  const submit = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('mark-refund-issued', {
        body: { cash_order_id: orderId, method, refunded_on: day, note: note.trim() || undefined },
      });
      if (error) {
        const code = await errorCode(error);
        toast.error(REFUSAL[code] ?? `Could not record the refund: ${code}`);
        return;
      }
      const d = (data ?? {}) as { email_sent?: boolean; email_skipped?: string; already_recorded?: boolean; amount?: number | string };
      toast.success(d.already_recorded
        ? 'This refund was already recorded — nothing changed.'
        : d.email_skipped === 'provider_refund_already_emailed'
          ? `Refund of ${yen(Number(d.amount ?? 0))} recorded. Square's refund email already told the customer.`
          : d.email_skipped === 'provider_refund_email_not_confirmed'
            ? `Refund of ${yen(Number(d.amount ?? 0))} recorded. The Square refund email is not confirmed sent yet — the hourly check will retry; see the order's email history.`
          : d.email_sent
            ? 'Refund recorded — the customer has been emailed.'
            : 'Refund recorded. The email was not sent (see the order\'s email history).');
      onOpenChange(false);
      setNote('');
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mark refund issued — {reference}</DialogTitle>
          <DialogDescription>
            Send the refund first. This records it on the order and emails the customer that her refund is complete.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>How was it refunded?</Label>
            <RadioGroup value={method} onValueChange={setMethod} className="gap-2">
              {methods.map((m) => (
                <div key={m.value} className="flex items-center gap-2">
                  <RadioGroupItem id={`refund-${m.value}`} value={m.value} />
                  <Label htmlFor={`refund-${m.value}`} className="font-normal">{m.label}</Label>
                </div>
              ))}
            </RadioGroup>
          </div>
          {cardError && <p className="text-xs text-destructive">{cardError}</p>}
          {cardOnly && card && (
            <div className={`rounded-md border p-2.5 text-xs ${cardBlocked ? 'border-warning/60 bg-warning/5 text-warning' : 'border-border bg-background text-muted-foreground'}`}>
              <p>Paid by card: {yen(card.cardPaid)}. Square shows <strong className="text-card-foreground">{yen(card.refundedCompleted)}</strong> refunded (completed).</p>
              {card.refundedPending > 0 && <p>Still processing in Square: {yen(card.refundedPending)} (not counted until it completes).</p>}
              {cardBlocked
                ? <p>Refund it in the Square Dashboard first. This button works once Square shows the refund completed.</p>
                : <p>The Hub records {yen(card.refundedCompleted)}, exactly what Square completed.</p>}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="refund-day">Day the refund was sent</Label>
            <Input id="refund-day" type="date" value={day} max={getPHTToday()} onChange={(e) => setDay(e.target.value)} className="bg-background border-border" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="refund-note">Note (optional, the customer sees it on her order)</Label>
            <Textarea id="refund-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} className="bg-background border-border" />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Back</Button>
          <Button onClick={submit} disabled={busy || !day || card === null && !cardError || cardBlocked}>{busy ? 'Saving…' : 'Mark refund issued'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
