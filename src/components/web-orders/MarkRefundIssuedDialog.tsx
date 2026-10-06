import { useState } from 'react';
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
};

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
      toast.success((data as { email_sent?: boolean } | null)?.email_sent
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
              {METHODS.map((m) => (
                <div key={m.value} className="flex items-center gap-2">
                  <RadioGroupItem id={`refund-${m.value}`} value={m.value} />
                  <Label htmlFor={`refund-${m.value}`} className="font-normal">{m.label}</Label>
                </div>
              ))}
            </RadioGroup>
          </div>
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
          <Button onClick={submit} disabled={busy || !day}>{busy ? 'Saving…' : 'Mark refund issued'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
