import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

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
    <div className="loyalty-portal font-body relative mx-auto w-full max-w-md rounded-2xl p-6 sm:p-8 bg-card shadow-elevated">
      {onDismiss && (
        <button
          aria-label="Dismiss"
          onClick={onDismiss}
          className="absolute right-3 top-3 text-lg leading-none text-muted-foreground"
        >
          ×
        </button>
      )}

      <div className="text-center">
        <div className="mb-3 text-3xl sm:text-4xl font-display" style={{ letterSpacing: '0.02em' }}>
          <span className="bg-clip-text text-transparent" style={{ backgroundImage: 'linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(var(--accent)) 50%, hsl(var(--primary)) 100%)' }}>
            💎 Cha Jewels Loyalty Program
          </span>
        </div>

        <p className="mb-5 text-sm sm:text-base text-muted-foreground" style={{ lineHeight: 1.6 }}>
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
              className="text-sm bg-secondary text-foreground border-border"
            />
            <Button
              onClick={handleNotify}
              disabled={submitting}
              className="shrink-0 font-semibold bg-primary text-primary-foreground border-none"
            >
              {submitting ? 'Saving…' : 'Notify Me'}
            </Button>
          </div>
        ) : (
          <div className="rounded-md px-3 py-2 text-sm bg-secondary text-primary border border-border">
            ✓ You're on the list
          </div>
        )}
      </div>
    </div>
  );
}

export default LoyaltyComingSoon;
