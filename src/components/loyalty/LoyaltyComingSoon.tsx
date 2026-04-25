import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

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
const CG = "'Cormorant Garamond',Georgia,serif";

export interface LoyaltyComingSoonProps {
  customerEmail?: string | null;
  customerId?: string | null;
  onDismiss?: () => void;
}

export function LoyaltyComingSoon({
  customerEmail,
  customerId,
  onDismiss,
}: LoyaltyComingSoonProps) {
  const [email, setEmail] = useState(customerEmail ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleNotify() {
    const trimmed = email.trim();
    if (!trimmed) {
      toast.error('Enter an email to be notified');
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await supabase
        .from('notify_loyalty_launch')
        .insert({ email: trimmed, customer_id: customerId ?? null });
      if (error && !String(error.message).toLowerCase().includes('duplicate')) {
        throw error;
      }
      setSubmitted(true);
      toast.success("You're on the list — we'll email you at launch");
    } catch (err: any) {
      toast.error(err?.message || 'Could not save your email');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="relative mx-auto w-full max-w-md rounded-2xl p-6 sm:p-8"
      style={{
        background: P.s,
        border: `1px solid ${P.br}`,
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
      }}
    >
      {onDismiss && (
        <button
          aria-label="Dismiss"
          onClick={onDismiss}
          className="absolute right-3 top-3 text-lg leading-none"
          style={{ color: P.ts }}
        >
          ×
        </button>
      )}

      <div className="text-center">
        <div
          className="mb-3 text-3xl sm:text-4xl"
          style={{ fontFamily: CG, color: P.tp, letterSpacing: '0.02em' }}
        >
          <span style={{ background: P.gr, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            💎 Cha Jewels Loyalty Program
          </span>
        </div>

        <p className="mb-5 text-sm sm:text-base" style={{ color: P.ts, lineHeight: 1.6 }}>
          Coming soon! Our loyalty program is launching soon — stay tuned for
          exclusive rewards, tier benefits, and points on every purchase.
        </p>

        {!submitted ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              className="text-sm"
              style={{
                background: P.s2,
                color: P.tp,
                borderColor: P.br,
              }}
            />
            <Button
              onClick={handleNotify}
              disabled={submitting}
              className="shrink-0"
              style={{
                background: P.gr,
                color: '#1A1500',
                fontWeight: 600,
                border: 'none',
              }}
            >
              {submitting ? 'Saving…' : 'Notify Me'}
            </Button>
          </div>
        ) : (
          <div
            className="rounded-md px-3 py-2 text-sm"
            style={{ background: P.s2, color: P.gl, border: `1px solid ${P.br}` }}
          >
            ✓ You're on the list
          </div>
        )}
      </div>
    </div>
  );
}

export default LoyaltyComingSoon;
