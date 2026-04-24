import { useState, useMemo } from 'react';
import { ChevronDown, ChevronUp, Banknote, CheckCircle } from 'lucide-react';
import CashPortalPaymentDialog from './CashPortalPaymentDialog';

// Portal palette — must match src/pages/CustomerPortal.tsx
const P = {
  bg: '#0A0A0A', s: '#111111', s2: '#1A1A1A', br: '#2A2200',
  gp: '#C9A84C', gl: '#E8C96D', gd: '#8B6914',
  tp: '#F5F0E8', ts: '#9A8F7E',
  gr: 'linear-gradient(135deg,#C9A84C 0%,#E8C96D 50%,#C9A84C 100%)',
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
  if (status === 'completed') return { ...common, color: '#5CB86A', border: '1px solid #5CB86A55' };
  if (status === 'cancelled') return { ...common, color: '#888', border: '1px solid #88833' };
  return { ...common, color: P.gp, border: `1px solid ${P.gp}55` };
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

function prettyMethod(m: string | null | undefined): string {
  if (!m) return '—';
  if (m === 'gcash') return 'GCash';
  if (m === 'bank') return 'Bank Transfer';
  if (m === 'cash') return 'Cash';
  return m;
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

  // Per spec: don't render empty state — section is hidden when there are no orders
  if (!cashOrders || cashOrders.length === 0) return null;

  return (
    <>
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div style={{ height: '1px', flex: 1, background: P.gd }} />
          <h2 style={{ color: P.gp, fontFamily: CG, fontSize: '16px', letterSpacing: '0.2em', textTransform: 'uppercase', fontWeight: 600 }}>
            Cash Orders
          </h2>
          <div style={{ height: '1px', flex: 1, background: P.gd }} />
        </div>

        <div className="space-y-3 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
          {cashOrders.map(order => (
            <CashOrderCard
              key={order.id}
              order={order}
              payments={paymentsByOrder.get(order.id) || []}
              onPay={() => setPayTarget(order)}
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
  order, payments, onPay,
}: {
  order: PortalCashOrder;
  payments: PortalCashPayment[];
  onPay: () => void;
}) {
  const currency = order.currency;
  const [historyOpen, setHistoryOpen] = useState(false);

  const isPending = order.status === 'pending';
  const isCompleted = order.status === 'completed';
  const isCancelled = order.status === 'cancelled';

  return (
    <div style={{ background: P.s, border: `1px solid ${P.br}`, borderRadius: '2px', padding: '16px' }}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Banknote className="h-4 w-4" style={{ color: P.gp }} />
            <span style={{ color: P.tp, fontFamily: CG, fontSize: '20px', fontWeight: 600, lineHeight: 1.1 }}>
              #{order.invoice_number}
            </span>
          </div>
          {order.item_description && (
            <p style={{ color: P.ts, fontSize: '12px', marginTop: '4px', lineHeight: 1.4 }}>
              {order.item_description}
            </p>
          )}
          {order.order_date && (
            <p style={{ color: P.ts, fontSize: '11px', marginTop: '2px' }}>
              Order date {fmtDate(order.order_date)}
            </p>
          )}
        </div>
        <span style={statusPillStyle(order.status)}>{order.status}</span>
      </div>

      {/* Completed banner */}
      {isCompleted && (
        <div className="mt-3 flex items-center gap-2" style={{ background: 'rgba(92,184,106,0.08)', border: '1px solid rgba(92,184,106,0.3)', borderRadius: '2px', padding: '8px 10px' }}>
          <CheckCircle className="h-4 w-4" style={{ color: '#5CB86A' }} />
          <span style={{ color: '#5CB86A', fontSize: '12px', fontWeight: 600 }}>🎉 Fully paid — thank you!</span>
        </div>
      )}

      {/* Cancelled banner */}
      {isCancelled && (
        <div className="mt-3" style={{ background: 'rgba(100,100,100,0.08)', border: '1px solid #33333355', borderRadius: '2px', padding: '8px 10px' }}>
          <span style={{ color: '#9A9A9A', fontSize: '12px', fontWeight: 600 }}>Order cancelled</span>
          {order.cancellation_reason && (
            <p style={{ color: P.ts, fontSize: '11px', marginTop: '2px' }}>{order.cancellation_reason}</p>
          )}
        </div>
      )}

      {/* Amount block */}
      <div className="mt-4 grid grid-cols-3" style={{ border: `1px solid ${P.br}`, borderRadius: '2px' }}>
        <div style={{ padding: '10px 8px', textAlign: 'center' }}>
          <p style={{ color: P.ts, fontSize: '9px', letterSpacing: '0.15em', textTransform: 'uppercase' }}>Total</p>
          <p className="tabular-nums" style={{ color: P.tp, fontSize: '13px', fontWeight: 600, marginTop: '3px' }}>
            {fmt(order.total_amount, currency)}
          </p>
        </div>
        <div style={{ padding: '10px 8px', textAlign: 'center', borderLeft: `1px solid ${P.br}`, borderRight: `1px solid ${P.br}` }}>
          <p style={{ color: P.ts, fontSize: '9px', letterSpacing: '0.15em', textTransform: 'uppercase' }}>Paid</p>
          <p className="tabular-nums" style={{ color: '#5CB86A', fontSize: '13px', fontWeight: 600, marginTop: '3px' }}>
            {fmt(order.total_paid, currency)}
          </p>
        </div>
        <div style={{ padding: '10px 8px', textAlign: 'center' }}>
          <p style={{ color: P.ts, fontSize: '9px', letterSpacing: '0.15em', textTransform: 'uppercase' }}>Remaining</p>
          <p className="tabular-nums" style={{ color: P.gp, fontSize: '13px', fontWeight: 600, marginTop: '3px' }}>
            {fmt(order.remaining_balance, currency)}
          </p>
        </div>
      </div>

      {/* Action */}
      {isPending && (
        <button
          onClick={onPay}
          className="w-full mt-3"
          style={{
            background: P.gr, border: 'none', borderRadius: '2px', color: P.bg,
            height: '44px', fontFamily: 'Inter,sans-serif', fontSize: '12px',
            fontWeight: 600, letterSpacing: '0.15em', textTransform: 'uppercase',
            cursor: 'pointer',
          }}
        >
          Submit Payment
        </button>
      )}

      {/* Payment history (collapsible, client-side filtered from props) */}
      <div className="mt-3" style={{ borderTop: `1px solid ${P.br}`, paddingTop: '10px' }}>
        <button
          type="button"
          onClick={() => setHistoryOpen(v => !v)}
          className="w-full flex items-center justify-between"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          <span style={{ color: P.ts, fontSize: '10px', letterSpacing: '0.15em', textTransform: 'uppercase', fontWeight: 600 }}>
            Payment History ({payments.length})
          </span>
          {historyOpen
            ? <ChevronUp className="h-4 w-4" style={{ color: P.ts }} />
            : <ChevronDown className="h-4 w-4" style={{ color: P.ts }} />}
        </button>

        {historyOpen && (
          <div className="mt-2 space-y-1.5">
            {payments.length === 0 ? (
              <p style={{ color: P.ts, fontSize: '11px', fontStyle: 'italic' }}>No payments recorded yet.</p>
            ) : (
              payments.map(p => (
                <div
                  key={p.id}
                  style={{ background: P.s2, border: `1px solid ${P.br}`, borderRadius: '2px', padding: '8px 10px' }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="tabular-nums" style={{ color: P.tp, fontSize: '13px', fontWeight: 600 }}>
                      {fmt(Number(p.amount_paid), p.currency || currency)}
                    </span>
                    <span style={{ color: P.ts, fontSize: '10px' }}>{fmtDate(p.date_paid)}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span style={{ color: P.ts, fontSize: '10px' }}>{prettyMethod(p.payment_method)}</span>
                    {p.reference_number && (
                      <span style={{ color: P.ts, fontSize: '10px' }}>· Ref {p.reference_number}</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
