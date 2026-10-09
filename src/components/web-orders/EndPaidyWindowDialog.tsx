import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';

/**
 * END PAIDY WINDOW (Paidy QC H1, owner go 2026-10-09). A customer's Paidy
 * window can stay open — and lock the order — when the payment id it noted
 * cannot be verified with Paidy. Staff end it here: the paidy-staff-action
 * edge function asks Paidy first (an authorisation it still holds is filed or
 * released, a capture opens its case), then ends the window with the written
 * reason (confirm_payment, audited). Only a window that has timed out
 * (30 minutes) can be ended — the customer may be paying right now otherwise.
 */

const REFUSAL: Record<string, string> = {
  reason_required: 'Write the reason (at least 10 characters).',
  window_still_open: 'The customer opened Paidy less than 30 minutes ago and may be paying right now. Try again after the window times out.',
  paidy_unavailable: 'Could not check the payment with Paidy. Nothing was changed — try again in a few minutes.',
  paidy_holds_authorization: 'Paidy still holds an authorisation for this window. Nothing was ended — see Payment Submissions → Paidy cases.',
  forbidden: 'You need the Confirm payment permission to end a Paidy window.',
  not_found: 'This order was not found.',
};

async function errorCode(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown })?.context;
  try {
    if (ctx instanceof Response) return String((await ctx.clone().json())?.error ?? '');
  } catch { /* fall through */ }
  return (error as Error)?.message ?? 'error';
}

export function EndPaidyWindowDialog({
  open, onOpenChange, cashOrderId, reference, onEnded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  cashOrderId: string;
  reference: string;
  onEnded: () => void;
}) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    const { data, error } = await supabase.functions.invoke('paidy-staff-action', {
      body: { action: 'end_window', cash_order_id: cashOrderId, reason: reason.trim() },
    });
    setSaving(false);
    if (error || !data?.ok) {
      const code = error ? await errorCode(error) : String(data?.error ?? 'error');
      toast.error('Paidy window not ended', { description: REFUSAL[code] ?? code });
      return;
    }
    toast.success(data.ended ? 'Paidy window ended' : 'No open Paidy window', {
      description: data.ended ? 'The order is open for another way to pay.' : 'Nothing needed ending.',
    });
    setReason('');
    onOpenChange(false);
    onEnded();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>End the Paidy window · {reference}</DialogTitle>
          <DialogDescription>
            Use this only when the window is stuck. The Hub asks Paidy first: if Paidy holds a payment for it, that payment
            is filed (or released) instead. Otherwise the window ends and bank transfer and card come back for this order.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="end-paidy-reason">Reason (required)</Label>
          <Textarea
            id="end-paidy-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Customer says she closed Paidy; the window has been stuck since yesterday"
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving || reason.trim().length < 10} data-testid="end-paidy-window-submit">
            {saving ? 'Checking with Paidy…' : 'End Paidy window'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
