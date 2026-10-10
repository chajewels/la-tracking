import { useCallback, useEffect, useState } from 'react';
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
 * FAILED / REJECTED, or the payment was authorised over one calendar year ago — an ADMIN may record
 * the money going back outside Square: a bank transfer in yen to the customer's
 * own account (method bank_transfer_exception), or, only on the customer's
 * written request, a manual store-credit lot issued first through Settings →
 * Store Credit (store_credit_exception). Both need the Square Support ticket;
 * the amount is capped by the Hub at captured − completed refunds − credit
 * already issued on the order. The SQL (mark_web_order_refund_issued_atomic)
 * decides; this form only collects. docs/SQUARE.md "Card refund exception".
 *
 * SQV02–SQV04 (owner D-SQV03 / D-SQV04, 2026-10-09): APPROVE FIRST, THEN PAY.
 * Step 1 (admin): the Hub re-reads every Square refund of the order from Square,
 * then approves an amount (≤ the cap) and a payout — refused while any Square
 * refund is still processing. Step 2: after the transfer / the lot, the refund
 * is recorded against that approval (amount = the approved amount). The age
 * trigger is the original payment's authorisation more than one calendar year
 * ago (Square facts only). An approval can be cancelled (with a reason) until it
 * is recorded. If the card facts cannot be read, nothing can be submitted.
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
  not_refund_pending: 'This order is not waiting for a refund, or that part is already recorded. On an order paid partly by card and partly another way, each part is recorded once.',
  not_web_order: 'Only website orders use this.',
  bad_method: 'Choose how the refund was sent.',
  bad_date: 'Enter the day the refund was sent (not a future day).',
  not_found: 'Order not found.',
  method_mismatch: 'The method does not match how she paid. A card payment is refunded in Square and recorded as Card; a Paidy payment is refunded in the Paidy dashboard and recorded as Paidy.',
  no_completed_card_refund: 'Square does not show a completed refund for this order yet. Refund it in the Square Dashboard first; a pending refund is not enough.',
  // L2 (Paidy QC 2026-10-10): the server refuses while Paidy has refunded less than the Paidy money.
  paidy_refund_incomplete: 'Paidy has not refunded all of the Paidy money yet. Refund the rest in the Paidy dashboard, then mark it.',
  // PA03 (2026-10-08): only a Paidy refund the Hub has read back counts.
  no_verified_paidy_refund: 'The Hub has not recorded a Paidy refund for this order yet. Refund it in the Paidy merchant dashboard first; the hourly check records it, then mark it here. The amount recorded is what Paidy refunded, never the full receipt.',
  // SQF06
  admin_only: 'Only an admin can approve or record a refund made outside Square.',
  exception_not_triggered: 'The exception is not open: it needs a Square refund that FAILED or was REJECTED, or a card payment authorised more than one year ago.',
  exception_evidence_required: 'The exception needs its evidence: the Square Support ticket number and the amount (to approve); the transfer date + reference, or the customer\'s written request + the store-credit lot (to record).',
  exception_over_cap: 'The amount is above what the Hub still owes on this card payment (captured − refunds Square completed − store credit already issued).',
  exception_nothing_owed: 'Nothing is owed on this card payment any more: Square refunds and store credit already cover what was captured.',
  exception_lot_mismatch: 'That store-credit lot does not fit the approval.',
  // SQV02/SQV03
  exception_exists: 'This order already has an approval. Record against it, or cancel it first.',
  exception_refund_in_progress: 'A Square refund on this order is still processing. Wait until Square shows it COMPLETED, FAILED or REJECTED.',
  exception_not_approved: 'Approve the exception first (step 1), then pay and record it.',
  exception_payout_mismatch: 'The approval was for the other payout. Record it the way it was approved, or cancel the approval and approve again.',
  exception_superseded: 'Square or store credit has changed what is owed since the approval. Cancel the approval and approve again.',
  bad_payout: 'Choose bank transfer or store credit.',
  reason_required: 'Write why the approval is cancelled.',
  no_approval: 'There is no open approval on this order.',
  already_recorded: 'This approval is already recorded and cannot be cancelled.',
  square_unreachable: 'Square could not be read just now, so nothing was approved. Try again in a minute.',
  refund_not_recorded: 'A Square refund on this order could not be recorded in the Hub, so nothing was approved. Check the bell, then try again.',
  hub_read_failed: 'The Hub could not read this order\'s card payments, so nothing was approved. Try again.',
  // QC close-out (2026-10-09)
  exception_approved_pending: 'A refund outside Square is approved on this order. Record it (bank transfer / store credit), or cancel the approval first.',
};
const LOT_DETAIL: Record<string, string> = {
  lot_not_found: 'no lot with that id', lot_not_this_customer: 'the lot belongs to another customer', lot_not_jpy: 'the lot is not in yen',
  lot_not_active: 'the lot is not active', lot_expired: 'the lot has expired', lot_already_spent: 'part of the lot is already spent',
  lot_tied_to_an_order: 'the lot is already tied to an order', lot_issued_before_approval: 'the lot was issued before the approval — issue a new one',
  lot_amount_differs: 'the lot amount differs from the approved amount', lot_already_allocated: 'the lot is already used for another refund',
};

/** SQV02/SQV03: an approved, not yet recorded exception on the order. */
export interface ExceptionApproval {
  id: string; payout: 'bank_transfer' | 'store_credit'; amount: number; cap: number;
  trigger: string; squareRefundId: string | null; ticket: string; approvedAt: string; note: string | null;
}

/** What the dialog needs to know about card money on the order (B01; SQF06 adds the exception facts). */
interface CardRefundFacts {
  paidByCard: boolean; cardPaid: number; refundedCompleted: number; refundedPending: number;
  /** SQF06: FAILED / REJECTED Square refunds on the order (each opens the exception). */
  failedRefunds: { id: string; status: string; amount: number }[];
  /** SQV04: the ORIGINAL payment was authorised more than one calendar year ago (Square facts only). */
  authorizedOverOneYear: boolean;
  /** SQF06: store credit already issued on the order (part of the cap). */
  creditIssued: number;
  /** F-17 (QC 2026-10-09): card money Square captured — the cap's base, as in the SQL. */
  cardCaptured: number;
  /** F-02: money a chargeback holds or took back (EVIDENCE_REQUIRED / PROCESSING / LOST / ACCEPTED). */
  disputed: number;
  /** F-03 / L6: what mark_web_order_refund_issued_atomic can record for "card" — COMPLETED refunds of captures recorded on the order, capped per payment at the money RECORDED. */
  cardRecordable: number;
  /** L6: the refund parts as the SQL sees them (web_order_refund_parts). */
  parts: RefundParts;
  /** SQV03: the open approval, if any. */
  approval: ExceptionApproval | null;
}

/** SQV04: one calendar year before `now` — the same rule as the SQL's `now() - interval '1 year'`. */
export function oneYearBefore(now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d;
}
export function authorizedOverOneYear(authorizedAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!authorizedAt) return false;
  const t = Date.parse(authorizedAt);
  return Number.isFinite(t) && t < oneYearBefore(now).getTime();
}

/** L6: one "Mark refund issued" already recorded on the order. */
export interface RefundMark { method: string; amount: number | null; refundedOn: string | null }

/**
 * L6 (2026-10-09): the refund parts of a cancelled web order, from the SQL
 * (web_order_refund_parts — staff with cancel_cash_order; the audit table
 * itself is admin / finance only). The SQL is the authority on which part is
 * still open; this page only offers what it says.
 */
export interface RefundParts {
  marks: RefundMark[];
  cardOpen: boolean;
  nonCardOpen: boolean;
  cardMarked: number;
  nonCard: number;
  paidy: number;
}
export function refundPartsFrom(raw: unknown): RefundParts {
  const r = (raw ?? {}) as Record<string, unknown>;
  const marks = Array.isArray(r.marks) ? (r.marks as Record<string, unknown>[]) : [];
  return {
    marks: marks.map((m) => ({ method: String(m.method ?? ''), amount: m.amount != null ? Number(m.amount) : null, refundedOn: m.refunded_on ? String(m.refunded_on) : null }))
      .filter((m) => m.method),
    cardOpen: r.card_open === true,
    nonCardOpen: r.non_card_open === true,
    cardMarked: Number(r.card_marked_jpy ?? 0),
    nonCard: Number(r.non_card_jpy ?? 0),
    paidy: Number(r.paidy_jpy ?? 0),
  };
}
async function loadRefundParts(orderId: string): Promise<RefundParts> {
  // web_order_refund_parts is not in the generated types until Lovable's next push.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase.rpc as any)('web_order_refund_parts', { p_order_id: orderId });
  if (error) throw error;
  return refundPartsFrom(data);
}

const NON_CARD_ORDER = ['bank_transfer', 'paidy', 'cash', 'other'] as const;

/**
 * L6: which methods the dialog offers, and which one it starts on. Pure.
 *   - an approval open → only its exception method;
 *   - no card money → every ordinary method (bank transfer first);
 *   - card money, nothing marked yet → card, the non-card methods on a mixed
 *     order, and the exception methods when the exception is open (admin);
 *   - card money, already marked once → only the part the SQL says is open:
 *     card (a later completed Square refund) and/or the non-card part —
 *     never an exception method on a further mark.
 * The non-card part of an order whose non-card money is all Paidy is recorded
 * as Paidy only (refunded in the Paidy dashboard) — never a bank-transfer default.
 */
export function refundMethodChoice(i: {
  paidByCard: boolean;
  approvalPayout: 'bank_transfer' | 'store_credit' | null;
  exceptionOpen: boolean;
  parts: RefundParts;
}): { methods: string[]; initial: string } {
  if (i.approvalPayout) return { methods: [`${i.approvalPayout}_exception`], initial: `${i.approvalPayout}_exception` };
  const p = i.parts;
  // L1 (Paidy QC 2026-10-10): an order paid only by Paidy is refunded in the
  // Paidy dashboard and recorded as Paidy — the SQL refuses anything else
  // (method_mismatch / paid_by_paidy), so nothing else is offered.
  if (!i.paidByCard) {
    if (p.nonCard > 0 && p.paidy >= p.nonCard - 0.005) return { methods: ['paidy'], initial: 'paidy' };
    return { methods: ['bank_transfer', 'paidy', 'card', 'cash', 'other'], initial: 'bank_transfer' };
  }
  const nonCard: string[] = p.nonCard <= 0 ? []
    : p.paidy >= p.nonCard - 0.005 ? ['paidy']
      : NON_CARD_ORDER.filter((m) => m !== 'paidy' || p.paidy > 0);
  if (p.marks.length === 0) {
    const methods = ['card', ...nonCard, ...(i.exceptionOpen ? ['bank_transfer_exception', 'store_credit_exception'] : [])];
    return { methods, initial: 'card' };
  }
  const methods = [...(p.cardOpen ? ['card'] : []), ...(p.nonCardOpen ? nonCard : [])];
  return { methods, initial: methods[0] ?? 'card' };
}

async function loadCardRefundFacts(orderId: string): Promise<CardRefundFacts> {
  const [pays, refunds, captures, lots, approvals, disputes, cardRows, parts] = await Promise.all([
    supabase.from('cash_payments').select('id, amount_paid, payment_method, reference_number').eq('cash_order_id', orderId).is('voided_at', null),
    supabase.from('square_refunds').select('square_refund_id, amount_jpy, status, square_payment_row').eq('cash_order_id', orderId),
    supabase.from('square_payments').select('authorized_at, status, amount_jpy').eq('cash_order_id', orderId).eq('status', 'captured'),
    supabase.from('store_credit_lots').select('original_amount, status').eq('source_cash_order_id', orderId),
    // card_refund_exceptions is not in the generated types until Lovable's next push.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase.from as any)('card_refund_exceptions')
      .select('id, payout, amount_jpy, cap_jpy, trigger_kind, square_refund_id, square_support_ticket, approved_at, approval_note')
      .eq('cash_order_id', orderId).eq('status', 'approved').maybeSingle(),
    supabase.from('square_disputes').select('amount_jpy, state, square_payment_row').eq('cash_order_id', orderId),
    supabase.from('square_payments').select('id, amount_jpy, captured_amount_jpy, cash_payment_id').eq('cash_order_id', orderId),
    loadRefundParts(orderId),
  ]);
  if (pays.error) throw pays.error;
  if (refunds.error) throw refunds.error;
  if (captures.error) throw captures.error;
  if (lots.error) throw lots.error;
  if (approvals.error) throw approvals.error;
  if (disputes.error) throw disputes.error;
  if (cardRows.error) throw cardRows.error;
  const sqRows = (cardRows.data ?? []) as { id: string; amount_jpy: number | string | null; captured_amount_jpy: number | string | null; cash_payment_id: string | null }[];
  const sqById = new Map(sqRows.map((r) => [r.id, r]));
  const payRows = (pays.data ?? []) as { id: string; amount_paid: number | string | null; payment_method: string | null; reference_number: string | null }[];
  const card = payRows.filter((p) => p.payment_method === 'square');
  const recordedById = new Map(card.map((p) => [p.id, Number(p.amount_paid ?? 0)]));
  const rows = (refunds.data ?? []) as { square_refund_id: string; amount_jpy: number | string | null; status: string | null; square_payment_row: string | null }[];
  const sum = (xs: { amount_jpy: number | string | null }[]) => xs.reduce((t, r) => t + Number(r.amount_jpy ?? 0), 0);
  const a = approvals.data as null | { id: string; payout: string; amount_jpy: number | string; cap_jpy: number | string; trigger_kind: string; square_refund_id: string | null; square_support_ticket: string; approved_at: string; approval_note: string | null };
  return {
    paidByCard: card.length > 0,
    cardPaid: card.reduce((t, p) => t + Number(p.amount_paid ?? 0), 0),
    refundedCompleted: sum(rows.filter((r) => r.status === 'COMPLETED')),
    refundedPending: sum(rows.filter((r) => r.status !== 'COMPLETED' && r.status !== 'FAILED' && r.status !== 'REJECTED')),
    failedRefunds: rows.filter((r) => r.status === 'FAILED' || r.status === 'REJECTED').map((r) => ({ id: r.square_refund_id, status: String(r.status), amount: Number(r.amount_jpy ?? 0) })),
    authorizedOverOneYear: ((captures.data ?? []) as { authorized_at: string | null }[]).some((c) => authorizedOverOneYear(c.authorized_at)),
    cardCaptured: ((captures.data ?? []) as { amount_jpy: number | string | null }[]).reduce((t, c) => t + Math.round(Number(c.amount_jpy ?? 0)), 0),
    // As square_order_disputed_jpy: a dispute without its own amount counts the whole payment.
    disputed: ((disputes.data ?? []) as { amount_jpy: number | string | null; state: string | null; square_payment_row: string | null }[])
      .filter((d) => DISPUTE_MONEY_STATES.has(String(d.state ?? '').toUpperCase()))
      .reduce((t, d) => t + (d.amount_jpy != null ? Number(d.amount_jpy)
        : Math.round(Number(sqById.get(d.square_payment_row ?? '')?.amount_jpy ?? 0))), 0),
    cardRecordable: cardRecordable(rows, sqById, recordedById),
    parts,
    creditIssued: ((lots.data ?? []) as { original_amount: number | string | null; status: string | null }[])
      .filter((l) => l.status !== 'voided').reduce((t, l) => t + Number(l.original_amount ?? 0), 0),
    approval: a ? {
      id: a.id, payout: a.payout === 'store_credit' ? 'store_credit' : 'bank_transfer', amount: Number(a.amount_jpy), cap: Number(a.cap_jpy),
      trigger: a.trigger_kind, squareRefundId: a.square_refund_id, ticket: a.square_support_ticket, approvedAt: a.approved_at, note: a.approval_note,
    } : null,
  };
}


/** SQF06/SQV04: the exception is open when Square itself cannot refund. Pure — the SQL is the authority. */
export function cardException(f: Pick<CardRefundFacts, 'paidByCard' | 'failedRefunds' | 'authorizedOverOneYear'> | null | undefined): boolean {
  return !!f && f.paidByCard && (f.failedRefunds.length > 0 || f.authorizedOverOneYear);
}
/**
 * F-03 / L6 mirror of square_order_card_refund_recordable_jpy (the SQL figure
 * mark_web_order_refund_issued_atomic records for "card"): per card payment
 * RECORDED on the order, the COMPLETED refunds less what Square refunded before
 * the Hub recorded it (captured − recorded), capped at the recorded money.
 * `recorded` maps cash_payment_id → amount recorded (non-voided rows only);
 * without it the recorded money is taken to equal the capture.
 */
export function cardRecordable(
  refunds: { amount_jpy: number | string | null; status: string | null; square_payment_row: string | null }[],
  payments: Map<string, { amount_jpy: number | string | null; captured_amount_jpy: number | string | null; cash_payment_id: string | null }>,
  recorded?: Map<string, number>,
): number {
  const done = new Map<string, number>();
  for (const r of refunds) {
    const p = r.square_payment_row ? payments.get(r.square_payment_row) : undefined;
    if (r.status !== 'COMPLETED' || !p || !p.cash_payment_id) continue;
    if (recorded && !recorded.has(p.cash_payment_id)) continue;
    done.set(r.square_payment_row as string, (done.get(r.square_payment_row as string) ?? 0) + Number(r.amount_jpy ?? 0));
  }
  let total = 0;
  for (const [id, d] of done) {
    const p = payments.get(id)!;
    const captured = p.captured_amount_jpy != null ? Number(p.captured_amount_jpy) : Math.round(Number(p.amount_jpy ?? 0));
    const rec = recorded ? Number(recorded.get(p.cash_payment_id as string) ?? 0) : captured;
    total += Math.min(rec, Math.max(0, d - (captured - rec)));
  }
  return total;
}

/** F-02: dispute states in which the card network holds or took back the money (as square_order_disputed_jpy). */
export const DISPUTE_MONEY_STATES = new Set(['EVIDENCE_REQUIRED', 'PROCESSING', 'LOST', 'ACCEPTED']);

/**
 * SQF06 / F-17 / F-02: what the Hub still owes on the card money — the SAME base
 * as the SQL: card money Square captured − COMPLETED Square refunds − store
 * credit issued − chargeback money. The SQL recomputes it; this is the figure shown.
 */
export function exceptionCap(f: Pick<CardRefundFacts, 'cardCaptured' | 'refundedCompleted' | 'creditIssued'> & { disputed?: number }): number {
  return Math.max(0, f.cardCaptured - f.refundedCompleted - f.creditIssued - (f.disputed ?? 0));
}

/** A timestamp's Philippine day (YYYY-MM-DD), the day boundary the SQL uses. */
export function phtDay(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(iso));
}

const yen = (n: number) => `¥${Math.round(n).toLocaleString('en-US')}`;

/** The edge's refusal body (error code + optional detail / cap), whether it came back as an error or as data. */
export interface Refusal {
  code: string; detail?: string | null; cap?: number | null;
  /** L2: paidy_refund_incomplete carries Paidy's money and what Paidy has refunded (verified). */
  paidyPaid?: number | null; paidyRefunded?: number | null;
}
function refusalFromBody(j: Record<string, unknown> | null | undefined, fallback: string): Refusal {
  const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    code: String(j?.error ?? fallback), detail: (j?.detail as string | undefined) ?? null, cap: num(j?.cap_jpy),
    paidyPaid: num(j?.paidy_paid_jpy), paidyRefunded: num(j?.paidy_refunded_jpy),
  };
}
async function refusalOf(error: unknown, data: unknown): Promise<Refusal | null> {
  if (error) {
    const ctx = (error as { context?: unknown })?.context;
    try {
      if (ctx instanceof Response) {
        const j = await ctx.clone().json();
        return refusalFromBody(j, 'error');
      }
    } catch { /* fall through */ }
    return { code: (error as Error)?.message ?? 'error' };
  }
  const d = data as Record<string, unknown> | null;
  return d?.error ? refusalFromBody(d, 'error') : null;
}
export function refusalText(r: Refusal): string {
  if (r.code === 'paidy_refund_incomplete' && r.paidyPaid != null && r.paidyRefunded != null) {
    return `Paidy has refunded ${yen(r.paidyRefunded)} of ${yen(r.paidyPaid)}. Refund the rest in the Paidy dashboard, then mark it.`;
  }
  const base = REFUSAL[r.code] ?? `Refused: ${r.code}`;
  const lot = r.detail && LOT_DETAIL[r.detail] ? ` (${LOT_DETAIL[r.detail]})` : '';
  const cap = r.code === 'exception_over_cap' && r.cap != null ? ` The Hub says at most ${yen(Number(r.cap))}.` : '';
  return base + lot + cap;
}

/**
 * SQF06 #6: how a cancelled web order's refund was recorded — "Refund issued by
 * bank transfer (Square exception) on 2026-10-08". The method and day live on the
 * refund_marked_issued audit row (readable by admin / finance); everyone else
 * sees "Refund issued".
 */
export function RefundIssuedLine({ orderId, onRecordAnother }: { orderId: string; onRecordAnother?: () => void }) {
  const [marks, setMarks] = useState<RefundMark[]>([]);
  const [another, setAnother] = useState(false);
  useEffect(() => {
    let live = true;
    // L6: the marks and the open parts come from the SQL (web_order_refund_parts,
    // staff with cancel_cash_order). "Record the other part" only when it says a
    // part is open; anyone else sees "Refund issued." without the detail.
    loadRefundParts(orderId)
      .then((p) => { if (live) { setMarks(p.marks); setAnother(p.cardOpen || p.nonCardOpen); } })
      .catch(() => { if (live) { setMarks([]); setAnother(false); } });
    return () => { live = false; };
  }, [orderId, onRecordAnother]);
  const part = (m: RefundMark) => `${REFUND_METHOD_LABEL[m.method] ?? m.method}${m.amount != null ? ` — ${yen(m.amount)}` : ''}${m.refundedOn ? ` on ${m.refundedOn}` : ''}`;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <p className="text-xs text-success" data-testid="refund-issued-line">
        Refund issued{marks.length > 0 ? ` by ${marks.map(part).join('; then by ')}` : ''}.
      </p>
      {another && onRecordAnother && (
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onRecordAnother} data-testid="refund-record-another">
          Record the other part
        </Button>
      )}
    </div>
  );
}

/** Shown only for a cancelled web order whose refund decision is still pending. */
export function canMarkRefundIssued(o: { source_channel?: string | null; status?: string | null; refund_status?: string | null } | null | undefined): boolean {
  return !!o && o.source_channel === 'web' && o.status === 'cancelled' && o.refund_status === 'refund_pending';
}

/**
 * L6 (2026-10-09): a cancelled web order already marked refunded may take ONE
 * more mark per part (the card part, or the part paid another way) — the
 * button itself appears only when web_order_refund_parts says a part is open.
 */
export function canMarkFurtherRefund(o: { source_channel?: string | null; status?: string | null; refund_status?: string | null } | null | undefined): boolean {
  return !!o && o.source_channel === 'web' && o.status === 'cancelled' && o.refund_status === 'refund_issued';
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
  // Step 1 (approve)
  const [excRefundId, setExcRefundId] = useState<string>('');
  const [excTicket, setExcTicket] = useState('');
  const [excAmount, setExcAmount] = useState('');
  const [excNote, setExcNote] = useState('');
  // Step 2 (record)
  const [excTransferDate, setExcTransferDate] = useState<string>(getPHTToday());
  const [excTransferRef, setExcTransferRef] = useState('');
  const [excRequest, setExcRequest] = useState('');
  const [excLotId, setExcLotId] = useState('');
  // Cancel approval
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const reload = useCallback(() => {
    let live = true;
    setCard(null); setCardError(null);
    loadCardRefundFacts(orderId)
      .then((f) => {
        if (!live) return;
        setCard(f);
        // L6: start on the part the SQL says is open (Paidy-only non-card money starts on Paidy).
        setMethod(refundMethodChoice({ paidByCard: f.paidByCard, approvalPayout: f.approval?.payout ?? null, exceptionOpen: false, parts: f.parts }).initial);
        setExcRefundId(f.failedRefunds[0]?.id ?? '');
        setExcAmount(String(exceptionCap(f)));
      })
      .catch((e) => { if (live) setCardError((e as Error)?.message ?? 'Could not read the card payment.'); });
    return () => { live = false; };
  }, [orderId]);

  useEffect(() => {
    if (!open) return;
    setCancelling(false); setCancelReason('');
    return reload();
  }, [open, reload]);

  const approval = card?.approval ?? null;
  const cardOnly = card?.paidByCard === true;
  // L6 (2026-10-09): paid partly by card and partly another way — each part is
  // recorded with its own method, once (the card part as Square completed it).
  const mixed = cardOnly && (card?.parts.nonCard ?? 0) > 0;
  const cardMarked = card?.parts.cardMarked ?? 0;
  const cardStillRecordable = Math.max(0, (card?.cardRecordable ?? 0) - cardMarked);
  const exceptionOpen = isAdmin && (cardException(card) || !!approval);
  const isException = method === 'bank_transfer_exception' || method === 'store_credit_exception';
  const payout = method === 'store_credit_exception' ? 'store_credit' : 'bank_transfer';
  const cardBlocked = cardOnly && method === 'card' && cardStillRecordable <= 0;
  const ALL_METHODS: readonly { value: string; label: string }[] = [...METHODS, ...EXCEPTION_METHODS];
  const methods = card
    ? refundMethodChoice({ paidByCard: card.paidByCard, approvalPayout: approval?.payout ?? null, exceptionOpen, parts: card.parts }).methods
        .map((v) => ALL_METHODS.find((m) => m.value === v)).filter((m): m is { value: string; label: string } => !!m)
    : METHODS;
  const cap = card ? exceptionCap(card) : 0;
  /** Step 1 is shown for an exception method with no approval yet; step 2 once approved. */
  const step: 'approve' | 'record' | null = isException ? (approval ? 'record' : 'approve') : null;
  const refundProcessing = (card?.refundedPending ?? 0) > 0;
  const approveIncomplete = step === 'approve' && (
    !excTicket.trim() || !/^\d+$/.test(excAmount.trim()) || Number(excAmount) <= 0 || Number(excAmount) > cap || refundProcessing
  );
  // The SQL compares the transfer date with the approval's PHT day.
  const approvalDay = approval ? phtDay(approval.approvedAt) : '';
  const recordIncomplete = step === 'record' && (
    (payout === 'bank_transfer' && (!excTransferDate || !excTransferRef.trim() || excTransferDate < approvalDay))
    || (payout === 'store_credit' && (!excRequest.trim() || !excLotId.trim()))
  );
  // Fail closed: if the card facts could not be read (or are still loading), nothing is submitted.
  const factsMissing = cardError !== null || card === null;

  const approve = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('mark-refund-issued', {
        body: {
          cash_order_id: orderId, action: 'approve', payout,
          square_refund_id: excRefundId || undefined, square_support_ticket: excTicket.trim(),
          amount_jpy: Number(excAmount.trim()), note: excNote.trim() || undefined,
        },
      });
      const refused = await refusalOf(error, data);
      if (refused) { toast.error(refusalText(refused)); reload(); return; }
      toast.success(`Approved: ${yen(Number(excAmount))} by ${payout === 'bank_transfer' ? 'bank transfer' : 'store credit'}. Now make the ${payout === 'bank_transfer' ? 'transfer' : 'store-credit lot'}, then record it here.`);
      reload();
    } finally {
      setBusy(false);
    }
  };

  const cancelApproval = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('mark-refund-issued', {
        body: { cash_order_id: orderId, action: 'cancel_approval', reason: cancelReason.trim() },
      });
      const refused = await refusalOf(error, data);
      if (refused) { toast.error(refusalText(refused)); return; }
      toast.success('Approval cancelled. Nothing was paid or recorded.');
      setCancelling(false); setCancelReason('');
      reload();
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('mark-refund-issued', {
        body: {
          cash_order_id: orderId, method, refunded_on: payout === 'bank_transfer' && step === 'record' ? excTransferDate : day,
          note: note.trim() || undefined,
          ...(step === 'record' ? {
            exception: payout === 'bank_transfer'
              ? { transfer_date: excTransferDate, transfer_reference: excTransferRef.trim() }
              : { customer_request: excRequest.trim(), store_credit_lot_id: excLotId.trim() },
          } : {}),
        },
      });
      const refused = await refusalOf(error, data);
      if (refused) { toast.error(refusalText(refused)); return; }
      const d = (data ?? {}) as { email_sent?: boolean; email_skipped?: string; already_recorded?: boolean; amount?: number | string; refund_emails?: { sent: number; total: number }; provider?: 'card' | 'paidy'; refund_email_sentence?: string; paidy_remaining_jpy?: number | string | null };
      const amount = yen(Number(d.amount ?? 0));
      // L2: never let a partly refunded Paidy payment pass silently.
      const paidyRemaining = Number(d.paidy_remaining_jpy ?? 0);
      if (Number.isFinite(paidyRemaining) && paidyRemaining > 0) {
        toast.warning(`${yen(paidyRemaining)} of the Paidy money has not been refunded by Paidy. Refund it in the Paidy dashboard.`);
      }
      // SQV06: a card answer carries the one truthful sentence about the Square refund emails.
      // PA08 (2026-10-09): a Paidy refund email is never re-sent automatically (owner rule) —
      // staff use Resend in the order's email history.
      const paidy = d.provider === 'paidy';
      const cov = d.refund_emails && d.refund_emails.total > 1 ? ` (${d.refund_emails.sent} of ${d.refund_emails.total} refund emails sent)` : '';
      const paidyNotConfirmed = `${d.refund_emails && d.refund_emails.total > 1 ? `${d.refund_emails.sent} of ${d.refund_emails.total} Paidy refund emails are confirmed sent` : 'The Paidy refund email is not confirmed sent'} — use Resend in the order's email history if it should go out.`;
      toast.success(d.already_recorded
        ? 'This refund was already recorded — nothing changed.'
        : d.refund_email_sentence
          ? `Refund of ${amount} recorded. ${d.refund_email_sentence}`
          : d.email_skipped === 'provider_refund_already_emailed'
            ? `Refund of ${amount} recorded. ${paidy ? 'The Paidy' : "The provider's"} refund email already told the customer${cov}.`
            : d.email_skipped === 'provider_refund_email_not_confirmed' && paidy
              ? `Refund of ${amount} recorded. ${paidyNotConfirmed}`
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
      <DialogContent className="flex max-h-[90vh] max-w-md flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-6 pb-3 pt-6">
          <DialogTitle className="pr-6">Mark refund issued — {reference}</DialogTitle>
          <DialogDescription>
            Send the refund first. This records it on the order and emails the customer that her refund is complete.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {card === null && !cardError && <p className="text-xs text-muted-foreground">Reading the payment…</p>}
          {cardError && (
            <div className="rounded-md border border-destructive/60 bg-destructive/5 p-2.5 text-xs text-destructive" data-testid="refund-facts-error">
              <p>Could not read this order's card payments: {cardError}</p>
              <p>Nothing can be recorded until it reads. <button type="button" className="underline" onClick={() => reload()}>Try again</button></p>
            </div>
          )}
          {!factsMissing && (
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
          )}
          {/* L2 (Paidy QC 2026-10-10): the Paidy money before submit. The Hub records only
              what Paidy has refunded (verified) and refuses while that is less. */}
          {card && method === 'paidy' && card.parts.paidy > 0 && (
            <div className="rounded-md border border-border bg-background p-2.5 text-xs text-muted-foreground" data-testid="refund-paidy-figures">
              <p>Paid with Paidy: <strong className="text-card-foreground">{yen(card.parts.paidy)}</strong>. The Hub records what Paidy has refunded (read back from Paidy), and refuses until Paidy has refunded all of it — refund it in full in the Paidy dashboard first.</p>
            </div>
          )}
          {cardOnly && card && (
            <div className={`rounded-md border p-2.5 text-xs ${cardBlocked ? 'border-warning/60 bg-warning/5 text-warning' : 'border-border bg-background text-muted-foreground'}`}>
              <p>Paid by card: {yen(card.cardPaid)}. Square shows <strong className="text-card-foreground">{yen(card.refundedCompleted)}</strong> refunded (completed).</p>
              {mixed && (
                <p data-testid="refund-mixed-note">Also paid another way: {yen(card.parts.nonCard)}{card.parts.paidy > 0 ? ` (Paidy ${yen(card.parts.paidy)} — refunded in the Paidy dashboard)` : ''}. Record each part with its own method — the card part as Square completed it, the other part as it was sent. Each part is recorded once.</p>
              )}
              {refundProcessing && <p>Still processing in Square: {yen(card.refundedPending)} (not counted until it completes).</p>}
              {cardBlocked
                ? <p>{cardMarked > 0 ? `The card refund is already recorded (${yen(cardMarked)}). A further Square refund can be recorded once Square shows it completed.` : 'Refund it in the Square Dashboard first. This button works once Square shows the refund completed.'}</p>
                : method === 'card' ? <p>The Hub records {yen(cardStillRecordable)} — what Square completed on the card money recorded on this order{cardMarked > 0 ? `, less the ${yen(cardMarked)} already recorded` : ''}.</p> : null}
              {(cardException(card) || approval) && !isAdmin && (
                <p className="mt-1">{approval
                  ? `An admin approved a refund outside Square: ${yen(approval.amount)} by ${approval.payout === 'bank_transfer' ? 'bank transfer' : 'store credit'}. An admin records it once paid.`
                  : `Square could not refund this payment (${card.failedRefunds.length > 0 ? `refund ${card.failedRefunds[0].status.toLowerCase()}` : 'authorised over a year ago'}). An admin can approve a refund made outside Square.`}</p>
              )}
            </div>
          )}
          {step === 'approve' && card && (
            <div className="space-y-3 rounded-md border border-warning/60 bg-warning/5 p-3 text-xs" data-testid="exception-approve">
              <p className="font-medium text-warning">Step 1 of 2 — approve (admin). Nothing is paid yet.</p>
              <p className="text-warning">
                Still owed on this card payment: <strong>{yen(cap)}</strong>
                {' '}= {yen(card.cardCaptured)} captured − {yen(card.refundedCompleted)} Square refunded − {yen(card.creditIssued)} store credit issued{card.disputed > 0 ? <> − {yen(card.disputed)} card chargeback</> : null}.
                The Hub first re-reads every refund of this order from Square, then recomputes this; nothing above it is accepted.
              </p>
              {refundProcessing && (
                <p className="font-medium text-destructive">A Square refund of {yen(card.refundedPending)} is still processing. It cannot be approved until Square shows it completed, failed or rejected.</p>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="exc-refund">Why Square could not refund</Label>
                <select id="exc-refund" value={excRefundId} onChange={(e) => setExcRefundId(e.target.value)} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm">
                  {card.failedRefunds.map((r) => <option key={r.id} value={r.id}>Square refund {r.id} — {r.status} ({yen(r.amount)})</option>)}
                  {card.authorizedOverOneYear && <option value="">Card payment authorised more than one year ago</option>}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="exc-ticket">Square Support ticket number (required)</Label>
                <Input id="exc-ticket" value={excTicket} onChange={(e) => setExcTicket(e.target.value)} maxLength={80} className="bg-background border-border" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="exc-amount">Amount to refund (¥, whole yen, at most {yen(cap)})</Label>
                <Input id="exc-amount" inputMode="numeric" value={excAmount} onChange={(e) => setExcAmount(e.target.value)} className="bg-background border-border" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="exc-note">Approval note (optional, staff only)</Label>
                <Input id="exc-note" value={excNote} onChange={(e) => setExcNote(e.target.value)} maxLength={500} className="bg-background border-border" />
              </div>
            </div>
          )}
          {step === 'record' && approval && (
            <div className="space-y-3 rounded-md border border-warning/60 bg-warning/5 p-3 text-xs" data-testid="exception-record">
              <p className="font-medium text-warning">Step 2 of 2 — record the payment.</p>
              <p>
                Approved {approvalDay}: <strong>{yen(approval.amount)}</strong> by {approval.payout === 'bank_transfer' ? 'bank transfer' : 'store credit'}
                {' '}· Square Support ticket {approval.ticket}{approval.squareRefundId ? ` · refund ${approval.squareRefundId}` : ' · authorised over a year ago'}.
                The Hub records exactly this amount.
              </p>
              {isAdmin ? (
                approval.payout === 'bank_transfer' ? (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="exc-tdate">Bank transfer date (to the customer's own account, in yen; not before the approval)</Label>
                      <Input id="exc-tdate" type="date" value={excTransferDate} min={approvalDay} max={getPHTToday()} onChange={(e) => setExcTransferDate(e.target.value)} className="bg-background border-border" />
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
                      <Label htmlFor="exc-lot">Store-credit lot id — issue a NEW manual lot of exactly {yen(approval.amount)} in Settings → Store Credit after the approval; hers, in yen, unspent</Label>
                      <Input id="exc-lot" value={excLotId} onChange={(e) => setExcLotId(e.target.value)} placeholder="uuid" className="bg-background border-border font-mono text-xs" />
                    </div>
                  </>
                )
              ) : <p>Only an admin records it.</p>}
              {isAdmin && (cancelling ? (
                <div className="space-y-1.5 border-t border-warning/40 pt-2">
                  <Label htmlFor="exc-cancel">Why cancel the approval? (required)</Label>
                  <Input id="exc-cancel" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} maxLength={300} className="bg-background border-border" />
                  <div className="flex gap-2">
                    <Button size="sm" variant="destructive" disabled={busy || !cancelReason.trim()} onClick={cancelApproval}>Cancel approval</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setCancelling(false); setCancelReason(''); }}>Keep it</Button>
                  </div>
                </div>
              ) : (
                <button type="button" className="text-xs underline" onClick={() => setCancelling(true)}>Cancel this approval (only if nothing was paid)</button>
              ))}
            </div>
          )}
          {step !== 'approve' && !(step === 'record' && approval?.payout === 'bank_transfer') && (
            <div className="space-y-2">
              <Label htmlFor="refund-day">Day the refund was sent</Label>
              <Input id="refund-day" type="date" value={day} max={getPHTToday()} onChange={(e) => setDay(e.target.value)} className="bg-background border-border" />
            </div>
          )}
          {step !== 'approve' && (
            <div className="space-y-2">
              <Label htmlFor="refund-note">Note (optional, the customer sees it on her order)</Label>
              <Textarea id="refund-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} className="bg-background border-border" />
            </div>
          )}
        </div>
        <DialogFooter className="gap-2 border-t border-border bg-background px-6 py-3" data-testid="refund-footer">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Back</Button>
          {step === 'approve' ? (
            <Button onClick={approve} disabled={busy || factsMissing || approveIncomplete}>{busy ? 'Checking Square…' : 'Approve exception'}</Button>
          ) : (
            <Button onClick={submit} disabled={busy || !day || factsMissing || cardBlocked || recordIncomplete || (step === 'record' && !isAdmin)}>{busy ? 'Saving…' : 'Mark refund issued'}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
