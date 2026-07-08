import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { pt } from '@/i18n/portal';

const BENEFIT_KEYS = [
  'loyalty.benefitPoints',
  'loyalty.benefitTiers',
  'loyalty.benefitShipping',
  'loyalty.benefitGifts',
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
        toast.success(pt('loyalty.alreadyMember'));
      } else if ((data as any)?.enrolled) {
        toast.success(pt('loyalty.welcomeJoin'));
      } else {
        toast.success(pt('loyalty.joinedGeneric'));
      }

      await queryClient.invalidateQueries({ queryKey: ['loyalty-access', customerId] });
      onJoined?.(memberId);
    } catch (err: any) {
      toast.error(err?.message || pt('loyalty.errJoin'));
    } finally {
      setJoining(false);
    }
  }

  return (
    <div className="loyalty-portal font-body mx-auto w-full max-w-md rounded-2xl p-6 sm:p-8 bg-card border-2 border-primary shadow-gold">
      <div className="mb-2 text-center text-2xl sm:text-3xl font-display" style={{ letterSpacing: '0.02em' }}>
        <span className="bg-clip-text text-transparent" style={{ backgroundImage: 'linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(var(--accent)) 50%, hsl(var(--primary)) 100%)' }}>
          {pt('loyalty.joinTitle')}
        </span>
      </div>

      <p className="mb-5 text-center text-sm text-muted-foreground">
        {pt('loyalty.joinSubtitle')}
      </p>

      <ul className="mb-6 space-y-2 text-sm text-foreground">
        {BENEFIT_KEYS.map((key) => (
          <li key={key} className="flex items-start gap-2">
            <span className="text-primary">◆</span>
            <span>{pt(key)}</span>
          </li>
        ))}
      </ul>

      <Button
        onClick={handleJoin}
        disabled={joining}
        className="w-full font-semibold bg-primary text-primary-foreground border-none"
      >
        {joining ? pt('loyalty.joining') : pt('loyalty.joinNow')}
      </Button>
    </div>
  );
}

export default LoyaltyJoinPrompt;
