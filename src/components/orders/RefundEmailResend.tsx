import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, RotateCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { formatPHTDisplay } from '@/lib/date-utils';
import { emailStatusTone } from '@/components/orders/order-email-history';

/**
 * PA08 (owner decision 2026-10-09): the AUDITED MANUAL resend of a refund
 * email on a website cash order — admin only. Nothing is ever re-sent
 * automatically (owner rule; the card refund email's hourly retry is a
 * separate, Square-only exception). Each row shows the real delivery state
 * from the send log (sent / failed / suppressed / skipped / never attempted);
 * Resend needs a written reason, is capped at 3 per email, and is refused
 * while the address is suppressed. The resend-order-email edge function does
 * the work and writes the audit row before it sends.
 */
interface ResendableEmail {
  kind: 'refund_issued' | 'refund_received_paidy';
  key: string;
  amount: number;
  last_status: string | null;
  last_at: string | null;
  resends_used: number;
}

const MAX = 3;
const MIN_REASON = 10;
const KIND_LABEL: Record<ResendableEmail['kind'], string> = {
  refund_issued: 'Refund sent (返金が完了しました)',
  refund_received_paidy: 'Paidy refund received (返金を受け付けました)',
};
const REFUSAL: Record<string, string> = {
  reason_required: `Write a reason (at least ${MIN_REASON} characters).`,
  not_resendable: 'This email can no longer be resent from here.',
  recipient_suppressed: 'Her address is on the suppression list — a resend cannot reach her. Contact her another way.',
  resend_cap_reached: `This email was already resent ${MAX} times.`,
  admin_only: 'Only an admin can resend an email.',
};

async function errorCode(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown })?.context;
  try {
    if (ctx instanceof Response) return String((await ctx.clone().json())?.error ?? '');
  } catch { /* fall through */ }
  return (error as Error)?.message ?? 'error';
}

const yen = (n: number) => `¥${Math.round(n).toLocaleString('en-US')}`;

export default function RefundEmailResend({ orderId }: { orderId: string }) {
  const { roles } = useAuth();
  const isAdmin = roles.includes('admin');
  const qc = useQueryClient();
  const [target, setTarget] = useState<ResendableEmail | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const q = useQuery<ResendableEmail[]>({
    queryKey: ['refund-email-resend', orderId],
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('resend-order-email', { body: { cash_order_id: orderId, action: 'list' } });
      if (error) throw new Error(await errorCode(error));
      return ((data ?? {}) as { emails?: ResendableEmail[] }).emails ?? [];
    },
    staleTime: 30_000,
  });

  if (!isAdmin || !q.data || q.data.length === 0) return null;

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('resend-order-email', {
        body: { cash_order_id: orderId, action: 'resend', key: target.key, reason: reason.trim() },
      });
      if (error) {
        const code = await errorCode(error);
        toast.error(REFUSAL[code] ?? `Could not resend: ${code}`);
        return;
      }
      const d = (data ?? {}) as { sent?: boolean; reason?: string | null; attempt?: number };
      if (d.sent) toast.success(`Resent (attempt ${d.attempt} of ${MAX}). Logged in the audit trail.`);
      else toast.error(`Resend attempt ${d.attempt} was not delivered: ${String(d.reason ?? 'unknown').replace(/_/g, ' ')}. See the email history.`);
      setTarget(null);
      setReason('');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['refund-email-resend', orderId] }),
        qc.invalidateQueries({ queryKey: ['order-email-history', 'cash_order', orderId] }),
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="refund-email-resend">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Refund emails</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {q.isLoading && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>}
        <ul className="divide-y divide-border">
          {q.data.map((e) => (
            <li key={e.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="font-medium">{KIND_LABEL[e.kind]} · {yen(e.amount)}</p>
                <p className="text-xs text-muted-foreground">
                  {e.last_at ? `Last attempt ${formatPHTDisplay(e.last_at)} PHT` : 'Never attempted'} · manual resends {e.resends_used} of {MAX}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={emailStatusTone(e.last_status ?? 'none')}>{e.last_status ?? 'not attempted'}</Badge>
                <Button
                  size="sm" variant="outline"
                  disabled={e.resends_used >= MAX || e.last_status === 'suppressed'}
                  onClick={() => { setTarget(e); setReason(''); }}
                >
                  <RotateCw className="mr-1 h-3.5 w-3.5" /> Resend
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>

      <Dialog open={!!target} onOpenChange={(o) => { if (!o) setTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Resend {target ? KIND_LABEL[target.kind] : ''}</DialogTitle>
            <DialogDescription>
              One more attempt goes out to the customer and is written to the audit trail with your name and reason.
              {target?.last_status === 'sent' ? ' The send log already shows this email as SENT — resend only if she says she did not receive it.' : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="resend-reason">Reason (required)</Label>
            <Textarea id="resend-reason" value={reason} onChange={(ev) => setReason(ev.target.value)} rows={3} maxLength={500}
              placeholder="e.g. Customer says she did not receive the refund email (Messenger, 9 Oct)" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={busy}>Cancel</Button>
            <Button onClick={submit} disabled={busy || reason.trim().length < MIN_REASON}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null} Resend email
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
