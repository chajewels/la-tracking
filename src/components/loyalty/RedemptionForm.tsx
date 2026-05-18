import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

const CG = "'Cormorant Garamond',Georgia,serif";

const P = {
  s: '#111111',
  s2: '#1A1A1A',
  br: '#2A2200',
  gp: '#C9A84C',
  gl: '#E8C96D',
  tp: '#F5F0E8',
  ts: '#9A8F7E',
  gr: 'linear-gradient(135deg,#C9A84C 0%,#E8C96D 50%,#C9A84C 100%)',
} as const;

type RedemptionType = 'new_order_discount' | 'shipping_fee' | 'service_fee';

interface OrderOption {
  id: string;
  kind: 'layaway' | 'cash';
  invoice_number: string;
  currency: 'PHP' | 'JPY';
  total_amount: number;
  total_paid: number;
  remaining_balance: number;
  status: string;
}

const TYPE_OPTIONS: Array<{
  value: RedemptionType;
  icon: string;
  title: string;
  description: string;
}> = [
  {
    value: 'new_order_discount',
    icon: '🏷️',
    title: 'New Order Discount',
    description: 'Apply as discount on a new order',
  },
  {
    value: 'shipping_fee',
    icon: '📦',
    title: 'Shipping Fee',
    description: 'Pay shipping cost on any of your orders',
  },
  {
    value: 'service_fee',
    icon: '🛠️',
    title: 'Service Fee',
    description: 'Pay service charges on any of your orders',
  },
];

const QUICK_AMOUNTS = [500, 1000, 2000];

// Currency-formatted amount per CLAUDE.md display rules:
// PHP → "₱" + comma separators; JPY → "¥" + no decimals; drop .00 on whole.
function fmtMoney(amount: number, currency: 'PHP' | 'JPY'): string {
  const n = Number(amount ?? 0);
  if (currency === 'JPY') {
    return `¥${Math.round(n).toLocaleString('en-US')}`;
  }
  const whole = Number.isInteger(n);
  return `₱${n.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function titleCaseStatus(status: string): string {
  if (!status) return '';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export interface RedemptionFormProps {
  isOpen: boolean;
  onClose: () => void;
  remainingPoints: number;
  customerId: string;
  portalToken: string;
  memberId: string;
  onSuccess?: () => void;
}

export function RedemptionForm({
  isOpen,
  onClose,
  remainingPoints,
  memberId,
  portalToken,
  onSuccess,
}: RedemptionFormProps) {
  const [redemptionType, setRedemptionType] = useState<RedemptionType | ''>('');
  const [pointsInput, setPointsInput] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [selectedOrderKind, setSelectedOrderKind] = useState<
    'layaway' | 'cash' | null
  >(null);
  const [orders, setOrders] = useState<OrderOption[]>([]);
  const [loadingOrders, setLoadingOrders] = useState<boolean>(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [invoiceInput, setInvoiceInput] = useState<string>('');

  // Reset form whenever the dialog opens.
  useEffect(() => {
    if (isOpen) {
      setRedemptionType('');
      setPointsInput('');
      setNotes('');
      setSubmitting(false);
      setSubmitted(false);
      setErrorMsg(null);
      setSelectedOrderId(null);
      setSelectedOrderKind(null);
      setOrders([]);
      setOrdersError(null);
      setInvoiceInput('');
    }
  }, [isOpen]);

  // Fetch the customer's orders once per dialog open.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      setLoadingOrders(true);
      setOrdersError(null);
      try {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
        const supabaseAnonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
        const url = new URL(`${supabaseUrl}/functions/v1/customer-portal`);
        url.searchParams.set('token', portalToken);

        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${supabaseAnonKey}`,
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `customer-portal returned ${response.status}: ${errorText}`,
          );
        }

        const data = await response.json();
        const errFromBody = (data as any)?.error as string | undefined;
        if (errFromBody) throw new Error(errFromBody);

        const layaway: OrderOption[] = (((data as any)?.accounts ?? []) as any[]).map(
          (a) => ({
            id: a.id,
            kind: 'layaway' as const,
            invoice_number: a.invoice_number,
            currency: a.currency,
            total_amount: Number(a.total_amount ?? 0),
            total_paid: Number(a.total_paid ?? 0),
            remaining_balance: Number(a.remaining_balance ?? 0),
            status: a.status,
          }),
        );
        const cash: OrderOption[] = (((data as any)?.cash_orders ?? []) as any[]).map(
          (o) => ({
            id: o.id,
            kind: 'cash' as const,
            invoice_number: o.invoice_number,
            currency: o.currency,
            total_amount: Number(o.total_amount ?? 0),
            total_paid: Number(o.total_paid ?? 0),
            remaining_balance: Number(o.remaining_balance ?? 0),
            status: o.status,
          }),
        );
        if (!cancelled) setOrders([...layaway, ...cash]);
      } catch (err: any) {
        if (!cancelled) {
          setOrdersError(
            err?.message || 'Could not load your orders — please try again',
          );
        }
      } finally {
        if (!cancelled) setLoadingOrders(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, portalToken]);

  const pointsNum = useMemo(() => {
    const n = Number(pointsInput);
    return Number.isFinite(n) ? Math.floor(n) : 0;
  }, [pointsInput]);

  const eligibleOrders = useMemo<OrderOption[]>(() => {
    if (!redemptionType) return [];
    return orders.filter((o) => {
      if (redemptionType === 'new_order_discount') {
        if (o.kind === 'layaway') return Number(o.total_paid ?? 0) === 0;
        return o.status === 'pending' && Number(o.total_paid ?? 0) === 0;
      }
      return true; // shipping_fee / service_fee — no filter
    });
  }, [orders, redemptionType]);

  const matchedOrder = useMemo<OrderOption | null>(() => {
    if (redemptionType !== 'new_order_discount') return null;
    const trimmed = invoiceInput.trim();
    if (!trimmed) return null;
    const match = orders.find((o) => o.invoice_number === trimmed);
    if (!match) return null;
    // Brand-new constraint for new_order_discount
    if (match.kind === 'layaway' && Number(match.total_paid ?? 0) > 0) return null;
    if (match.kind === 'cash' && (match.status !== 'pending' || Number(match.total_paid ?? 0) > 0)) return null;
    return match;
  }, [redemptionType, invoiceInput, orders]);

  const pointsValid = pointsNum > 0 && pointsNum <= remainingPoints;
  const typeValid = redemptionType !== '';
  const orderSelected =
    selectedOrderId !== null && selectedOrderKind !== null;
  const orderInputValid = redemptionType === 'new_order_discount'
    ? matchedOrder !== null
    : orderSelected;
  const formValid = pointsValid && typeValid && orderInputValid;

  const pointsError = pointsInput && !pointsValid
    ? pointsNum <= 0
      ? 'Enter a positive number'
      : `Cannot exceed your ${remainingPoints.toLocaleString()} available points`
    : null;

  async function handleSubmit() {
    if (!formValid) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      let orderForBody: OrderOption | null = null;
      if (redemptionType === 'new_order_discount') {
        if (!matchedOrder) {
          setErrorMsg('Please enter a valid invoice number');
          setSubmitting(false);
          return;
        }
        orderForBody = matchedOrder;
      } else {
        const selectedOrder = eligibleOrders.find(
          (o) => o.id === selectedOrderId,
        );
        if (!selectedOrder) {
          setErrorMsg('Please select an order');
          setSubmitting(false);
          return;
        }
        orderForBody = selectedOrder;
      }

      const { data, error } = await supabase.functions.invoke(
        'process-loyalty-redemption',
        {
          body: {
            action: 'create',
            member_id: memberId,
            redemption_type: redemptionType,
            points_redeemed: pointsNum,
            invoice_number: orderForBody.invoice_number,
            notes: notes.trim() || null,
            portal_token: portalToken,
            account_id:
              orderForBody.kind === 'layaway' ? orderForBody.id : null,
            cash_order_id:
              orderForBody.kind === 'cash' ? orderForBody.id : null,
          },
        },
      );
      if (error) throw error;
      const errFromBody = (data as any)?.error as string | undefined;
      if (errFromBody) throw new Error(errFromBody);

      setSubmitted(true);
      toast.success('Redemption request submitted');
      window.setTimeout(() => {
        onSuccess?.();
        onClose();
      }, 2000);
    } catch (err: any) {
      const msg = err?.message || 'Could not submit redemption — please try again';
      setErrorMsg(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  const pickerSubtitle =
    redemptionType === 'new_order_discount'
      ? 'Brand-new orders only'
      : 'Any of your orders';
  const emptyMsg =
    redemptionType === 'new_order_discount'
      ? 'No brand-new orders found. Please create a new order with our team first, then come back to redeem.'
      : 'No orders found.';

  return (
    <Dialog open={isOpen} onOpenChange={(o) => (!o && !submitting ? onClose() : undefined)}>
      <DialogContent
        className="max-w-md sm:max-w-lg"
        style={{
          background: P.s,
          border: `1px solid ${P.br}`,
          color: P.tp,
        }}
      >
        {submitted ? (
          <SuccessView />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle
                style={{
                  fontFamily: CG,
                  background: P.gr,
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  fontSize: '24px',
                  letterSpacing: '0.02em',
                }}
              >
                Redeem Your Points
              </DialogTitle>
              <DialogDescription style={{ color: P.ts }}>
                You have{' '}
                <span style={{ color: P.gl, fontWeight: 600 }}>
                  {remainingPoints.toLocaleString()}
                </span>{' '}
                points available. 1 point = ¥1 value.
              </DialogDescription>
            </DialogHeader>

            <InfoPanel redemptionType={redemptionType} />

            <form
              className="space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                handleSubmit();
              }}
            >
              {/* Redemption Type */}
              <div>
                <Label style={{ color: P.tp }}>Redemption Type</Label>
                <RadioGroup
                  value={redemptionType}
                  onValueChange={(v) => setRedemptionType(v as RedemptionType)}
                  className="mt-2 space-y-2"
                >
                  {TYPE_OPTIONS.map((opt) => (
                    <label
                      key={opt.value}
                      htmlFor={`rt-${opt.value}`}
                      className="flex cursor-pointer items-start gap-3 rounded-md p-3"
                      style={{
                        background: redemptionType === opt.value ? P.s2 : 'transparent',
                        border: `1px solid ${redemptionType === opt.value ? P.gp : P.br}`,
                      }}
                    >
                      <RadioGroupItem id={`rt-${opt.value}`} value={opt.value} />
                      <div className="flex-1">
                        <div
                          className="flex items-center gap-2 text-sm"
                          style={{ color: P.tp, fontFamily: CG, fontSize: '15px' }}
                        >
                          <span aria-hidden="true">{opt.icon}</span>
                          {opt.title}
                        </div>
                        <div className="mt-0.5 text-xs" style={{ color: P.ts }}>
                          {opt.description}
                        </div>
                      </div>
                    </label>
                  ))}
                </RadioGroup>
              </div>

              {/* new_order_discount — required free-text invoice */}
              {redemptionType === 'new_order_discount' && (
                <div>
                  <Label htmlFor="invoice" style={{ color: P.tp }}>
                    Invoice Number{' '}
                    <span style={{ color: '#B85450' }}>*</span>
                  </Label>
                  <Input
                    id="invoice"
                    value={invoiceInput}
                    onChange={(e) => setInvoiceInput(e.target.value)}
                    placeholder="e.g. 19012"
                    className="mt-2"
                    style={{ background: P.s2, color: P.tp, borderColor: P.br }}
                  />
                  <div className="mt-1 text-xs" style={{ color: P.ts }}>
                    Enter the invoice number your team gave you for the new order.
                  </div>
                  {invoiceInput.trim() && !matchedOrder && (
                    <div className="mt-1 text-xs" style={{ color: '#B85450' }}>
                      Invoice not found among your brand-new orders.
                    </div>
                  )}
                  {matchedOrder && (
                    <div className="mt-1 text-xs" style={{ color: P.gl }}>
                      ✓ Found:{' '}
                      {matchedOrder.kind === 'layaway'
                        ? 'Layaway'
                        : 'Cash Order'}
                      {' — '}
                      {matchedOrder.currency === 'PHP' ? '₱' : '¥'}
                      {Number(matchedOrder.total_amount).toLocaleString(
                        undefined,
                        {
                          maximumFractionDigits:
                            matchedOrder.currency === 'JPY' ? 0 : 2,
                        },
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Order Picker — shipping_fee / service_fee only */}
              {(redemptionType === 'shipping_fee' ||
                redemptionType === 'service_fee') && (
                <div>
                  <Label style={{ color: P.tp }}>Select an order</Label>
                  <div className="mt-0.5 text-xs" style={{ color: P.ts }}>
                    {pickerSubtitle}
                  </div>

                  {loadingOrders ? (
                    <Skeleton
                      className="mt-2 h-20 w-full rounded-md"
                      style={{ background: P.s2 }}
                    />
                  ) : ordersError ? (
                    <div
                      className="mt-2 rounded-md px-3 py-2 text-sm"
                      style={{
                        background: '#3b1414',
                        border: '1px solid #B85450',
                        color: '#F5C9C9',
                      }}
                    >
                      {ordersError}
                    </div>
                  ) : eligibleOrders.length === 0 ? (
                    <div
                      className="mt-2 rounded-md px-3 py-2 text-xs"
                      style={{
                        background: P.s2,
                        border: `1px solid ${P.br}`,
                        color: P.gl,
                      }}
                    >
                      {emptyMsg}
                    </div>
                  ) : (
                    <RadioGroup
                      value={selectedOrderId ?? ''}
                      onValueChange={(v) => {
                        const picked = eligibleOrders.find((o) => o.id === v);
                        setSelectedOrderId(v);
                        setSelectedOrderKind(picked ? picked.kind : null);
                      }}
                      className="mt-2 space-y-2"
                      style={{
                        maxHeight: '260px',
                        overflowY: 'auto',
                        paddingRight: '4px',
                      }}
                    >
                      {eligibleOrders.map((o) => {
                        const sel = selectedOrderId === o.id;
                        return (
                          <label
                            key={`${o.kind}-${o.id}`}
                            htmlFor={`ord-${o.kind}-${o.id}`}
                            className="flex cursor-pointer items-start gap-3 rounded-md p-3"
                            style={{
                              background: sel ? P.s2 : 'transparent',
                              border: `1px solid ${sel ? P.gp : P.br}`,
                            }}
                          >
                            <RadioGroupItem
                              id={`ord-${o.kind}-${o.id}`}
                              value={o.id}
                            />
                            <div className="flex-1">
                              <div
                                style={{
                                  color: P.tp,
                                  fontFamily: CG,
                                  fontSize: '15px',
                                }}
                              >
                                #{o.invoice_number}
                              </div>
                              <div
                                className="mt-0.5 text-xs"
                                style={{ color: P.ts }}
                              >
                                {o.kind === 'layaway' ? 'Layaway' : 'Cash Order'}
                                {' • '}
                                {titleCaseStatus(o.status)}
                              </div>
                              <div
                                className="mt-0.5 text-xs"
                                style={{ color: P.ts }}
                              >
                                Total {fmtMoney(o.total_amount, o.currency)}
                                {' • '}
                                Remaining{' '}
                                {fmtMoney(o.remaining_balance, o.currency)}
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </RadioGroup>
                  )}
                </div>
              )}

              {/* Points to Redeem */}
              <div>
                <Label htmlFor="points" style={{ color: P.tp }}>
                  Points to Redeem
                </Label>
                <Input
                  id="points"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={remainingPoints}
                  step={1}
                  value={pointsInput}
                  onChange={(e) => setPointsInput(e.target.value)}
                  placeholder="0"
                  className="mt-2"
                  style={{ background: P.s2, color: P.tp, borderColor: P.br }}
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  {QUICK_AMOUNTS.map((amt) => (
                    <Button
                      key={amt}
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={amt > remainingPoints}
                      onClick={() => setPointsInput(String(amt))}
                      style={{
                        background: 'transparent',
                        color: P.tp,
                        borderColor: P.br,
                      }}
                    >
                      {amt.toLocaleString()}
                    </Button>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={remainingPoints <= 0}
                    onClick={() => setPointsInput(String(remainingPoints))}
                    style={{
                      background: 'transparent',
                      color: P.gl,
                      borderColor: P.gp,
                    }}
                  >
                    All
                  </Button>
                </div>
                <div
                  className="mt-2 text-xs"
                  style={{ color: pointsValid ? P.gl : P.ts }}
                >
                  = ¥{pointsNum.toLocaleString()} value
                </div>
                {pointsError && (
                  <div className="mt-1 text-xs" style={{ color: '#B85450' }}>
                    {pointsError}
                  </div>
                )}
              </div>

              {/* Notes */}
              <div>
                <Label htmlFor="notes" style={{ color: P.tp }}>
                  Notes <span style={{ color: P.ts }}>(optional)</span>
                </Label>
                <Textarea
                  id="notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Any details for our team to know"
                  rows={3}
                  className="mt-2"
                  style={{ background: P.s2, color: P.tp, borderColor: P.br }}
                />
              </div>

              {errorMsg && (
                <div
                  className="rounded-md px-3 py-2 text-sm"
                  style={{
                    background: '#3b1414',
                    border: '1px solid #B85450',
                    color: '#F5C9C9',
                  }}
                >
                  {errorMsg}
                </div>
              )}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onClose}
                  disabled={submitting}
                  style={{ color: P.ts }}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!formValid || submitting}
                  style={{
                    background: formValid ? P.gr : P.s2,
                    color: formValid ? '#1A1500' : P.ts,
                    fontWeight: 600,
                    border: 'none',
                  }}
                >
                  {submitting ? 'Submitting…' : 'Submit Redemption Request'}
                </Button>
              </div>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function InfoPanel({ redemptionType }: { redemptionType: RedemptionType | '' }) {
  const applyLine =
    redemptionType === 'new_order_discount'
      ? 'The discount will be applied to the order matching your invoice number'
      : redemptionType === 'shipping_fee'
        ? 'Your shipping fee will be covered using these points'
        : redemptionType === 'service_fee'
          ? 'Your service fee will be covered using these points'
          : 'The points will be applied to your order';
  return (
    <div
      className="rounded-md p-3 text-xs"
      style={{
        background: P.s2,
        border: `1px solid ${P.br}`,
        color: P.tp,
      }}
    >
      <div style={{ color: P.gl, fontWeight: 600 }}>💡 How it works</div>
      <ol className="mt-1 space-y-0.5 pl-4" style={{ color: P.ts, listStyle: 'decimal' }}>
        <li>Submit your request below</li>
        <li>Our team will review and approve</li>
        <li>{applyLine}</li>
        <li>You'll receive a confirmation email</li>
      </ol>
    </div>
  );
}

function SuccessView() {
  return (
    <div className="py-6 text-center">
      <div
        className="mx-auto flex h-16 w-16 items-center justify-center rounded-full text-3xl"
        style={{ background: P.s2, border: `1px solid ${P.gp}`, color: P.gl }}
      >
        ✓
      </div>
      <DialogTitle
        className="mt-4"
        style={{
          fontFamily: CG,
          color: P.tp,
          fontSize: '20px',
          letterSpacing: '0.02em',
        }}
      >
        Redemption request submitted!
      </DialogTitle>
      <p className="mt-2 text-sm" style={{ color: P.ts }}>
        We'll notify you once approved.
      </p>
    </div>
  );
}

export default RedemptionForm;
