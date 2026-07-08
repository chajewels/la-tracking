import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

const BENEFITS = [
  'Earn points on every purchase',
  '4 tiers up to 3× points multiplier',
  'Free international shipping',
  'Mystery gifts for VIPs',
];

export interface LoyaltyJoinPromptProps {
  portalToken: string;
  customerId: string;
  onJoined?: (memberId: string) => void;
}

export function LoyaltyJoinPrompt({ portalToken, customerId, onJoined }: LoyaltyJoinPromptProps) {
  const queryClient = useQueryClient();
  const [joining, setJoining] = useState(false);

  async function handleJoin() {
    setJoining(true);
    try {
      const { data, error } = await supabase.functions.invoke('join-loyalty-program', {
        body: { portal_token: portalToken },
      });
      if (error) throw error;

      const memberId = (data as any)?.member_id;
      if ((data as any)?.already_enrolled) {
        toast.success("You're already a member — welcome back");
      } else if ((data as any)?.enrolled) {
        toast.success('Welcome to Cha Jewels Loyalty');
      } else {
        toast.success('Joined the loyalty program');
      }

      await queryClient.invalidateQueries({ queryKey: ['loyalty-access', customerId] });
      onJoined?.(memberId);
    } catch (err: any) {
      toast.error(err?.message || 'Could not join right now — please try again');
    } finally {
      setJoining(false);
    }
  }

  return (
    <div className="loyalty-portal font-body mx-auto w-full max-w-md rounded-2xl p-6 sm:p-8 bg-card border-2 border-primary shadow-gold">
      <div className="mb-2 text-center text-2xl sm:text-3xl font-display" style={{ letterSpacing: '0.02em' }}>
        <span className="bg-clip-text text-transparent" style={{ backgroundImage: 'linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(var(--accent)) 50%, hsl(var(--primary)) 100%)' }}>
          Join Cha Jewels Loyalty
        </span>
      </div>

      <p className="mb-5 text-center text-sm text-muted-foreground">
        Earn rewards on every order — opt in once, redeem anytime.
      </p>

      <ul className="mb-6 space-y-2 text-sm text-foreground">
        {BENEFITS.map((b) => (
          <li key={b} className="flex items-start gap-2">
            <span className="text-primary">◆</span>
            <span>{b}</span>
          </li>
        ))}
      </ul>

      <Button
        onClick={handleJoin}
        disabled={joining}
        className="w-full font-semibold bg-primary text-primary-foreground border-none"
      >
        {joining ? 'Joining…' : 'Join Now'}
      </Button>
    </div>
  );
}

export default LoyaltyJoinPrompt;
