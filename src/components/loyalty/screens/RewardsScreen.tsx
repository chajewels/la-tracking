import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Lock, Check, ArrowRight, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useLoyaltyData } from '@/components/loyalty/loyaltyData';
import { type FallbackReward } from '@/components/loyalty/staticFallback';
import { useLoyaltyRewardsCatalog, type LoyaltyRewardRow } from '@/hooks/loyalty-admin/useLoyaltyRewards';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import VipRewardsVault from '@/components/loyalty/rewards/VipRewardsVault';

/**
 * Adapter: DB row → existing FallbackReward shape so the existing
 * UI logic (canRedeem, badges, redeem flow) keeps working unchanged.
 * currentStock is propagated so the modal/grid can render stock
 * indicators and gate the Confirm button.
 */
function rowToReward(r: LoyaltyRewardRow): FallbackReward {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? '',
    pointsCost: r.points_cost,
    category: r.category,
    tier: r.tier_visibility,
    isLimited: r.is_limited,
    isVipOnly: r.is_vip_only,
    isVault: r.is_vault,
    currentStock: r.current_stock,
  };
}

function inStock(reward: FallbackReward): boolean {
  return reward.currentStock == null || reward.currentStock > 0;
}

const categories = [
  'All',
  'Redeem with Points',
  'Tier Exclusive',
  'Shipping Rewards',
  'Member-Only Offers',
];

export default function RewardsScreen() {
  const { member, tiers } = useLoyaltyData();
  const queryClient = useQueryClient();
  const { data: rewardRows, isLoading } = useLoyaltyRewardsCatalog();
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [selectedReward, setSelectedReward] = useState<FallbackReward | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const [invoiceInput, setInvoiceInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const allRewards = useMemo<FallbackReward[]>(
    () => (rewardRows ?? []).map(rowToReward),
    [rewardRows],
  );
  const vaultRewards = useMemo(
    () => allRewards.filter((r) => r.isVault),
    [allRewards],
  );

  if (!member || !tiers || tiers.length === 0) return null;

  const currentTierIndex = tiers.findIndex((t) => t.name === member.current_tier);

  const canRedeem = (reward: FallbackReward) => {
    if (reward.tier === 'All') return true;
    const rewardTierIndex = tiers.findIndex((t) => t.name === reward.tier);
    return currentTierIndex >= rewardTierIndex;
  };

  const filtered = allRewards
    .filter((r) => !r.isVault)
    .filter((r) =>
      selectedCategory === 'All' ? true : r.category === selectedCategory,
    );

  function closeModal() {
    if (submitting) return;
    setSelectedReward(null);
    setInvoiceInput('');
  }

  async function handleRedeem() {
    if (!selectedReward || !member || submitting) return;
    if (member.available_points < selectedReward.pointsCost) return;
    if (!inStock(selectedReward)) return;

    // Token-auth customers use legacy ?token=X URL params; backend's
    // resolvePortalAuth Path 2 validates against customer_portal_tokens.
    // Migrated session-auth customers don't need this (supabase.functions
    // .invoke attaches their JWT automatically — Path 0). Empty/null
    // token is harmless: helper falls through path-by-path.
    const portalToken = new URLSearchParams(window.location.search).get('token');

    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        'process-loyalty-redemption',
        {
          body: {
            action: 'create',
            member_id: (member as any).id,
            reward_id: selectedReward.id,
            redemption_type: 'catalog_reward',
            points_redeemed: selectedReward.pointsCost,
            invoice_number: invoiceInput.trim() || null,
            portal_token: portalToken,
          },
        },
      );
      if (error) throw error;
      const errFromBody = (data as any)?.error as string | undefined;
      if (errFromBody) {
        const status = (data as any)?.status ?? 0;
        if (status === 409 || /out of stock|raced/i.test(errFromBody)) {
          throw new Error('This reward just sold out, please pick another');
        }
        if (/mismatch/i.test(errFromBody)) {
          throw new Error(
            'Reward configuration changed since you opened this card. Please refresh and try again.',
          );
        }
        throw new Error(errFromBody);
      }

      setSelectedReward(null);
      setInvoiceInput('');
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);

      // Refresh stock + customer-loyalty caches so the catalog updates
      // if stock dropped (only happens on approval, but doesn't hurt
      // to refetch in case admin processed quickly).
      queryClient.invalidateQueries({ queryKey: ['loyalty-rewards-catalog'] });
      if ((member as any).customer_id) {
        queryClient.invalidateQueries({
          queryKey: ['customer-loyalty', (member as any).customer_id],
        });
      }
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      if (/sold out|out of stock|raced/i.test(msg)) {
        toast.error('This reward just sold out, please pick another');
      } else if (/mismatch|configuration changed/i.test(msg)) {
        toast.error(
          'Reward configuration changed. Please refresh and try again.',
        );
      } else if (/insufficient/i.test(msg)) {
        toast.error('Insufficient points');
      } else {
        toast.error(msg || 'Could not submit redemption');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="px-5 pt-6 pb-4 space-y-6">
        <div>
          <p className="text-[12px] text-muted-foreground font-body tracking-[0.2em] uppercase">
            Cha Jewels Rewards
          </p>
          <h1 className="font-display text-2xl font-semibold text-foreground mt-1">Rewards</h1>
          <p className="text-[13px] text-muted-foreground font-body mt-1">
            You have{' '}
            <span className="text-primary font-semibold">
              {member.available_points.toLocaleString()} points
            </span>{' '}
            to redeem
          </p>
        </div>

        {/* Redemption info */}
        <div className="bg-primary/5 rounded-xl p-3.5 border border-primary/10">
          <p className="text-[12px] text-muted-foreground font-body leading-relaxed">
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
              className={`px-3 py-1.5 rounded-full text-[13px] font-body font-medium whitespace-nowrap transition-colors ${
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
          {isLoading && filtered.length === 0 && (
            <>
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-24 rounded-xl" />
              ))}
            </>
          )}
          {!isLoading && filtered.length === 0 && (
            <p className="text-center text-[12px] text-muted-foreground/70 font-body italic py-6">
              No rewards in this category yet.
            </p>
          )}
          {filtered.map((reward) => {
            const unlocked = canRedeem(reward);
            const affordable = member.available_points >= reward.pointsCost;
            const stockOk = inStock(reward);
            const lowStock =
              reward.currentStock != null &&
              reward.currentStock > 0 &&
              reward.currentStock <= 5;
            const tappable = unlocked && stockOk;
            return (
              <motion.button
                key={reward.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                onClick={() => tappable && setSelectedReward(reward)}
                className={`w-full text-left bg-card rounded-xl p-4 shadow-card border-gold-accent transition-all ${
                  !tappable ? 'opacity-50' : 'hover:shadow-soft'
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
                      {reward.tier !== 'All' && !reward.isVipOnly && (
                        <span className="text-[10px] tracking-[0.15em] uppercase text-muted-foreground font-body bg-muted px-1.5 py-0.5 rounded-full">
                          {reward.tier}+
                        </span>
                      )}
                      {!stockOk && (
                        <span className="text-[10px] tracking-[0.2em] uppercase font-body font-semibold bg-destructive/10 text-destructive px-1.5 py-0.5 rounded-full">
                          Out of stock
                        </span>
                      )}
                      {stockOk && lowStock && (
                        <span className="text-[10px] tracking-[0.2em] uppercase font-body font-semibold bg-amber-500/15 text-amber-700 px-1.5 py-0.5 rounded-full">
                          Only {reward.currentStock} left
                        </span>
                      )}
                    </div>
                    <h3 className="font-display text-base font-semibold text-foreground">
                      {reward.name}
                    </h3>
                    <p className="text-[12px] text-muted-foreground font-body mt-1 line-clamp-2">
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
                          <p className="text-[11px] text-muted-foreground font-body">points</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {tappable && affordable && reward.pointsCost > 0 && (
                  <div className="flex items-center gap-1 mt-3 text-primary">
                    <span className="text-[12px] font-body font-semibold">Redeem Now</span>
                    <ArrowRight size={10} />
                  </div>
                )}
                {tappable && !affordable && reward.pointsCost > 0 && (
                  <p className="text-[12px] text-muted-foreground font-body mt-3">
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
        <VipRewardsVault
          vaultRewards={vaultRewards}
          onSelectReward={(r) => setSelectedReward(r)}
        />

        <p className="text-center text-[11px] text-muted-foreground/50 font-body italic pb-2">
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
            className="fixed inset-0 bg-foreground/30 backdrop-blur-sm z-[60] flex items-end justify-center"
            onClick={closeModal}
          >
            <motion.div
              initial={{ y: 300 }}
              animate={{ y: 0 }}
              exit={{ y: 300 }}
              transition={{ type: 'spring', damping: 25 }}
              className="bg-card rounded-t-3xl w-full max-w-lg p-6 pb-[calc(env(safe-area-inset-bottom)+5.5rem)] space-y-5 max-h-[90dvh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <h2 className="font-display text-xl font-semibold text-foreground">
                  {selectedReward.name}
                </h2>
                <button onClick={closeModal} className="p-1" disabled={submitting}>
                  <X size={18} className="text-muted-foreground" />
                </button>
              </div>
              <p className="text-sm text-muted-foreground font-body leading-relaxed">
                {selectedReward.description}
              </p>

              <div className="bg-background rounded-xl p-4 text-center border-gold-accent">
                <p className="text-[12px] text-muted-foreground font-body tracking-wider uppercase">
                  Points Required
                </p>
                <p className="font-display text-3xl font-bold text-foreground mt-1">
                  {selectedReward.pointsCost === 0
                    ? 'Free'
                    : selectedReward.pointsCost.toLocaleString()}
                </p>
                <p className="text-[13px] text-muted-foreground font-body mt-1">
                  Your balance:{' '}
                  <span className="text-primary font-semibold">
                    {member.available_points.toLocaleString()}
                  </span>{' '}
                  points
                </p>
              </div>

              {/* Optional invoice number — placeholder REDEEM-{id}
                  is generated server-side if left blank. */}
              <div className="space-y-1.5">
                <label
                  htmlFor="reward-invoice"
                  className="text-[12px] text-muted-foreground font-body tracking-wider uppercase block"
                >
                  Invoice Number (optional)
                </label>
                <input
                  id="reward-invoice"
                  type="text"
                  value={invoiceInput}
                  onChange={(e) => setInvoiceInput(e.target.value)}
                  placeholder="e.g. 19012"
                  disabled={submitting}
                  className="w-full px-3 py-2.5 bg-background border border-input rounded-lg text-sm font-body text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <p className="text-[11px] text-muted-foreground/70 font-body">
                  Leave blank if no specific invoice. A placeholder will
                  be assigned.
                </p>
              </div>

              {(() => {
                const affordable =
                  member.available_points >= selectedReward.pointsCost;
                const stockOk = inStock(selectedReward);
                if (!stockOk) {
                  return (
                    <button
                      disabled
                      className="w-full py-3.5 bg-muted text-muted-foreground rounded-xl font-body text-sm font-medium"
                    >
                      Out of Stock
                    </button>
                  );
                }
                if (!affordable) {
                  return (
                    <button
                      disabled
                      className="w-full py-3.5 bg-muted text-muted-foreground rounded-xl font-body text-sm font-medium"
                    >
                      Insufficient Points
                    </button>
                  );
                }
                return (
                  <button
                    onClick={handleRedeem}
                    disabled={submitting}
                    className="w-full py-3.5 gradient-gold text-primary-foreground rounded-xl font-body text-sm font-semibold shadow-gold disabled:opacity-70 flex items-center justify-center gap-2"
                  >
                    {submitting && (
                      <Loader2 size={14} className="animate-spin" />
                    )}
                    {submitting ? 'Submitting…' : 'Confirm Redemption'}
                  </button>
                );
              })()}
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
                Redemption Submitted!
              </h2>
              <p className="text-sm text-muted-foreground font-body">
                Your request is pending admin approval. Points will be
                deducted once approved. Thank you for choosing Cha Jewels
                Japan Gold! ✨
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
