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
    description: 'Pay shipping cost on a new order',
  },
  {
    value: 'service_fee',
    icon: '🛠️',
    title: 'Service Fee',
    description: 'Pay service charges on a new order',
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
  onSuccess,
}: RedemptionFormProps) {
  const [redemptionType, setRedemptionType] = useState<RedemptionType | ''>('');
  const [pointsInput, setPointsInput] = useState<string>('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Reset form whenever the dialog opens.
  useEffect(() => {
    if (isOpen) {
      setRedemptionType('');
      setPointsInput('');
      setInvoiceNumber('');
      setNotes('');
      setSubmitting(false);
      setSubmitted(false);
      setErrorMsg(null);
    }
  }, [isOpen]);

  const pointsNum = useMemo(() => {
    const n = Number(pointsInput);
    return Number.isFinite(n) ? Math.floor(n) : 0;
  }, [pointsInput]);

  const pointsValid = pointsNum > 0 && pointsNum <= remainingPoints;
  const invoiceValid = invoiceNumber.trim().length > 0;
  const typeValid = redemptionType !== '';
  const formValid = pointsValid && invoiceValid && typeValid;

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
      const { data, error } = await supabase.functions.invoke(
        'process-loyalty-redemption',
        {
          body: {
            action: 'create',
            member_id: memberId,
            redemption_type: redemptionType,
            points_redeemed: pointsNum,
            invoice_number: invoiceNumber.trim(),
            notes: notes.trim() || null,
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

            <InfoPanel />

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

              {/* Invoice Number */}
              <div>
                <Label htmlFor="invoice" style={{ color: P.tp }}>
                  Invoice Number
                </Label>
                <Input
                  id="invoice"
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  placeholder="e.g. 19012"
                  className="mt-2"
                  style={{ background: P.s2, color: P.tp, borderColor: P.br }}
                />
                <div className="mt-1 text-xs" style={{ color: P.ts }}>
                  Invoice number for the NEW order this redemption applies to
                </div>
                <div
                  className="mt-2 rounded-md px-3 py-2 text-xs"
                  style={{
                    background: P.s2,
                    border: `1px solid ${P.br}`,
                    color: P.gl,
                  }}
                >
                  ⚠ This must be a NEW order. Points cannot be applied to
                  existing in-progress accounts.
                </div>
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

function InfoPanel() {
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
        <li>The discount will be applied to your new order</li>
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
