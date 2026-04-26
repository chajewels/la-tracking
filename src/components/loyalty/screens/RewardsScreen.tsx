import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Lock, Check, ArrowRight, X } from 'lucide-react';
import { useLoyaltyData } from '@/components/loyalty/loyaltyData';
import { REWARDS, type FallbackReward } from '@/components/loyalty/staticFallback';
import VipRewardsVault from '@/components/loyalty/rewards/VipRewardsVault';

const categories = [
  'All',
  'Redeem with Points',
  'Tier Exclusive',
  'Shipping Rewards',
  'Member-Only Offers',
];

export default function RewardsScreen() {
  const { member, tiers } = useLoyaltyData();
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [selectedReward, setSelectedReward] = useState<FallbackReward | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);

  if (!member || !tiers || tiers.length === 0) return null;

  const currentTierIndex = tiers.findIndex((t) => t.name === member.current_tier);

  const canRedeem = (reward: FallbackReward) => {
    if (reward.tier === 'All') return true;
    const rewardTierIndex = tiers.findIndex((t) => t.name === reward.tier);
    return currentTierIndex >= rewardTierIndex;
  };

  const filtered = REWARDS.filter((r) => !r.isVault).filter((r) =>
    selectedCategory === 'All' ? true : r.category === selectedCategory,
  );

  // TODO: wire to RedemptionForm submit for actual redemption processing
  const handleRedeem = () => {
    setSelectedReward(null);
    setShowSuccess(true);
    setTimeout(() => setShowSuccess(false), 3000);
  };

  return (
    <>
      <div className="px-5 pt-6 pb-4 space-y-6">
        <div>
          <p className="text-[10px] text-muted-foreground font-body tracking-[0.2em] uppercase">
            Cha Jewels Rewards
          </p>
          <h1 className="font-display text-2xl font-semibold text-foreground mt-1">Rewards</h1>
          <p className="text-[11px] text-muted-foreground font-body mt-1">
            You have{' '}
            <span className="text-primary font-semibold">
              {member.available_points.toLocaleString()} points
            </span>{' '}
            to redeem
          </p>
        </div>

        {/* Redemption info */}
        <div className="bg-primary/5 rounded-xl p-3.5 border border-primary/10">
          <p className="text-[10px] text-muted-foreground font-body leading-relaxed">
            Redeem points on{' '}
            <span className="font-semibold text-foreground">regular items</span>,{' '}
            <span className="font-semibold text-foreground">layaway purchases</span>, and{' '}
            <span className="font-semibold text-foreground">discounted items</span>. Points are
            non-transferable and cannot be exchanged for cash.
          </p>
        </div>

        {/* Category Filters */}
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-5 px-5 scrollbar-hide">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`px-3 py-1.5 rounded-full text-[11px] font-body font-medium whitespace-nowrap transition-colors ${
                selectedCategory === cat
                  ? 'gradient-gold text-primary-foreground shadow-sm'
                  : 'bg-card text-muted-foreground shadow-card border-gold-accent'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Rewards Grid */}
        <div className="space-y-3">
          {filtered.map((reward) => {
            const unlocked = canRedeem(reward);
            const affordable = member.available_points >= reward.pointsCost;
            return (
              <motion.button
                key={reward.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                onClick={() => unlocked && setSelectedReward(reward)}
                className={`w-full text-left bg-card rounded-xl p-4 shadow-card border-gold-accent transition-all ${
                  !unlocked ? 'opacity-50' : 'hover:shadow-soft'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      {reward.isLimited && (
                        <span className="text-[8px] tracking-[0.2em] uppercase text-primary font-body font-semibold bg-primary/10 px-1.5 py-0.5 rounded-full">
                          Limited
                        </span>
                      )}
                      {reward.isVipOnly && (
                        <span className="text-[8px] tracking-[0.2em] uppercase font-body font-semibold gradient-gold text-primary-foreground px-1.5 py-0.5 rounded-full">
                          Crown VIP
                        </span>
                      )}
                      {reward.tier !== 'All' && !reward.isVipOnly && (
                        <span className="text-[8px] tracking-[0.15em] uppercase text-muted-foreground font-body bg-muted px-1.5 py-0.5 rounded-full">
                          {reward.tier}+
                        </span>
                      )}
                    </div>
                    <h3 className="font-display text-base font-semibold text-foreground">
                      {reward.name}
                    </h3>
                    <p className="text-[10px] text-muted-foreground font-body mt-1 line-clamp-2">
                      {reward.description}
                    </p>
                  </div>
                  <div className="flex flex-col items-end ml-3">
                    {!unlocked ? (
                      <Lock size={16} className="text-muted-foreground" />
                    ) : (
                      <div className="text-right">
                        <p className="font-display text-lg font-bold text-foreground">
                          {reward.pointsCost === 0
                            ? 'Free'
                            : reward.pointsCost.toLocaleString()}
                        </p>
                        {reward.pointsCost > 0 && (
                          <p className="text-[9px] text-muted-foreground font-body">points</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {unlocked && affordable && reward.pointsCost > 0 && (
                  <div className="flex items-center gap-1 mt-3 text-primary">
                    <span className="text-[10px] font-body font-semibold">Redeem Now</span>
                    <ArrowRight size={10} />
                  </div>
                )}
                {unlocked && !affordable && reward.pointsCost > 0 && (
                  <p className="text-[10px] text-muted-foreground font-body mt-3">
                    You need{' '}
                    {(reward.pointsCost - member.available_points).toLocaleString()} more
                    points
                  </p>
                )}
              </motion.button>
            );
          })}
        </div>

        {/* VIP Rewards Vault */}
        <VipRewardsVault onSelectReward={(r) => setSelectedReward(r)} />

        <p className="text-center text-[9px] text-muted-foreground/50 font-body italic pb-2">
          Your points, your perks, your tier
        </p>
      </div>

      {/* Reward Detail Modal */}
      <AnimatePresence>
        {selectedReward && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-foreground/30 backdrop-blur-sm z-50 flex items-end justify-center"
            onClick={() => setSelectedReward(null)}
          >
            <motion.div
              initial={{ y: 300 }}
              animate={{ y: 0 }}
              exit={{ y: 300 }}
              transition={{ type: 'spring', damping: 25 }}
              className="bg-card rounded-t-3xl w-full max-w-lg p-6 space-y-5"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <h2 className="font-display text-xl font-semibold text-foreground">
                  {selectedReward.name}
                </h2>
                <button onClick={() => setSelectedReward(null)} className="p-1">
                  <X size={18} className="text-muted-foreground" />
                </button>
              </div>
              <p className="text-sm text-muted-foreground font-body leading-relaxed">
                {selectedReward.description}
              </p>

              <div className="bg-background rounded-xl p-4 text-center border-gold-accent">
                <p className="text-[10px] text-muted-foreground font-body tracking-wider uppercase">
                  Points Required
                </p>
                <p className="font-display text-3xl font-bold text-foreground mt-1">
                  {selectedReward.pointsCost === 0
                    ? 'Free'
                    : selectedReward.pointsCost.toLocaleString()}
                </p>
                <p className="text-[11px] text-muted-foreground font-body mt-1">
                  Your balance:{' '}
                  <span className="text-primary font-semibold">
                    {member.available_points.toLocaleString()}
                  </span>{' '}
                  points
                </p>
              </div>

              {member.available_points >= selectedReward.pointsCost ? (
                <button
                  onClick={handleRedeem}
                  className="w-full py-3.5 gradient-gold text-primary-foreground rounded-xl font-body text-sm font-semibold shadow-gold"
                >
                  Confirm Redemption
                </button>
              ) : (
                <button
                  disabled
                  className="w-full py-3.5 bg-muted text-muted-foreground rounded-xl font-body text-sm font-medium"
                >
                  Insufficient Points
                </button>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Redemption Success */}
      <AnimatePresence>
        {showSuccess && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-background/95 z-50 flex flex-col items-center justify-center"
          >
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.2, type: 'spring' }}
              className="text-center space-y-4 px-8"
            >
              <div className="w-16 h-16 rounded-full gradient-gold flex items-center justify-center mx-auto shadow-gold">
                <Check size={28} className="text-primary-foreground" />
              </div>
              <h2 className="font-display text-2xl font-semibold text-foreground">
                Redemption Successful!
              </h2>
              <p className="text-sm text-muted-foreground font-body">
                Your reward has been claimed. Thank you for choosing Cha Jewels Japan Gold! ✨
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
