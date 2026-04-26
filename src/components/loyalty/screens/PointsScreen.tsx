import { useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowUpRight, ArrowDownRight, TrendingUp, Activity, Info } from 'lucide-react';
import { useLoyaltyData } from '@/components/loyalty/loyaltyData';

type FilterType = 'all' | 'earned' | 'redeemed';

export default function PointsScreen() {
  const [filter, setFilter] = useState<FilterType>('all');
  const { member, tiers, transactions } = useLoyaltyData();

  if (!member || !tiers || tiers.length === 0) return null;

  const currentTier = tiers.find((t) => t.name === member.current_tier) ?? tiers[0];
  const filtered =
    filter === 'all' ? transactions : transactions.filter((t) => t.type === filter);

  return (
    <div className="px-5 pt-6 pb-4 space-y-6">
      <div>
        <p className="text-[10px] text-muted-foreground font-body tracking-[0.2em] uppercase">
          Your Points, Your Perks
        </p>
        <h1 className="font-display text-2xl font-semibold text-foreground mt-1">My Points</h1>
      </div>

      {/* Points Summary Card */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-card rounded-2xl p-5 shadow-soft border-gold-accent"
      >
        <div className="text-center mb-5">
          <p className="text-[9px] text-muted-foreground font-body tracking-[0.25em] uppercase">
            Available Points
          </p>
          <p className="font-display text-5xl font-bold text-foreground mt-2">
            {member.available_points.toLocaleString()}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {[
            {
              label: 'Lifetime Earned',
              value: member.lifetime_points_earned.toLocaleString(),
              icon: TrendingUp,
              color: 'text-primary',
            },
            {
              label: 'Redeemed',
              value: member.redeemed_points.toLocaleString(),
              icon: ArrowDownRight,
              color: 'text-muted-foreground',
            },
            {
              label: 'Current Multiplier',
              value: `${member.current_multiplier}x`,
              icon: ArrowUpRight,
              color: 'text-primary',
            },
            {
              label: 'Activity Status',
              value: member.activity_status,
              icon: Activity,
              color: 'text-primary',
            },
          ].map((stat) => (
            <div key={stat.label} className="bg-background/60 rounded-xl p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <stat.icon size={12} className={stat.color} />
                <span className="text-[10px] text-muted-foreground font-body">{stat.label}</span>
              </div>
              <p className="font-display text-lg font-semibold text-foreground">{stat.value}</p>
            </div>
          ))}
        </div>
      </motion.div>

      {/* How You Earn Points */}
      <div className="bg-card rounded-2xl p-5 shadow-card border-gold-accent">
        <h3 className="font-display text-lg font-semibold text-foreground mb-3">
          How You Earn Points
        </h3>
        <div className="space-y-2.5">
          {[
            { source: 'Base Rate', rule: '¥10,000 spent = 10 points (1 pt per ¥1,000)', icon: '💎' },
            {
              source: 'Tier Multiplier',
              rule: `${currentTier.multiplier}x as ${currentTier.name} Member`,
              icon: '👑',
            },
            {
              source: 'Example',
              rule: `¥50,000 purchase = ${50 * currentTier.multiplier} points`,
              icon: '✨',
            },
          ].map((item) => (
            <div key={item.source} className="flex items-center gap-3 py-1.5">
              <span className="text-lg">{item.icon}</span>
              <div className="flex-1">
                <p className="text-[11px] font-body font-medium text-foreground">{item.source}</p>
                <p className="text-[10px] text-muted-foreground font-body">{item.rule}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Redemption Rules */}
      <div className="bg-card rounded-2xl p-5 shadow-card border-gold-accent">
        <h3 className="font-display text-lg font-semibold text-foreground mb-3">
          Redemption Rules
        </h3>
        <div className="space-y-2">
          <p className="text-[11px] font-body text-foreground font-medium">
            Points can be redeemed on:
          </p>
          <ul className="space-y-1.5 ml-1">
            {['Regular items', 'Layaway purchases', 'Discounted items'].map((item) => (
              <li
                key={item}
                className="flex items-center gap-2 text-[10px] text-muted-foreground font-body"
              >
                <span className="w-1 h-1 rounded-full bg-primary flex-shrink-0" />
                {item}
              </li>
            ))}
          </ul>
          <div className="mt-3 pt-3 border-t border-border/50">
            <p className="text-[10px] text-muted-foreground/70 font-body italic">
              Points are non-transferable and cannot be exchanged for cash.
            </p>
          </div>
        </div>
      </div>

      {/* Activity Rule */}
      <div className="bg-primary/5 rounded-2xl p-4 border border-primary/10">
        <div className="flex items-start gap-3">
          <Info size={14} className="text-primary mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-[11px] font-body font-semibold text-foreground">Activity Rule</p>
            <p className="text-[10px] text-muted-foreground font-body mt-1 leading-relaxed">
              Points do not expire as long as you remain active. Stay active by making at least 1
              purchase every 6 months. Inactive accounts may experience tier downgrade and reduced
              benefits.
            </p>
          </div>
        </div>
      </div>

      {/* Points History */}
      <div>
        <h3 className="font-display text-lg font-semibold text-foreground mb-3">Points History</h3>

        <div className="flex gap-2 mb-4 overflow-x-auto pb-1 scrollbar-hide">
          {(
            [
              ['all', 'All'],
              ['earned', 'Earned'],
              ['redeemed', 'Redeemed'],
            ] as [FilterType, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 rounded-full text-[11px] font-body font-medium whitespace-nowrap transition-colors ${
                filter === key
                  ? 'gradient-gold text-primary-foreground shadow-sm'
                  : 'bg-card text-muted-foreground shadow-card border-gold-accent'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="space-y-2">
          {filtered.map((tx) => {
            // derive base points from multiplier when spend data is available
            const basePoints =
              tx.tier_multiplier && tx.tier_multiplier > 0
                ? Math.round(tx.points / tx.tier_multiplier)
                : tx.points;

            return (
              <motion.div
                key={tx.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="bg-card rounded-xl p-3.5 shadow-card border-gold-accent"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <p className="text-[11px] font-body font-medium text-foreground">
                      {tx.description}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] text-muted-foreground font-body">{tx.date}</span>
                      <span className="text-[9px] bg-primary/8 text-primary px-1.5 py-0.5 rounded font-body font-medium">
                        {tx.source}
                      </span>
                    </div>
                    {tx.spend_amount_jpy && tx.tier_multiplier && (
                      <div className="mt-1.5 text-[9px] text-muted-foreground/70 font-body space-x-2">
                        <span>¥{tx.spend_amount_jpy.toLocaleString()}</span>
                        <span>·</span>
                        <span>Base: {basePoints} pts</span>
                        <span>·</span>
                        <span>
                          {tx.tier_multiplier}x = {tx.points} pts
                        </span>
                      </div>
                    )}
                    {tx.invoice_number && (
                      <p className="text-[9px] text-muted-foreground/60 font-body mt-1">
                        Ref: {tx.invoice_number}
                      </p>
                    )}
                  </div>
                  <span
                    className={`font-display text-lg font-bold ${
                      tx.points > 0 ? 'text-primary' : 'text-destructive/70'
                    }`}
                  >
                    {tx.points > 0 ? '+' : ''}
                    {tx.points}
                  </span>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>

      <p className="text-center text-[9px] text-muted-foreground/50 font-body italic pb-2">
        Level Up · Earn More · Sparkle Harder
      </p>
    </div>
  );
}
