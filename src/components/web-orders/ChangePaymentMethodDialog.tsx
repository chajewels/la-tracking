import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { WEB_METHOD_LABEL, type WebPaymentMethod } from '@/lib/web-payment-method';

/**
 * CHANGE PAYMENT METHOD (owner C1, 2026-10-05). The customer chooses transfer,
 * Paidy or card at checkout and it is locked for her; only staff change it,
 * here — e.g. Paidy declined → bank transfer or card. The change-payment-method
 * edge function does it (permission confirm_payment, a written reason,
 * audited) and refuses while any payment is in progress, Paidy/card on a
 * layaway, and Paidy/card on a peso order. On a confirmed order the customer is
 * emailed again, showing only the new method.
 */

const REFUSAL: Record<string, string> = {
  reason_required: 'Write the reason for the change.',
  payment_in_progress: 'A payment is in progress on this order (Paidy, a card hold or a submission waiting). Reject or confirm it first.',
  method_full_payment_only: 'A layaway is paid by bank transfer only.',
  method_requires_yen: 'Paidy and card are yen only — this order is in pesos.',
  unchanged: 'That is already the payment method.',
  not_open: 'This website order is no longer waiting for confirmation.',
  not_payable: 'This order is not waiting for payment.',
  not_web_order: 'Only website orders have a chosen payment method.',
  permission_denied: 'You do not have permission to change how an order is paid.',
};

async function errorCode(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown })?.context;
  try {
    if (ctx instanceof Response) return String((await ctx.clone().json())?.error ?? '');
  } catch { /* fall through */ }
  return (error as Error)?.message ?? 'error';
}

export function ChangePaymentMethodDialog({
  open, onOpenChange, entityType, entityId, current, layaway, peso, reference, onChanged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  entityType: 'draft' | 'cash_order';
  entityId: string;
  current: WebPaymentMethod;
  /** A layaway is transfer only (C2). */
  layaway: boolean;
  /** A peso order: Paidy and card are yen only (C6). */
  peso: boolean;
  reference: string;
  onChanged: () => void;
}) {
  const [method, setMethod] = useState<WebPaymentMethod>(current);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const disabledWhy = (m: WebPaymentMethod): string | null => {
    if (m === 'transfer') return null;
    if (layaway) return 'Layaway is bank transfer only';
    if (peso) return 'Yen only';
    return null;
  };

  async function save() {
    if (!reason.trim()) { toast.error(REFUSAL.reason_required); return; }
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('change-payment-method', {
        body: { entity_type: entityType, entity_id: entityId, method, reason: reason.trim() },
      });
      if (error) {
        const code = await errorCode(error);
        throw new Error(REFUSAL[code] ?? code);
      }
      const email = (data as { email?: { sent?: boolean } | null } | null)?.email;
      toast.success(`${reference}: payment method is now ${WEB_METHOD_LABEL[method]}${email?.sent ? ' — the customer was emailed' : ''}.`);
      if (email && !email.sent) toast.warning('The method changed, but the email to the customer was not sent. Tell her on Messenger.');
      setReason('');
      onOpenChange(false);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md" data-testid="change-payment-method-dialog">
        <DialogHeader>
          <DialogTitle>Change payment method</DialogTitle>
          <DialogDescription>
            The customer chose {WEB_METHOD_LABEL[current]} at checkout. Change it only when needed (for example Paidy was declined).
            The reason is kept in the audit log.
          </DialogDescription>
        </DialogHeader>
        <RadioGroup value={method} onValueChange={(v) => setMethod(v as WebPaymentMethod)} className="gap-2">
          {(['transfer', 'paidy', 'card'] as const).map((m) => {
            const why = disabledWhy(m);
            return (
              <label key={m} className={`flex items-center gap-3 rounded-lg border border-border p-3 text-sm ${why ? 'opacity-50' : 'cursor-pointer'}`}>
                <RadioGroupItem value={m} disabled={!!why} aria-label={WEB_METHOD_LABEL[m]} />
                <span className="flex-1 text-card-foreground">{WEB_METHOD_LABEL[m]}{m === current ? ' (current)' : ''}</span>
                {why && <span className="text-xs text-muted-foreground">{why}</span>}
              </label>
            );
          })}
        </RadioGroup>
        <div className="space-y-1">
          <Label htmlFor="method-reason">Reason</Label>
          <Textarea id="method-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Paidy declined — customer will pay by bank transfer" />
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy || method === current || !reason.trim()} onClick={save} data-testid="change-payment-method-save">
            {busy ? 'Saving…' : 'Change method'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
