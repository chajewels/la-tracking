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
import { useAuth } from '@/contexts/AuthContext';

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
 *
 * SQF06 (owner D-SQF06, 2026-10-08): when Square CANNOT refund — a refund row
 * FAILED / REJECTED, or the capture is older than 365 days — an ADMIN may record
 * the money going back outside Square: a bank transfer in yen to the customer's
 * own account (method bank_transfer_exception), or, only on the customer's
 * written request, a manual store-credit lot issued first through Settings →
 * Store Credit (store_credit_exception). Both need the Square Support ticket;
 * the amount is capped by the Hub at captured − completed refunds − credit
 * already issued on the order. The SQL (mark_web_order_refund_issued_atomic)
 * decides; this form only collects. docs/SQUARE.md "Card refund exception".
 */

const METHODS = [
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'paidy', label: 'Paidy (refunded in the Paidy dashboard)' },
  { value: 'card', label: 'Card (refunded in the Square Dashboard)' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
] as const;
/** SQF06: offered to admins only, and only while the exception is open (see cardException). */
const EXCEPTION_METHODS = [
  { value: 'bank_transfer_exception', label: 'Bank transfer (Square exception — Square could not refund)' },
  { value: 'store_credit_exception', label: 'Store credit (Square exception — on the customer\'s written request)' },
] as const;
export const REFUND_METHOD_LABEL: Record<string, string> = {
  bank_transfer: 'bank transfer', paidy: 'Paidy', card: 'card (Square)', cash: 'cash', other: 'other',
  bank_transfer_exception: 'bank transfer (Square exception)', store_credit_exception: 'store credit (Square exception)',
};

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
  // SQF06
  admin_only: 'Only an admin can record a refund made outside Square.',
  exception_not_triggered: 'The exception is not open: it needs a Square refund that FAILED or was REJECTED, or a card payment captured more than 365 days ago.',
  exception_evidence_required: 'The exception needs its evidence: the Square refund, the Square Support ticket number, the amount, and the transfer date + reference (or the customer\'s written request + the store-credit lot).',
  exception_over_cap: 'The amount is above what the Hub still owes on this card payment (captured − refunds Square completed − store credit already issued).',
  exception_nothing_owed: 'Nothing is owed on this card payment any more: Square refunds and store credit already cover what was captured.',
  exception_lot_mismatch: 'That store-credit lot does not fit: it must be this customer\'s, in yen, exactly the amount, and not already tied to an order.',
};

/** What the dialog needs to know about card money on the order (B01; SQF06 adds the exception facts). */
interface CardRefundFacts {
  paidByCard: boolean; cardPaid: number; refundedCompleted: number; refundedPending: number;
  /** SQF06: FAILED / REJECTED Square refunds on the order (each opens the exception). */
  failedRefunds: { id: string; status: string; amount: number }[];
  /** SQF06: a capture older than 365 days opens the exception too. */
  captureOver365: boolean;
  /** SQF06: store credit already issued on the order (part of the cap). */
  creditIssued: number;
}

const EXCEPTION_AGE_DAYS = 365;

async function loadCardRefundFacts(orderId: string): Promise<CardRefundFacts> {
  const [pays, refunds, captures, lots] = await Promise.all([
    supabase.from('cash_payments').select('amount_paid, payment_method').eq('cash_order_id', orderId).is('voided_at', null),
    supabase.from('square_refunds').select('square_refund_id, amount_jpy, status').eq('cash_order_id', orderId),
    supabase.from('square_payments').select('captured_at, status').eq('cash_order_id', orderId).eq('status', 'captured'),
    supabase.from('store_credit_lots').select('original_amount, status').eq('source_cash_order_id', orderId),
  ]);
  if (pays.error) throw pays.error;
  if (refunds.error) throw refunds.error;
  if (captures.error) throw captures.error;
  if (lots.error) throw lots.error;
  const card = (pays.data ?? []).filter((p) => p.payment_method === 'square');
  const rows = (refunds.data ?? []) as { square_refund_id: string; amount_jpy: number | string | null; status: string | null }[];
  const sum = (xs: { amount_jpy: number | string | null }[]) => xs.reduce((t, r) => t + Number(r.amount_jpy ?? 0), 0);
  const cutoff = Date.now() - EXCEPTION_AGE_DAYS * 24 * 60 * 60 * 1000;
  return {
    paidByCard: card.length > 0,
    cardPaid: card.reduce((t, p) => t + Number(p.amount_paid ?? 0), 0),
    refundedCompleted: sum(rows.filter((r) => r.status === 'COMPLETED')),
    refundedPending: sum(rows.filter((r) => r.status !== 'COMPLETED' && r.status !== 'FAILED' && r.status !== 'REJECTED')),
    failedRefunds: rows.filter((r) => r.status === 'FAILED' || r.status === 'REJECTED').map((r) => ({ id: r.square_refund_id, status: String(r.status), amount: Number(r.amount_jpy ?? 0) })),
    captureOver365: ((captures.data ?? []) as { captured_at: string | null }[]).some((c) => c.captured_at && Date.parse(c.captured_at) < cutoff),
    creditIssued: ((lots.data ?? []) as { original_amount: number | string | null; status: string | null }[])
      .filter((l) => l.status !== 'voided').reduce((t, l) => t + Number(l.original_amount ?? 0), 0),
  };
}

/** SQF06: the exception is open when Square itself cannot refund. Pure — the SQL is the authority. */
export function cardException(f: Pick<CardRefundFacts, 'paidByCard' | 'failedRefunds' | 'captureOver365'> | null | undefined): boolean {
  return !!f && f.paidByCard && (f.failedRefunds.length > 0 || f.captureOver365);
}
/** SQF06: what the Hub still owes on the card money (the SQL recomputes it; this is the figure shown). */
export function exceptionCap(f: Pick<CardRefundFacts, 'cardPaid' | 'refundedCompleted' | 'creditIssued'>): number {
  return Math.max(0, f.cardPaid - f.refundedCompleted - f.creditIssued);
}

const yen = (n: number) => `¥${Math.round(n).toLocaleString('en-US')}`;

async function errorCode(error: unknown): Promise<string> {
  const ctx = (error as { context?: unknown })?.context;
  try {
    if (ctx instanceof Response) return String((await ctx.clone().json())?.error ?? '');
  } catch { /* fall through */ }
  return (error as Error)?.message ?? 'error';
}

/**
 * SQF06 #6: how a cancelled web order's refund was recorded — "Refund issued by
 * bank transfer (Square exception) on 2026-10-08". The method and day live on the
 * refund_marked_issued audit row (readable by admin / finance); everyone else
 * sees "Refund issued".
 */
export function RefundIssuedLine({ orderId }: { orderId: string }) {
  const [detail, setDetail] = useState<{ method: string; refundedOn: string | null; amount: number | null } | null>(null);
  useEffect(() => {
    let live = true;
    supabase.from('audit_logs').select('new_value_json').eq('entity_type', 'cash_order').eq('entity_id', orderId)
      .eq('action', 'refund_marked_issued').order('created_at', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => {
        if (!live || !data) return;
        const v = (data.new_value_json ?? {}) as { method?: string; refunded_on?: string; amount?: number | string };
        if (v.method) setDetail({ method: String(v.method), refundedOn: v.refunded_on ? String(v.refunded_on) : null, amount: v.amount != null ? Number(v.amount) : null });
      });
    return () => { live = false; };
  }, [orderId]);
  return (
    <p className="mt-2 text-xs text-success" data-testid="refund-issued-line">
      Refund issued{detail ? ` by ${REFUND_METHOD_LABEL[detail.method] ?? detail.method}${detail.amount != null ? ` — ${yen(detail.amount)}` : ''}${detail.refundedOn ? ` on ${detail.refundedOn}` : ''}` : ''}.
    </p>
  );
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
  const { roles } = useAuth();
  const isAdmin = roles.includes('admin');
  // SQF06 evidence
  const [excRefundId, setExcRefundId] = useState<string>('');
  const [excTicket, setExcTicket] = useState('');
  const [excAmount, setExcAmount] = useState('');
  const [excTransferDate, setExcTransferDate] = useState<string>(getPHTToday());
  const [excTransferRef, setExcTransferRef] = useState('');
  const [excRequest, setExcRequest] = useState('');
  const [excLotId, setExcLotId] = useState('');

  useEffect(() => {
    if (!open) return;
    let live = true;
    setCard(null); setCardError(null);
    loadCardRefundFacts(orderId)
      .then((f) => {
        if (!live) return;
        setCard(f);
        if (f.paidByCard) setMethod('card');
        setExcRefundId(f.failedRefunds[0]?.id ?? '');
        setExcAmount(String(exceptionCap(f)));
      })
      .catch((e) => { if (live) setCardError((e as Error)?.message ?? 'Could not read the card payment.'); });
    return () => { live = false; };
  }, [open, orderId]);

  const cardOnly = card?.paidByCard === true;
  const exceptionOpen = isAdmin && cardException(card);
  const isException = method === 'bank_transfer_exception' || method === 'store_credit_exception';
  const cardBlocked = cardOnly && method === 'card' && (card?.refundedCompleted ?? 0) <= 0;
  const methods = cardOnly
    ? [...METHODS.filter((m) => m.value === 'card'), ...(exceptionOpen ? EXCEPTION_METHODS : [])]
    : METHODS;
  const cap = card ? exceptionCap(card) : 0;
  const exceptionIncomplete = isException && (
    !excTicket.trim() || !/^\d+$/.test(excAmount.trim()) || Number(excAmount) <= 0 || Number(excAmount) > cap
    || (method === 'bank_transfer_exception' && (!excTransferDate || !excTransferRef.trim()))
    || (method === 'store_credit_exception' && (!excRequest.trim() || !excLotId.trim()))
  );

  const submit = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('mark-refund-issued', {
        body: {
          cash_order_id: orderId, method, refunded_on: day, note: note.trim() || undefined,
          ...(isException ? {
            exception: {
              square_refund_id: excRefundId || undefined, square_support_ticket: excTicket.trim(), amount_jpy: excAmount.trim(),
              ...(method === 'bank_transfer_exception' ? { transfer_date: excTransferDate, transfer_reference: excTransferRef.trim() } : { customer_request: excRequest.trim(), store_credit_lot_id: excLotId.trim() }),
            },
          } : {}),
        },
      });
      if (error) {
        const code = await errorCode(error);
        toast.error(REFUSAL[code] ?? `Could not record the refund: ${code}`);
        return;
      }
      if ((data as { error?: string } | null)?.error) {
        const code = String((data as { error: string }).error);
        toast.error(REFUSAL[code] ?? `Could not record the refund: ${code}`);
        return;
      }
      const d = (data ?? {}) as { email_sent?: boolean; email_skipped?: string; already_recorded?: boolean; amount?: number | string; refund_emails?: { sent: number; total: number }; provider?: 'card' | 'paidy' };
      // SQF05: per-refund coverage — "2 of 2 refund emails sent" / "1 of 2 — the hourly check will retry".
      const cov = d.refund_emails && d.refund_emails.total > 1 ? ` (${d.refund_emails.sent} of ${d.refund_emails.total} refund emails sent)` : '';
      // PA08 (2026-10-09): name the provider the refund went through. A Paidy
      // refund email is never re-sent automatically (owner rule) — staff use
      // Resend in the order's email history; the card one has the hourly retry.
      const paidy = d.provider === 'paidy';
      const notConfirmed = paidy
        ? `${d.refund_emails && d.refund_emails.total > 1 ? `${d.refund_emails.sent} of ${d.refund_emails.total} Paidy refund emails are confirmed sent` : 'The Paidy refund email is not confirmed sent'} — use Resend in the order's email history if it should go out.`
        : `${d.refund_emails && d.refund_emails.total > 1 ? `${d.refund_emails.sent} of ${d.refund_emails.total} Square refund emails are confirmed sent` : 'The Square refund email is not confirmed sent yet'} — the hourly check will retry; see the order's email history.`;
      toast.success(d.already_recorded
        ? 'This refund was already recorded — nothing changed.'
        : d.email_skipped === 'provider_refund_already_emailed'
          ? `Refund of ${yen(Number(d.amount ?? 0))} recorded. ${paidy ? 'The Paidy' : "Square's"} refund email already told the customer${cov}.`
          : d.email_skipped === 'provider_refund_email_not_confirmed'
            ? `Refund of ${yen(Number(d.amount ?? 0))} recorded. ${notConfirmed}`
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
                : method === 'card' ? <p>The Hub records {yen(card.refundedCompleted)}, exactly what Square completed.</p> : null}
              {cardException(card) && !isAdmin && (
                <p className="mt-1">Square could not refund this payment ({card.failedRefunds.length > 0 ? `refund ${card.failedRefunds[0].status.toLowerCase()}` : 'captured over a year ago'}). An admin can record a refund made outside Square.</p>
              )}
            </div>
          )}
          {isException && card && (
            <div className="space-y-3 rounded-md border border-warning/60 bg-warning/5 p-3 text-xs">
              <p className="text-warning">
                Square exception (admin). Still owed on this card payment: <strong>{yen(cap)}</strong>
                {' '}= {yen(card.cardPaid)} captured − {yen(card.refundedCompleted)} Square refunded − {yen(card.creditIssued)} store credit issued. The Hub recomputes this; nothing above it is accepted.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="exc-refund">Why Square could not refund</Label>
                <select id="exc-refund" value={excRefundId} onChange={(e) => setExcRefundId(e.target.value)} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm">
                  {card.failedRefunds.map((r) => <option key={r.id} value={r.id}>Square refund {r.id} — {r.status} ({yen(r.amount)})</option>)}
                  {card.captureOver365 && <option value="">Card payment captured more than {EXCEPTION_AGE_DAYS} days ago</option>}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="exc-ticket">Square Support ticket number (required)</Label>
                <Input id="exc-ticket" value={excTicket} onChange={(e) => setExcTicket(e.target.value)} maxLength={80} className="bg-background border-border" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="exc-amount">Amount refunded (¥, whole yen, at most {yen(cap)})</Label>
                <Input id="exc-amount" inputMode="numeric" value={excAmount} onChange={(e) => setExcAmount(e.target.value)} className="bg-background border-border" />
              </div>
              {method === 'bank_transfer_exception' ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="exc-tdate">Bank transfer date (to the customer's own account, in yen)</Label>
                    <Input id="exc-tdate" type="date" value={excTransferDate} max={getPHTToday()} onChange={(e) => setExcTransferDate(e.target.value)} className="bg-background border-border" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="exc-tref">Transfer reference (bank, slip or transaction number)</Label>
                    <Input id="exc-tref" value={excTransferRef} onChange={(e) => setExcTransferRef(e.target.value)} maxLength={120} className="bg-background border-border" />
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="exc-req">The customer's written request (where and when she asked for store credit)</Label>
                    <Input id="exc-req" value={excRequest} onChange={(e) => setExcRequest(e.target.value)} maxLength={200} className="bg-background border-border" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="exc-lot">Store-credit lot id (issue the manual lot first in Settings → Store Credit; it must be hers, in yen, exactly this amount)</Label>
                    <Input id="exc-lot" value={excLotId} onChange={(e) => setExcLotId(e.target.value)} placeholder="uuid" className="bg-background border-border font-mono text-xs" />
                  </div>
                </>
              )}
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
          <Button onClick={submit} disabled={busy || !day || card === null && !cardError || cardBlocked || exceptionIncomplete}>{busy ? 'Saving…' : 'Mark refund issued'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
