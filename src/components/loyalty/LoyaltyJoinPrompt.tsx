import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { getPortalSession } from '@/lib/portal-session';

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
      const sess = getPortalSession();
      const { data, error } = await supabase.functions.invoke('join-loyalty-program', {
        body: sess
          ? { session_id: sess.session_id }
          : { portal_token: portalToken },
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
    <div
      className="mx-auto w-full max-w-md rounded-2xl p-6 sm:p-8"
      style={{
        background: P.s,
        border: `2px solid ${P.gp}`,
        boxShadow: `0 4px 32px ${P.gp}33`,
      }}
    >
      <div
        className="mb-2 text-center text-2xl sm:text-3xl"
        style={{ fontFamily: CG, color: P.tp, letterSpacing: '0.02em' }}
      >
        <span style={{ background: P.gr, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          Join Cha Jewels Loyalty
        </span>
      </div>

      <p className="mb-5 text-center text-sm" style={{ color: P.ts }}>
        Earn rewards on every order — opt in once, redeem anytime.
      </p>

      <ul className="mb-6 space-y-2 text-sm" style={{ color: P.tp }}>
        {BENEFITS.map((b) => (
          <li key={b} className="flex items-start gap-2">
            <span style={{ color: P.gl }}>◆</span>
            <span>{b}</span>
          </li>
        ))}
      </ul>

      <Button
        onClick={handleJoin}
        disabled={joining}
        className="w-full"
        style={{
          background: P.gr,
          color: '#1A1500',
          fontWeight: 600,
          border: 'none',
        }}
      >
        {joining ? 'Joining…' : 'Join Now'}
      </Button>
    </div>
  );
}

export default LoyaltyJoinPrompt;
