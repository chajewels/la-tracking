import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { ChevronDown, ChevronUp, Banknote, CheckCircle, XCircle } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import CashPortalPaymentDialog from './CashPortalPaymentDialog';
import { methodLabel } from '@/lib/payment-method-registry';
import { getConversionRate } from '@/lib/currency-converter';
import { palette, memberCard, hslTriplets } from '@/theme/portal-tokens';

interface PortalPendingSubmission {
  id: string;
  cash_order_id: string;
  submitted_amount: number;
  payment_method: string | null;
  status: string;
}

// Maison inline-style palette — mirrors the CustomerPortal.tsx `M` object.
// Sourced from portal-tokens.ts (single token source) so no gold hex is
// typed here. The section renders inside the .maison-portal ivory scope.
const M = {
  s:       palette.surface1,                        // card surface — white
  s2:      palette.surface2,                        // subtle wells / tracks
  br:      `hsl(${hslTriplets.gold600} / 0.18)`,    // hairline border
  gp:      palette.gold600,                         // gold for TEXT/CTAs (AA on ivory)
  gd:      `hsl(${hslTriplets.gold600} / 0.35)`,    // gold hairline (dividers)
  tp:      palette.ink,                             // primary text
  ts:      palette.inkMuted,                        // secondary text
  gr:      memberCard.gradient,                     // decorative gold gradient (CTA)
  onGold:  memberCard.ink,                          // dark ink on the gold gradient
  success: palette.success,
  warning: palette.warning,
} as const;
const CG = "'Cormorant Garamond',Georgia,serif";

type Currency = 'PHP' | 'JPY';

export interface PortalCashOrder {
  id: string;
  invoice_number: string;
  customer_id: string;
  currency: Currency;
  total_amount: number;
  total_paid: number;
  remaining_balance: number;
  status: string;
  item_description: string | null;
  order_date: string | null;
  notes: string | null;
  cancellation_reason: string | null;
  cancelled_at: string | null;
  completed_at: string | null;
  created_at: string;
  service_jobs?: Array<{ id: string; service_type: string; service_status: string; status_label: string; service_description: string; service_fee: number; date_received: string; estimated_completion: string | null; date_completed: string | null; invoice_number: string | null }>;
  items?: Array<{ id: string; title: string; sku: string | null; quantity: number; unit_price_jpy: number; line_total_jpy: number; image_url: string | null }>;
  discount_amount?: number;
  discount_type?: string | null;
  discount_value?: number | null;
  shipping_fee?: number;
}

export interface PortalCashPayment {
  id: string;
  cash_order_id: string;
  amount_paid: number;
  currency: Currency;
  date_paid: string;
  payment_method: string | null;
  reference_number: string | null;
  remarks: string | null;
  submitted_by_type: string | null;
  submitted_by_name: string | null;
  voided_at: string | null;
  created_at: string;
}

const statusPillStyle = (status: string): React.CSSProperties => {
  const common = {
    fontSize: '10px', letterSpacing: '0.15em', textTransform: 'uppercase' as const,
    padding: '3px 10px', borderRadius: '2px', fontWeight: 600,
  };
  if (status === 'completed') return { ...common, color: M.success, border: `1px solid hsl(${hslTriplets.success} / 0.4)` };
  if (status === 'cancelled') return { ...common, color: M.ts, border: `1px solid ${M.br}` };
  return { ...common, color: M.gp, border: `1px solid hsl(${hslTriplets.gold600} / 0.4)` };
};

function fmt(amount: number, currency: Currency): string {
  const symbol = currency === 'JPY' ? '¥' : '₱';
  const n = Number(amount) || 0;
  if (currency === 'JPY') return `${symbol}${Math.round(n).toLocaleString()}`;
  return `${symbol}${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

function fmtDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr;
  }
}


interface CashOrdersSectionProps {
  cashOrders: PortalCashOrder[];
  cashPayments: PortalCashPayment[];
  customerName: string;
  portalToken: string;
  onRefresh: () => void;
}

export default function CashOrdersSection({
  cashOrders, cashPayments, customerName, portalToken, onRefresh,
}: CashOrdersSectionProps) {
  const [payTarget, setPayTarget] = useState<PortalCashOrder | null>(null);
  const [pendingByOrder, setPendingByOrder] = useState<Map<string, PortalPendingSubmission>>(new Map());

  // Anon Supabase client that forwards the portal token via a custom request
  // header. RLS policies on payment_submissions (anon SELECT / UPDATE) match
  // this header against the row's portal_token, scoping access to the
  // caller's own submissions only.
  const portalDbRef = useRef<ReturnType<typeof createClient> | null>(null);
  if (!portalDbRef.current && portalToken) {
    portalDbRef.current = createClient(
      import.meta.env.VITE_SUPABASE_URL as string,
      import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string,
      {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { 'x-portal-token': portalToken } },
      },
    );
  }

  // Group non-voided payments by cash_order_id once, client-side
  const paymentsByOrder = useMemo(() => {
    const map = new Map<string, PortalCashPayment[]>();
    for (const p of cashPayments) {
      if (p.voided_at) continue;
      const list = map.get(p.cash_order_id) || [];
      list.push(p);
      map.set(p.cash_order_id, list);
    }
    return map;
  }, [cashPayments]);

  // Fetch pending submissions for all visible cash orders. Re-runs when the
  // order set changes; can be invoked manually after a cancel.
  const fetchPending = useCallback(async () => {
    if (!cashOrders || cashOrders.length === 0) {
      setPendingByOrder(new Map());
      return;
    }
    const db = portalDbRef.current ?? supabase;
    const orderIds = cashOrders.map(o => o.id);
    const { data } = await (db as any)
      .from('payment_submissions')
      .select('id, cash_order_id, submitted_amount, payment_method, status')
      .in('cash_order_id', orderIds)
      .in('status', ['submitted', 'under_review']);
    const next = new Map<string, PortalPendingSubmission>();
    for (const sub of (data || []) as PortalPendingSubmission[]) {
      next.set(sub.cash_order_id, sub);
    }
    setPendingByOrder(next);
  }, [cashOrders]);

  useEffect(() => { fetchPending(); }, [fetchPending]);

  const handleCancelSubmission = useCallback(async (submissionId: string) => {
    const db = portalDbRef.current ?? supabase;
    await (db as any)
      .from('payment_submissions')
      .update({ status: 'cancelled' })
      .eq('id', submissionId);
    await fetchPending();
    onRefresh();
  }, [fetchPending, onRefresh]);

  // Per spec: don't render empty state — section is hidden when there are no orders
  if (!cashOrders || cashOrders.length === 0) return null;

  return (
    <>
      <div className="maison-portal font-body space-y-3">
        <div className="flex items-center gap-3">
          <div style={{ height: '1px', flex: 1, background: M.gd }} />
          <h2 style={{ color: M.gp, fontFamily: CG, fontSize: '16px', letterSpacing: '0.2em', textTransform: 'uppercase', fontWeight: 600 }}>
            Cash Orders
          </h2>
          <div style={{ height: '1px', flex: 1, background: M.gd }} />
        </div>

        <div className="space-y-3 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
          {cashOrders.map(order => (
            <CashOrderCard
              key={order.id}
              order={order}
              payments={paymentsByOrder.get(order.id) || []}
              pendingSubmission={pendingByOrder.get(order.id) || null}
              onPay={() => setPayTarget(order)}
              onCancelSubmission={handleCancelSubmission}
            />
          ))}
        </div>
      </div>

      {payTarget && (
        <CashPortalPaymentDialog
          isOpen={!!payTarget}
          onClose={() => setPayTarget(null)}
          cashOrder={{
            id: payTarget.id,
            invoice_number: payTarget.invoice_number,
            currency: payTarget.currency,
            total_amount: payTarget.total_amount,
            total_paid: payTarget.total_paid,
            remaining_balance: payTarget.remaining_balance,
          }}
          customerName={customerName}
          portalToken={portalToken}
          onSuccess={() => { onRefresh(); }}
        />
      )}
    </>
  );
}

function CashOrderCard({
  order, payments, pendingSubmission, onPay, onCancelSubmission,
}: {
  order: PortalCashOrder;
  payments: PortalCashPayment[];
  pendingSubmission: PortalPendingSubmission | null;
  onPay: () => void;
  onCancelSubmission: (submissionId: string) => Promise<void>;
}) {
  const currency = order.currency;
  // Line items are stored in JPY; customers see them in the order currency
  // (PHP = JPY × rate). Mirrors the layaway portal AccountCard.
  const toAcct = (jpy: number) => currency === 'PHP' ? Math.round(jpy * getConversionRate()) : jpy;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [itemsOpen, setItemsOpen] = useState(false);
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const isPending = order.status === 'pending';
  const isCompleted = order.status === 'completed';
  const isCancelled = order.status === 'cancelled';

  return (
    <div style={{ background: M.s, border: `1px solid ${M.br}`, borderRadius: '12px', padding: '16px', boxShadow: '0 2px 12px rgba(43,39,35,0.06)' }}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Banknote className="h-4 w-4" style={{ color: M.gp }} />
            <span style={{ color: M.tp, fontFamily: CG, fontSize: '20px', fontWeight: 600, lineHeight: 1.1 }}>
              #{order.invoice_number}
            </span>
          </div>
          {order.item_description && (
            <p style={{ color: M.ts, fontSize: '12px', marginTop: '4px', lineHeight: 1.4 }}>
              {order.item_description}
            </p>
          )}
          {order.order_date && (
            <p style={{ color: M.ts, fontSize: '11px', marginTop: '2px' }}>
              Order date {fmtDate(order.order_date)}
            </p>
          )}
        </div>
        <span style={statusPillStyle(order.status)}>{order.status}</span>
      </div>

      {/* Completed banner */}
      {isCompleted && (
        <div className="mt-3 flex items-center gap-2" style={{ background: `hsl(${hslTriplets.success} / 0.10)`, border: `1px solid hsl(${hslTriplets.success} / 0.3)`, borderRadius: '8px', padding: '8px 10px' }}>
          <CheckCircle className="h-4 w-4" style={{ color: M.success }} />
          <span style={{ color: M.success, fontSize: '12px', fontWeight: 600 }}>🎉 Fully paid — thank you!</span>
        </div>
      )}

      {/* Cancelled banner */}
      {isCancelled && (
        <div className="mt-3" style={{ background: M.s2, border: `1px solid ${M.br}`, borderRadius: '8px', padding: '8px 10px' }}>
          <span style={{ color: M.ts, fontSize: '12px', fontWeight: 600 }}>Order cancelled</span>
          {order.cancellation_reason && (
            <p style={{ color: M.ts, fontSize: '11px', marginTop: '2px' }}>{order.cancellation_reason}</p>
          )}
        </div>
      )}

      {/* Amount block */}
      <div className="mt-4 grid grid-cols-3" style={{ border: `1px solid ${M.br}`, borderRadius: '8px' }}>
        <div style={{ padding: '10px 8px', textAlign: 'center' }}>
          <p style={{ color: M.ts, fontSize: '9px', letterSpacing: '0.15em', textTransform: 'uppercase' }}>Total</p>
          <p className="tabular-nums" style={{ color: M.tp, fontSize: '13px', fontWeight: 600, marginTop: '3px' }}>
            {fmt(order.total_amount, currency)}
          </p>
        </div>
        <div style={{ padding: '10px 8px', textAlign: 'center', borderLeft: `1px solid ${M.br}`, borderRight: `1px solid ${M.br}` }}>
          <p style={{ color: M.ts, fontSize: '9px', letterSpacing: '0.15em', textTransform: 'uppercase' }}>Paid</p>
          <p className="tabular-nums" style={{ color: M.success, fontSize: '13px', fontWeight: 600, marginTop: '3px' }}>
            {fmt(order.total_paid, currency)}
          </p>
        </div>
        <div style={{ padding: '10px 8px', textAlign: 'center' }}>
          <p style={{ color: M.ts, fontSize: '9px', letterSpacing: '0.15em', textTransform: 'uppercase' }}>Remaining</p>
          <p className="tabular-nums" style={{ color: M.gp, fontSize: '13px', fontWeight: 600, marginTop: '3px' }}>
            {fmt(order.remaining_balance, currency)}
          </p>
        </div>
      </div>

      {/* Breakdown — recorded discount / shipping (order currency). Explains the
          total shown above; no reconciliation equation asserted. */}
      {(Number(order.discount_amount || 0) > 0 || Number(order.shipping_fee || 0) > 0) && (
        <div className="mt-3 space-y-1">
          {Number(order.discount_amount || 0) > 0 && (
            <div className="flex items-center justify-between" style={{ fontSize: '12px' }}>
              <span style={{ color: M.ts }}>
                Discount{order.discount_type === 'percent' ? ` (${order.discount_value}%)` : ''}
              </span>
              <span className="tabular-nums" style={{ color: M.success }}>−{fmt(Number(order.discount_amount), currency)}</span>
            </div>
          )}
          {Number(order.shipping_fee || 0) > 0 && (
            <div className="flex items-center justify-between" style={{ fontSize: '12px' }}>
              <span style={{ color: M.ts }}>Shipping</span>
              <span className="tabular-nums" style={{ color: M.tp }}>+{fmt(Number(order.shipping_fee), currency)}</span>
            </div>
          )}
        </div>
      )}

      {/* Service Status */}
      {order.service_jobs && order.service_jobs.length > 0 && (
        <div className="mt-4">
          <p style={{ fontFamily: 'Inter,sans-serif', fontSize: '9px', fontWeight: 500, letterSpacing: '0.2em', textTransform: 'uppercase', color: M.ts, marginBottom: '12px' }}>Service Status</p>
          <div>
            {order.service_jobs.map((job) => {
              const SERVICE_LABELS: Record<string, string> = {
                resize: 'Resize', certificate: 'Certificate', polish: 'Polish',
                change_color: 'Change Color', engraving: 'Engraving', repair: 'Repair', other: 'Other',
              };
              const SERVICE_BADGE: Record<string, { color: string; opacity?: number }> = {
                'Received': { color: M.ts },
                'In Progress': { color: M.gp },
                'On Hold': { color: M.warning },
                'Cancelled': { color: M.ts, opacity: 0.6 },
                'Completed': { color: M.success },
              };
              const badge = SERVICE_BADGE[job.status_label] ?? { color: M.ts };
              const timeline = `Received ${fmtDate(job.date_received)}` +
                (job.date_completed ? ` · Completed ${fmtDate(job.date_completed)}`
                  : job.estimated_completion ? ` · Est. ${fmtDate(job.estimated_completion)}` : '');
              return (
                <div key={job.id} className="flex items-center justify-between py-3" style={{ borderBottom: `1px solid ${M.s2}` }}>
                  <div>
                    <p style={{ fontFamily: 'Inter,sans-serif', fontSize: '13px', color: M.tp, fontWeight: 500 }}>{SERVICE_LABELS[job.service_type] || job.service_type}</p>
                    {job.service_description && <p style={{ fontFamily: 'Inter,sans-serif', fontSize: '11px', color: M.ts, marginTop: '2px' }}>{job.service_description}</p>}
                    <p style={{ fontFamily: 'Inter,sans-serif', fontSize: '10px', color: M.ts, marginTop: '2px' }}>{timeline}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span style={{ fontFamily: 'Inter,sans-serif', fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.1em', padding: '0 8px', borderRadius: '999px', border: `1px solid ${badge.color}`, color: badge.color, background: 'transparent', opacity: badge.opacity ?? 1 }}>{job.status_label}</span>
                    <p style={{ fontFamily: 'Inter,sans-serif', fontSize: '14px', fontWeight: 600, color: M.gp }}>{fmt(job.service_fee, currency)}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Action — pending-submission banner takes precedence over the Submit button */}
      {isPending && pendingSubmission ? (
        <div
          style={{ background: `hsl(${hslTriplets.success} / 0.10)`, border: `1px solid hsl(${hslTriplets.success} / 0.3)`, borderRadius: 8, padding: '10px 14px', marginTop: 12 }}
        >
          <p style={{ color: M.success, fontSize: 12, margin: 0, fontWeight: 600 }}>
            ⏳ Payment submitted — awaiting confirmation
          </p>
          <p style={{ color: M.ts, fontSize: 11, marginTop: 4 }}>
            {fmt(Number(pendingSubmission.submitted_amount), currency)}
            {pendingSubmission.payment_method ? ` via ${methodLabel(pendingSubmission.payment_method)}` : ''}
          </p>
          <button
            type="button"
            disabled={cancelling}
            onClick={async () => {
              if (cancelling) return;
              setCancelling(true);
              try {
                await onCancelSubmission(pendingSubmission.id);
              } finally {
                setCancelling(false);
              }
            }}
            style={{
              marginTop: 8,
              background: 'none',
              border: `1px solid ${M.br}`,
              borderRadius: 8,
              color: M.ts,
              fontSize: 11,
              padding: '4px 10px',
              cursor: cancelling ? 'not-allowed' : 'pointer',
              opacity: cancelling ? 0.6 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <XCircle className="h-3 w-3" />
            {cancelling ? 'Cancelling…' : 'Cancel Submission'}
          </button>
        </div>
      ) : isPending ? (
        <button
          onClick={onPay}
          className="w-full mt-3"
          style={{
            background: M.gr, border: 'none', borderRadius: '8px', color: M.onGold,
            height: '44px', fontFamily: 'Inter,sans-serif', fontSize: '12px',
            fontWeight: 600, letterSpacing: '0.15em', textTransform: 'uppercase',
            cursor: 'pointer',
          }}
        >
          Submit Payment
        </button>
      ) : null}

      {/* Items (collapsible) — only when the order carries line items */}
      {order.items && order.items.length > 0 && (
        <div className="mt-3" style={{ borderTop: `1px solid ${M.br}`, paddingTop: '10px' }}>
          <button
            type="button"
            onClick={() => setItemsOpen(v => !v)}
            className="w-full flex items-center justify-between"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            <span style={{ color: M.ts, fontSize: '10px', letterSpacing: '0.15em', textTransform: 'uppercase', fontWeight: 600 }}>
              View Items ({order.items.length})
            </span>
            {itemsOpen
              ? <ChevronUp className="h-4 w-4" style={{ color: M.ts }} />
              : <ChevronDown className="h-4 w-4" style={{ color: M.ts }} />}
          </button>

          {itemsOpen && (
            <div className="mt-2 space-y-1.5">
              {order.items.map(item => (
                <div key={item.id} className="flex items-center gap-3">
                  {item.image_url ? (
                    <img
                      src={item.image_url}
                      alt=""
                      onClick={() => setZoomImage(item.image_url)}
                      style={{ width: '44px', height: '44px', borderRadius: '8px', border: `1px solid ${M.br}`, objectFit: 'cover', flexShrink: 0, cursor: 'pointer' }}
                    />
                  ) : (
                    <div style={{ width: '44px', height: '44px', borderRadius: '8px', border: `1px solid ${M.br}`, background: M.s2, flexShrink: 0 }} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate" style={{ color: M.tp, fontFamily: CG, fontSize: '14px', fontWeight: 600, lineHeight: 1.2 }}>
                      {item.title}
                    </div>
                    {item.sku && (
                      <div style={{ color: M.ts, fontSize: '11px', marginTop: '1px' }}>SKU {item.sku}</div>
                    )}
                    <div style={{ color: M.ts, fontSize: '12px', marginTop: '1px' }}>
                      {item.quantity} × {fmt(toAcct(item.unit_price_jpy), currency)}
                    </div>
                  </div>
                  <span className="tabular-nums shrink-0" style={{ color: M.tp, fontSize: '13px', fontWeight: 600 }}>
                    {fmt(toAcct(item.line_total_jpy), currency)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Payment history (collapsible, client-side filtered from props) */}
      <div className="mt-3" style={{ borderTop: `1px solid ${M.br}`, paddingTop: '10px' }}>
        <button
          type="button"
          onClick={() => setHistoryOpen(v => !v)}
          className="w-full flex items-center justify-between"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          <span style={{ color: M.ts, fontSize: '10px', letterSpacing: '0.15em', textTransform: 'uppercase', fontWeight: 600 }}>
            Payment History ({payments.length})
          </span>
          {historyOpen
            ? <ChevronUp className="h-4 w-4" style={{ color: M.ts }} />
            : <ChevronDown className="h-4 w-4" style={{ color: M.ts }} />}
        </button>

        {historyOpen && (
          <div className="mt-2 space-y-1.5">
            {payments.length === 0 ? (
              <p style={{ color: M.ts, fontSize: '11px', fontStyle: 'italic' }}>No payments recorded yet.</p>
            ) : (
              payments.map(p => (
                <div
                  key={p.id}
                  style={{ background: M.s2, border: `1px solid ${M.br}`, borderRadius: '8px', padding: '8px 10px' }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="tabular-nums" style={{ color: M.tp, fontSize: '13px', fontWeight: 600 }}>
                      {fmt(Number(p.amount_paid), p.currency || currency)}
                    </span>
                    <span style={{ color: M.ts, fontSize: '10px' }}>{fmtDate(p.date_paid)}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span style={{ color: M.ts, fontSize: '10px' }}>{p.payment_method ? methodLabel(p.payment_method) : '—'}</span>
                    {p.reference_number && (
                      <span style={{ color: M.ts, fontSize: '10px' }}>· Ref {p.reference_number}</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Item image zoom — Maison overlay (tap backdrop or × to close) */}
      {zoomImage && (
        <div
          onClick={() => setZoomImage(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(43,39,35,0.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', cursor: 'zoom-out' }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); setZoomImage(null); }}
            aria-label="Close"
            style={{ position: 'absolute', top: '16px', right: '16px', width: '40px', height: '40px', borderRadius: '9999px', background: M.s, border: `1px solid ${M.br}`, color: M.tp, fontSize: '20px', lineHeight: 1, cursor: 'pointer' }}
          >×</button>
          <img
            src={zoomImage}
            alt=""
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '100%', maxHeight: '85vh', objectFit: 'contain', borderRadius: '12px', boxShadow: '0 8px 40px rgba(0,0,0,0.4)' }}
          />
        </div>
      )}
    </div>
  );
}
