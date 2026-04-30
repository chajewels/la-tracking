import { motion } from 'framer-motion';
import { Lock, ArrowRight, Sparkles } from 'lucide-react';
import { useLoyaltyData } from '@/components/loyalty/loyaltyData';
import { type FallbackReward } from '@/components/loyalty/staticFallback';

type VaultAccess = 'locked' | 'limited' | 'full' | 'premium';

interface VipRewardsVaultProps {
  vaultRewards: FallbackReward[];
  onSelectReward: (reward: FallbackReward) => void;
}

const VipRewardsVault = ({ vaultRewards, onSelectReward }: VipRewardsVaultProps) => {
  const { member, tiers } = useLoyaltyData();
  if (!member || !tiers || tiers.length === 0) return null;

  const currentTierIndex = tiers.findIndex((t) => t.name === member.current_tier);

  const getVaultAccess = (): VaultAccess => {
    if (currentTierIndex >= 3) return 'premium'; // Crown VIP
    if (currentTierIndex >= 2) return 'full';    // Elite
    if (currentTierIndex >= 1) return 'limited'; // Radiant
    return 'locked';                              // Glimmer
  };

  const canAccessReward = (reward: FallbackReward) => {
    if (reward.tier === 'All') return true;
    const rewardTierIndex = tiers.findIndex((t) => t.name === reward.tier);
    return currentTierIndex >= rewardTierIndex;
  };

  const vaultAccess = getVaultAccess();

  // Empty vault: render nothing rather than an empty section
  if (vaultRewards.length === 0 && vaultAccess !== 'locked') {
    return null;
  }

  const accessLabel = {
    locked: 'Locked',
    limited: 'Limited Access',
    full: 'Full Access',
    premium: 'Premium Access',
  }[vaultAccess];

  if (vaultAccess === 'locked') {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-primary" />
          <h3 className="font-display text-lg font-semibold text-foreground">VIP Rewards Vault</h3>
        </div>
        <div className="relative bg-card rounded-2xl p-6 shadow-card border-gold-accent overflow-hidden">
          <div className="absolute inset-0 backdrop-blur-sm bg-card/80 z-10 flex flex-col items-center justify-center">
            <Lock size={28} className="text-primary/40 mb-3" />
            <p className="font-display text-base font-semibold text-foreground">VIP Rewards Vault</p>
            <p className="text-[12px] text-muted-foreground font-body mt-1.5 text-center px-6">
              Unlock exclusive rewards when you reach{' '}
              <span className="text-primary font-semibold">Elite Member</span>.
            </p>
          </div>
          <div className="opacity-30 space-y-3">
            {vaultRewards.slice(0, 3).map((r) => (
              <div key={r.id} className="bg-background/40 rounded-xl p-3 h-16" />
            ))}
            {vaultRewards.length === 0 && [...Array(3)].map((_, i) => (
              <div key={`ph-${i}`} className="bg-background/40 rounded-xl p-3 h-16" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-primary" />
          <h3 className="font-display text-lg font-semibold text-foreground">VIP Rewards Vault</h3>
        </div>
        <span className="text-[10px] tracking-[0.2em] uppercase gradient-gold text-primary-foreground px-2 py-0.5 rounded-full font-body font-semibold">
          {accessLabel}
        </span>
      </div>

      <div className="space-y-2.5">
        {vaultRewards.map((reward) => {
          const accessible = canAccessReward(reward);
          const affordable = member.available_points >= reward.pointsCost;
          return (
            <motion.button
              key={reward.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              onClick={() => accessible && onSelectReward(reward)}
              className={`w-full text-left bg-card rounded-xl p-4 shadow-card border-gold-accent transition-all ${
                !accessible ? 'opacity-40' : 'hover:shadow-soft'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    {reward.isLimited && (
                      <span className="text-[10px] tracking-[0.2em] uppercase text-primary font-body font-semibold bg-primary/10 px-1.5 py-0.5 rounded-full">
                        Limited
                      </span>
                    )}
                    {reward.isVipOnly && (
                      <span className="text-[10px] tracking-[0.2em] uppercase font-body font-semibold gradient-gold text-primary-foreground px-1.5 py-0.5 rounded-full">
                        Crown VIP
                      </span>
                    )}
                    <span className="text-[10px] tracking-[0.15em] uppercase text-muted-foreground font-body bg-muted px-1.5 py-0.5 rounded-full">
                      Vault
                    </span>
                  </div>
                  <h4 className="font-display text-base font-semibold text-foreground">
                    {reward.name}
                  </h4>
                  <p className="text-[12px] text-muted-foreground font-body mt-1 line-clamp-2">
                    {reward.description}
                  </p>
                </div>
                <div className="flex flex-col items-end ml-3">
                  {!accessible ? (
                    <Lock size={16} className="text-muted-foreground" />
                  ) : (
                    <div className="text-right">
                      <p className="font-display text-lg font-bold text-foreground">
                        {reward.pointsCost.toLocaleString()}
                      </p>
                      <p className="text-[11px] text-muted-foreground font-body">points</p>
                    </div>
                  )}
                </div>
              </div>
              {accessible && affordable && (
                <div className="flex items-center gap-1 mt-3 text-primary">
                  <span className="text-[12px] font-body font-semibold">Redeem Now</span>
                  <ArrowRight size={10} />
                </div>
              )}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
};

export default VipRewardsVault;
