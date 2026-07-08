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
import { supabase } from '@/integrations/supabase/client';
import { getPortalAuthHeaders } from '@/lib/portal-auth';
import { toast } from 'sonner';

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

  const [orders, setOrders] = useState<OrderOption[]>([]);
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
      setOrders([]);
      setInvoiceInput('');
    }
  }, [isOpen]);

  // Fetch the customer's orders only for new_order_discount (invoice→order
  // lookup). shipping_fee / service_fee are points-only — no fetch.
  useEffect(() => {
    if (!isOpen) return;
    if (redemptionType !== 'new_order_discount') return;
    let cancelled = false;
    (async () => {
      try {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
        const supabaseAnonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
        // Dual-auth (mirrors Phase B 4-B2): token-auth → ?token=X, no
        // Authorization; session-auth (email/password) → Bearer <session JWT>
        // via getPortalAuthHeaders. resolvePortalAuth Path 0/2 handles both.
        const authHeaders = await getPortalAuthHeaders(portalToken);
        const url = new URL(`${supabaseUrl}/functions/v1/customer-portal`);
        if (portalToken) url.searchParams.set('token', portalToken);

        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            apikey: supabaseAnonKey,
            ...authHeaders,
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
          console.error(
            '[RedemptionForm] orders fetch failed:',
            err?.message || err,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, portalToken, redemptionType]);

  const pointsNum = useMemo(() => {
    const n = Number(pointsInput);
    return Number.isFinite(n) ? Math.floor(n) : 0;
  }, [pointsInput]);

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
  const isPointsOnly =
    redemptionType === 'shipping_fee' || redemptionType === 'service_fee';
  const notesValid = notes.trim().length > 0 && notes.length <= 500;
  // new_order_discount → matched brand-new order required.
  // shipping_fee / service_fee → strictly points-only, notes required.
  const orderInputValid = redemptionType === 'new_order_discount'
    ? matchedOrder !== null
    : isPointsOnly
      ? notesValid
      : false;
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
      // Points-only types (shipping_fee / service_fee, owner rule 2026-05-19):
      // no FK, no invoice — body is action/type/points/notes only.
      let body: Record<string, unknown>;
      if (redemptionType === 'new_order_discount') {
        if (!matchedOrder) {
          setErrorMsg('Please enter a valid invoice number');
          setSubmitting(false);
          return;
        }
        body = {
          action: 'create',
          member_id: memberId,
          redemption_type: redemptionType,
          points_redeemed: pointsNum,
          invoice_number: matchedOrder.invoice_number,
          notes: notes.trim() || null,
          portal_token: portalToken,
          account_id:
            matchedOrder.kind === 'layaway' ? matchedOrder.id : null,
          cash_order_id:
            matchedOrder.kind === 'cash' ? matchedOrder.id : null,
        };
      } else {
        // shipping_fee / service_fee — strictly points-only
        body = {
          action: 'create',
          member_id: memberId,
          redemption_type: redemptionType,
          points_redeemed: pointsNum,
          notes: notes.trim(),
          portal_token: portalToken,
        };
      }

      const { data, error } = await supabase.functions.invoke(
        'process-loyalty-redemption',
        { body },
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
      let msg = err?.message || 'Could not submit redemption — please try again';
      // A non-2xx from functions.invoke THROWS, and the JSON body is on
      // err.context (a Response), not err.message. Surface the server's
      // message (e.g. the duplicate-redemption 409) when available.
      try {
        const ctx = err?.context;
        let parsed: any = null;
        if (ctx && typeof ctx.json === 'function') {
          parsed = await ctx.json();
        } else if (ctx?.body) {
          parsed = typeof ctx.body === 'string' ? JSON.parse(ctx.body) : ctx.body;
        }
        if (parsed?.message || parsed?.error) {
          msg = parsed.message || parsed.error;
        }
      } catch {
        /* keep the default msg */
      }
      setErrorMsg(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(o) => (!o && !submitting ? onClose() : undefined)}>
      <DialogContent
        className="loyalty-portal font-body max-w-md sm:max-w-lg max-h-[90dvh] flex flex-col p-0 gap-0 bg-card border-border text-foreground"
      >
        {submitted ? (
          <div className="px-6">
            <SuccessView />
          </div>
        ) : (
          <>
            {/* Sticky header */}
            <div className="px-6 pt-6 pb-4 shrink-0 border-b border-border">
              <DialogHeader>
                <DialogTitle className="font-display text-primary" style={{ fontSize: '24px', letterSpacing: '0.02em' }}>
                  Redeem Your Points
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  You have{' '}
                  <span className="text-primary font-semibold">
                    {remainingPoints.toLocaleString()}
                  </span>{' '}
                  points available. 1 point = ¥1 value.
                </DialogDescription>
              </DialogHeader>
            </div>

            <form
              className="flex flex-col flex-1 min-h-0"
              onSubmit={(e) => {
                e.preventDefault();
                handleSubmit();
              }}
            >
              {/* Scrollable body */}
              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
              <InfoPanel redemptionType={redemptionType} />
              {/* Redemption Type */}
              <div>
                <Label className="text-foreground">Redemption Type</Label>
                <RadioGroup
                  value={redemptionType}
                  onValueChange={(v) => setRedemptionType(v as RedemptionType)}
                  className="mt-2 space-y-2"
                >
                  {TYPE_OPTIONS.map((opt) => (
                    <label
                      key={opt.value}
                      htmlFor={`rt-${opt.value}`}
                      className={`flex cursor-pointer items-start gap-3 rounded-md p-3 border ${redemptionType === opt.value ? 'bg-secondary border-primary' : 'bg-transparent border-border'}`}
                    >
                      <RadioGroupItem id={`rt-${opt.value}`} value={opt.value} />
                      <div className="flex-1">
                        <div className="flex items-center gap-2 text-sm font-display text-foreground" style={{ fontSize: '15px' }}>
                          <span aria-hidden="true">{opt.icon}</span>
                          {opt.title}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
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
                  <Label htmlFor="invoice" className="text-foreground">
                    Invoice Number{' '}
                    <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="invoice"
                    value={invoiceInput}
                    onChange={(e) => setInvoiceInput(e.target.value)}
                    placeholder="e.g. 19012"
                    className="mt-2 bg-secondary text-foreground border-border"
                  />
                  <div className="mt-1 text-xs text-muted-foreground">
                    Enter the invoice number your team gave you for the new order.
                  </div>
                  {invoiceInput.trim() && !matchedOrder && (
                    <div className="mt-1 text-xs text-destructive">
                      Invoice not found among your brand-new orders.
                    </div>
                  )}
                  {matchedOrder && (
                    <div className="mt-1 text-xs text-primary">
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

              {/* Points-only notes — shipping_fee / service_fee (required) */}
              {(redemptionType === 'shipping_fee' ||
                redemptionType === 'service_fee') && (
                <div>
                  <Label htmlFor="pts-notes" className="text-foreground">
                    Notes{' '}
                    <span className="text-destructive">
                      (required for tracking &amp; notification)
                    </span>
                  </Label>
                  <Textarea
                    id="pts-notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={4}
                    maxLength={500}
                    placeholder="Describe what this shipping fee / service fee redemption is for. The admin will see this on review."
                    className="mt-2 bg-secondary text-foreground border-border"
                  />
                  <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                    <span>
                      {notes.trim().length === 0
                        ? 'Required — cannot submit without notes'
                        : 'These points-only redemptions never touch an order.'}
                    </span>
                    <span>{notes.length}/500</span>
                  </div>
                </div>
              )}

              {/* Points to Redeem */}
              <div>
                <Label htmlFor="points" className="text-foreground">
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
                  className="mt-2 bg-secondary text-foreground border-border"
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
                      className="bg-transparent text-foreground border-border"
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
                    className="bg-transparent text-primary border-primary"
                  >
                    All
                  </Button>
                </div>
                <div className={`mt-2 text-xs ${pointsValid ? 'text-primary' : 'text-muted-foreground'}`}>
                  = ¥{pointsNum.toLocaleString()} value
                </div>
                {pointsError && (
                  <div className="mt-1 text-xs text-destructive">
                    {pointsError}
                  </div>
                )}
              </div>

              {/* Notes (optional) — new_order_discount only; shipping/service
                  use the dedicated required-notes block above */}
              {redemptionType === 'new_order_discount' && (
                <div>
                  <Label htmlFor="notes" className="text-foreground">
                    Notes <span className="text-muted-foreground">(optional)</span>
                  </Label>
                  <Textarea
                    id="notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Any details for our team to know"
                    rows={3}
                    className="mt-2 bg-secondary text-foreground border-border"
                  />
                </div>
              )}

              {errorMsg && (
                <div className="rounded-md px-3 py-2 text-sm bg-destructive/10 border border-destructive text-destructive">
                  {errorMsg}
                </div>
              )}
              </div>

              {/* Sticky footer */}
              <div className="px-6 py-4 shrink-0 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end border-t border-border bg-card">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onClose}
                  disabled={submitting}
                  className="text-muted-foreground"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!formValid || submitting}
                  className="font-semibold bg-primary text-primary-foreground disabled:bg-secondary disabled:text-muted-foreground border-none"
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
    <div className="rounded-md p-3 text-xs bg-secondary border border-border text-foreground">
      <div className="text-primary font-semibold">💡 How it works</div>
      <ol className="mt-1 space-y-0.5 pl-4 text-muted-foreground" style={{ listStyle: 'decimal' }}>
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
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full text-3xl bg-secondary border border-primary text-primary">
        ✓
      </div>
      <DialogTitle className="mt-4 font-display text-foreground" style={{ fontSize: '20px', letterSpacing: '0.02em' }}>
        Redemption request submitted!
      </DialogTitle>
      <p className="mt-2 text-sm text-muted-foreground">
        We'll notify you once approved.
      </p>
    </div>
  );
}

export default RedemptionForm;
