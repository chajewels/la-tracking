import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { CheckCircle, ChevronLeft, Loader2, Upload, X } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  CHA_PAYMENT_METHODS,
  type ChaPaymentMethod,
  PaymentMethodCard,
} from '@/lib/payment-methods';
import { getPHTToday } from '@/lib/date-utils';
import { getPortalSession } from '@/lib/portal-session';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Portal palette — must match src/pages/CustomerPortal.tsx
const P = {
  bg: '#0A0A0A', s: '#111111', s2: '#1A1A1A', br: '#2A2200',
  gp: '#C9A84C', gl: '#E8C96D', gd: '#8B6914',
  tp: '#F5F0E8', ts: '#9A8F7E',
  gr: 'linear-gradient(135deg,#C9A84C 0%,#E8C96D 50%,#C9A84C 100%)',
} as const;
const CG = "'Cormorant Garamond',Georgia,serif";
const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const ACCEPTED_MIME = 'image/png,image/jpeg,image/jpg,image/webp,application/pdf';

interface CashOrderArg {
  id: string;
  invoice_number: string;
  currency: 'PHP' | 'JPY';
  total_amount: number;
  total_paid: number;
  remaining_balance: number;
  expires_at?: string | null;
}

interface CashPortalPaymentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  cashOrder: CashOrderArg;
  customerName: string;
  portalToken: string;
  onSuccess: () => void;
}

function todayISODate() {
  return getPHTToday();
}

function safeForFilename(v: string | null | undefined) {
  return (v || '').replace(/[^a-zA-Z0-9]/g, '');
}

function fmt(amount: number, currency: 'PHP' | 'JPY'): string {
  const symbol = currency === 'JPY' ? '¥' : '₱';
  const n = Number(amount) || 0;
  if (currency === 'JPY') return `${symbol}${Math.round(n).toLocaleString()}`;
  return `${symbol}${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

export default function CashPortalPaymentDialog({
  isOpen, onClose, cashOrder, customerName, portalToken, onSuccess,
}: CashPortalPaymentDialogProps) {
  const remaining = Number(cashOrder.remaining_balance);
  const currency = cashOrder.currency;
  // Prefer the method group that matches the order currency
  const relevantGroup: 'PH' | 'JP' = currency === 'JPY' ? 'JP' : 'PH';

  // Form state
  const [amountInput, setAmountInput] = useState('');
  const [selectedMethodName, setSelectedMethodName] = useState<string>('');
  const [selectedChaMethod, setSelectedChaMethod] = useState<ChaPaymentMethod | null>(null);
  const [referenceNumber, setReferenceNumber] = useState('');
  const [paymentDate, setPaymentDate] = useState(todayISODate());
  const [senderName, setSenderName] = useState(customerName);
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [notes, setNotes] = useState('');
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // 'pick' = choosing payment method, 'form' = filling in submission, 'success' = done
  const [step, setStep] = useState<'pick' | 'form' | 'success'>('pick');

  // Reset when re-opened
  useEffect(() => {
    if (isOpen) {
      setAmountInput('');
      setSelectedMethodName('');
      setSelectedChaMethod(null);
      setReferenceNumber('');
      setPaymentDate(todayISODate());
      setSenderName(customerName);
      setProofFile(null);
      setNotes('');
      setCopiedField(null);
      setSubmitting(false);
      setFormError(null);
      setStep('pick');
    }
  }, [isOpen, customerName]);

  const amount = Number(amountInput) || 0;
  const exceedsRemaining = amount > remaining + 0.005;
  const today = todayISODate();
  const dateIsFuture = paymentDate > today;
  const proofTooLarge = !!proofFile && proofFile.size > MAX_PROOF_BYTES;

  const isFormValid =
    amount > 0 &&
    !exceedsRemaining &&
    !!selectedMethodName.trim() &&
    !!paymentDate &&
    !dateIsFuture &&
    !!senderName.trim() &&
    !proofTooLarge;

  const setPayFull = () => setAmountInput(String(Math.round(remaining * 100) / 100));

  const handleSelectMethod = (m: ChaPaymentMethod) => {
    setSelectedMethodName(m.name);
    setSelectedChaMethod(m);
    setStep('form');
    setFormError(null);
  };

  const uploadProof = useCallback(async (): Promise<string | null> => {
    if (!proofFile) return null;
    const timestamp = Date.now();
    const fileExt = (proofFile.name.split('.').pop() || 'jpg').toLowerCase();
    const uniqueFilePath = `${cashOrder.id}/${timestamp}_${safeForFilename(cashOrder.invoice_number)}_Cash.${fileExt}`;
    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/payment-proofs/${uniqueFilePath}`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': proofFile.type,
          'x-upsert': 'true',
        },
        body: proofFile,
      },
    );
    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw new Error(text || 'Proof upload failed');
    }
    return `${SUPABASE_URL}/storage/v1/object/public/payment-proofs/${uniqueFilePath}`;
  }, [proofFile, cashOrder.invoice_number, cashOrder.id]);

  const handleSubmit = async () => {
    setFormError(null);
    if (!isFormValid) return;
    setSubmitting(true);
    try {
      let proofUrl: string | null = null;
      if (proofFile) {
        try {
          proofUrl = await uploadProof();
        } catch (err: unknown) {
          setFormError(`Proof upload failed: ${(err as Error).message || 'unknown error'}`);
          setSubmitting(false);
          return;
        }
      }

      const sess = getPortalSession();
      const body: Record<string, unknown> = {
        ...(sess
          ? { session_id: sess.session_id }
          : { portal_token: portalToken }),
        cash_order_id: cashOrder.id,
        submitted_amount: amount,
        payment_method: selectedMethodName,
        payment_date: paymentDate,
        sender_name: senderName.trim(),
      };
      if (referenceNumber.trim()) body.reference_number = referenceNumber.trim();
      if (proofUrl) body.proof_url = proofUrl;
      if (notes.trim()) body.notes = notes.trim();

      const res = await fetch(`${SUPABASE_URL}/functions/v1/submit-cash-payment`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(json?.error || 'Submission failed. Please try again.');
        setSubmitting(false);
        return;
      }
      setStep('success');
      toast.success("Payment submitted for review. You'll be notified when confirmed.");
      onSuccess();
    } catch (err: unknown) {
      setFormError((err as Error).message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  // Method picker grouped by relevant currency
  const primaryMethods = CHA_PAYMENT_METHODS.filter(m => m.group === relevantGroup);
  const otherMethods = CHA_PAYMENT_METHODS.filter(m => m.group !== relevantGroup);

  const fieldLabel = { color: P.ts, fontSize: '10px', letterSpacing: '0.15em', textTransform: 'uppercase' as const, fontWeight: 600 };
  const inputStyle = { background: P.s, border: `1px solid ${P.br}`, borderRadius: '2px', color: P.tp };
  const helperStyle = { color: P.ts, fontSize: '11px' };
  const errorStyle = { color: '#E74C3C', fontSize: '11px' };

  return (
    <Sheet open={isOpen} onOpenChange={(open) => { if (!open && !submitting) onClose(); }}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-md overflow-y-auto p-0"
        style={{ background: P.bg, border: 'none', borderLeft: `1px solid ${P.gd}` }}
      >
        <SheetHeader className="px-5 pt-5 pb-3" style={{ borderBottom: `1px solid ${P.br}` }}>
          <SheetTitle style={{ color: P.gp, fontFamily: CG, fontSize: '18px', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600 }}>
            Submit Cash Payment
          </SheetTitle>
          <p style={{ color: P.ts, fontSize: '11px', fontFamily: 'Inter,sans-serif' }}>
            #{cashOrder.invoice_number} · Remaining {fmt(remaining, currency)}
          </p>
          {cashOrder.expires_at && (
            <p style={{ color: P.gp, fontSize: '10px', fontFamily: 'Inter,sans-serif', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              Pay by {new Date(cashOrder.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
          )}
        </SheetHeader>

        {step === 'success' ? (
          <div className="text-center py-10 px-5 space-y-5">
            <div style={{ width: '56px', height: '56px', margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(92,184,106,0.1)', border: '1px solid rgba(92,184,106,0.3)' }}>
              <CheckCircle style={{ color: '#5CB86A' }} className="h-8 w-8" />
            </div>
            <div>
              <h3 style={{ fontFamily: CG, fontSize: '22px', color: P.tp, marginBottom: '8px' }}>Payment Submitted</h3>
              <p style={{ fontFamily: 'Inter,sans-serif', fontSize: '13px', color: P.ts, maxWidth: '260px', margin: '0 auto', lineHeight: 1.6 }}>
                Your submission is pending verification by the Cha Jewels team.
                You'll be notified when confirmed.
              </p>
            </div>
            <button
              onClick={onClose}
              style={{ background: P.gr, border: 'none', borderRadius: '2px', color: P.bg, fontFamily: 'Inter,sans-serif', fontSize: '12px', fontWeight: 600, letterSpacing: '0.15em', textTransform: 'uppercase', cursor: 'pointer', padding: '12px 32px' }}
            >
              Close
            </button>
          </div>
        ) : step === 'pick' ? (
          <div className="px-5 py-4 space-y-4">
            <p style={{ color: P.ts, fontSize: '12px', fontFamily: 'Inter,sans-serif', lineHeight: 1.5 }}>
              Choose a payment method below. Account details are shown for your reference — copy what you need, then tap "Select &amp; Pay" to continue.
            </p>

            {primaryMethods.length > 0 && (
              <div className="space-y-3">
                <p style={fieldLabel}>
                  {relevantGroup === 'PH' ? 'Philippines' : 'Japan'}
                </p>
                {primaryMethods.map(method => (
                  <PaymentMethodCard
                    key={method.id}
                    method={method}
                    onSelect={() => handleSelectMethod(method)}
                    copiedField={copiedField}
                    setCopied={setCopiedField}
                  />
                ))}
              </div>
            )}

            {otherMethods.length > 0 && (
              <div className="space-y-3 pt-2">
                <p style={fieldLabel}>
                  {relevantGroup === 'PH' ? 'Japan (Other)' : 'Philippines (Other)'}
                </p>
                {otherMethods.map(method => (
                  <PaymentMethodCard
                    key={method.id}
                    method={method}
                    onSelect={() => handleSelectMethod(method)}
                    copiedField={copiedField}
                    setCopied={setCopiedField}
                  />
                ))}
              </div>
            )}

            <p style={{ color: P.ts, fontSize: '10px', lineHeight: 1.5, marginTop: '12px' }}>
              Your payment will be reviewed by the Cha Jewels team before being
              marked as received. You'll be notified once it's confirmed.
            </p>
          </div>
        ) : (
          <form
            onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}
            className="px-5 py-4 space-y-4"
          >
            {/* Selected method banner with change button */}
            {selectedChaMethod && (
              <div
                className="flex items-center gap-3 p-3"
                style={{ background: P.s, border: `1px solid ${P.br}`, borderLeft: `2px solid ${P.gp}`, borderRadius: '2px' }}
              >
                <div
                  style={{ width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(201,168,76,0.1)', color: P.gp, flexShrink: 0 }}
                >
                  {selectedChaMethod.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <p style={{ fontFamily: CG, fontSize: '14px', fontWeight: 600, color: P.tp, lineHeight: 1.2 }}>
                    {selectedChaMethod.name}
                  </p>
                  {selectedChaMethod.accountNumber && (
                    <p style={{ fontFamily: 'monospace', fontSize: '11px', color: P.ts }}>
                      {selectedChaMethod.accountNumber}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => { setStep('pick'); setSelectedMethodName(''); setSelectedChaMethod(null); }}
                  className="inline-flex items-center gap-1"
                  style={{ background: 'transparent', border: 'none', color: P.gp, fontFamily: 'Inter,sans-serif', fontSize: '10px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: 'pointer' }}
                >
                  <ChevronLeft className="h-3 w-3" /> Change
                </button>
              </div>
            )}

            {/* Amount */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label style={fieldLabel}>Amount *</Label>
                <button
                  type="button"
                  onClick={setPayFull}
                  disabled={remaining <= 0}
                  style={{ background: 'transparent', border: 'none', color: P.gp, fontSize: '11px', cursor: 'pointer', fontWeight: 500, letterSpacing: '0.05em' }}
                >
                  Pay Full Remaining
                </button>
              </div>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold pointer-events-none" style={{ color: P.ts }}>
                  {currency === 'JPY' ? '¥' : '₱'}
                </span>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  placeholder="0"
                  className="pl-8 tabular-nums"
                  style={inputStyle}
                />
              </div>
              <div className="flex items-center justify-between">
                <span style={helperStyle}>Remaining: {fmt(remaining, currency)}</span>
                {exceedsRemaining && <span style={errorStyle}>Exceeds remaining balance</span>}
              </div>
            </div>

            {/* Reference + Date */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label style={fieldLabel}>Reference #</Label>
                <Input
                  value={referenceNumber}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  placeholder="Transaction ref"
                  style={inputStyle}
                />
              </div>
              <div className="space-y-1.5">
                <Label style={fieldLabel}>Date *</Label>
                <Input
                  type="date"
                  value={paymentDate}
                  max={today}
                  onChange={(e) => setPaymentDate(e.target.value)}
                  style={inputStyle}
                />
                {dateIsFuture && <p style={errorStyle}>Cannot be in the future</p>}
              </div>
            </div>

            {/* Sender name */}
            <div className="space-y-1.5">
              <Label style={fieldLabel}>Sender Name *</Label>
              <Input
                value={senderName}
                onChange={(e) => setSenderName(e.target.value)}
                placeholder="Who sent this payment?"
                style={inputStyle}
              />
            </div>

            {/* Proof */}
            <div className="space-y-1.5">
              <Label style={fieldLabel}>Proof of Payment</Label>
              <div className="flex items-center gap-2">
                <label
                  htmlFor="cash-portal-proof"
                  className="flex-1 cursor-pointer px-3 py-2 text-xs transition-colors"
                  style={{ background: P.s, border: `1px dashed ${P.br}`, borderRadius: '2px', color: P.ts }}
                >
                  <span className="inline-flex items-center gap-2">
                    <Upload className="h-3.5 w-3.5" />
                    {proofFile ? proofFile.name : 'Attach image or PDF (5MB max)'}
                  </span>
                </label>
                {proofFile && (
                  <button
                    type="button"
                    onClick={() => setProofFile(null)}
                    style={{ background: 'transparent', border: 'none', color: P.ts, fontSize: '11px', cursor: 'pointer' }}
                  >
                    Remove
                  </button>
                )}
                <input
                  id="cash-portal-proof"
                  type="file"
                  accept={ACCEPTED_MIME}
                  onChange={(e) => setProofFile(e.target.files?.[0] || null)}
                  className="hidden"
                />
              </div>
              {proofTooLarge && <p style={errorStyle}>File exceeds 5MB</p>}
            </div>

            {/* Notes */}
            <div className="space-y-1.5">
              <Label style={fieldLabel}>Notes</Label>
              <textarea
                rows={2}
                maxLength={500}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything the reviewer should know…"
                className="w-full p-2 text-sm resize-none focus:outline-none"
                style={{ ...inputStyle, color: P.tp, fontFamily: 'Inter,sans-serif' }}
              />
            </div>

            {formError && (
              <div style={{ background: 'rgba(231,76,60,0.1)', border: '1px solid rgba(231,76,60,0.3)', borderRadius: '2px', padding: '8px 12px' }}>
                <p style={{ color: '#E74C3C', fontSize: '12px' }}>{formError}</p>
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                style={{ flex: 1, background: 'transparent', border: `1px solid ${P.br}`, borderRadius: '2px', color: P.ts, height: '44px', fontFamily: 'Inter,sans-serif', fontSize: '12px', fontWeight: 500, letterSpacing: '0.15em', textTransform: 'uppercase', cursor: submitting ? 'not-allowed' : 'pointer', opacity: submitting ? 0.5 : 1 }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || !isFormValid}
                style={{ flex: 1, background: P.gr, border: 'none', borderRadius: '2px', color: P.bg, height: '44px', fontFamily: 'Inter,sans-serif', fontSize: '12px', fontWeight: 600, letterSpacing: '0.15em', textTransform: 'uppercase', cursor: submitting || !isFormValid ? 'not-allowed' : 'pointer', opacity: submitting || !isFormValid ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
              >
                {submitting ? (<><Loader2 className="h-4 w-4 animate-spin" /> Submitting</>) : 'Submit'}
              </button>
            </div>

            <p style={{ color: P.ts, fontSize: '10px', lineHeight: 1.5, marginTop: '8px' }}>
              Your payment will be reviewed by the Cha Jewels team before being
              marked as received. You'll be notified once it's confirmed.
            </p>
          </form>
        )}
      </SheetContent>
    </Sheet>
  );
}
