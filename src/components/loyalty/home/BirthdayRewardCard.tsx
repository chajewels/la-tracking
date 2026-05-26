import { useState } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { getPortalAuthHeaders } from '@/lib/portal-auth';

interface BirthdayRewardCardProps {
  birthdayReward: { bonus_points: number; claimable: boolean } | null;
  portalToken: string;
  onClaimed: () => void;
}

export default function BirthdayRewardCard({
  birthdayReward,
  portalToken,
  onClaimed,
}: BirthdayRewardCardProps) {
  const [claiming, setClaiming] = useState(false);

  if (!birthdayReward?.claimable) return null;
  const bonus = birthdayReward.bonus_points;

  const handleClaim = async () => {
    setClaiming(true);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseAnonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      const authHeaders = await getPortalAuthHeaders(portalToken);
      const res = await fetch(`${supabaseUrl}/functions/v1/customer-portal`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabaseAnonKey,
          ...authHeaders,
        },
        body: JSON.stringify({ token: portalToken || undefined, action: 'redeem_birthday' }),
      });
      const payload = await res.json().catch(() => ({} as any));
      if (!res.ok || payload?.error) {
        toast.error(payload?.error || `Failed to claim birthday reward (HTTP ${res.status})`);
        return;
      }
      toast.success(`🎂 ${bonus.toLocaleString('en-US')} birthday points added!`);
      onClaimed();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to claim birthday reward');
    } finally {
      setClaiming(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.6 }}
      className="w-full bg-gradient-to-r from-primary/8 via-accent/12 to-primary/5 rounded-2xl p-4 shadow-card border-gold-accent flex items-center gap-4"
    >
      <div className="w-12 h-12 rounded-full gradient-gold flex items-center justify-center flex-shrink-0 shadow-gold animate-golden-pulse">
        <span className="text-xl">🎂</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-display text-[15px] font-semibold text-foreground">
          Happy Birthday Month! 🎉
        </p>
        <p className="text-[13px] text-muted-foreground font-body mt-0.5 leading-relaxed">
          Your birthday gift is ready — claim your bonus points and celebrate with Cha Jewels!
        </p>
        <div className="flex items-center gap-2 mt-2">
          <span className="text-[11px] gradient-gold text-primary-foreground px-2 py-0.5 rounded-full font-body font-semibold">
            {bonus.toLocaleString('en-US')} Bonus Points
          </span>
        </div>
      </div>
      <button
        onClick={handleClaim}
        disabled={claiming}
        className="flex-shrink-0 gradient-gold text-primary-foreground font-body font-semibold text-[13px] px-4 py-2 rounded-full shadow-gold disabled:opacity-60"
      >
        {claiming ? 'Claiming…' : 'Redeem'}
      </button>
    </motion.div>
  );
}
