import { useState } from 'react';
import { Crown, Pencil, Sparkles, Truck, Gift, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/contexts/AuthContext';
import {
  useLoyaltyTiers,
  type LoyaltyTierRow,
} from '@/hooks/loyalty-admin/useLoyaltyTiers';
import TierEditDialog from '@/components/loyalty-admin/TierEditDialog';

const TIER_FALLBACK_COLOR: Record<string, string> = {
  Glimmer: '#9CA3AF',
  Radiant: '#FBBF24',
  Elite: '#A855F7',
  'Crown VIP': '#EF4444',
};

function fmtSpend(jpy: number) {
  if (jpy === 0) return '¥0';
  if (jpy >= 1_000_000) {
    const m = jpy / 1_000_000;
    return `¥${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (jpy >= 1_000) {
    return `¥${(jpy / 1_000).toFixed(0)}k`;
  }
  return `¥${jpy.toLocaleString()}`;
}

interface TierCardProps {
  tier: LoyaltyTierRow;
  canEdit: boolean;
  onEdit: () => void;
}

function TierCard({ tier, canEdit, onEdit }: TierCardProps) {
  const color = tier.color_hex || TIER_FALLBACK_COLOR[tier.name] || '#94A3B8';

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden flex flex-col">
      <div
        className="h-1.5 w-full"
        style={{ background: color }}
        aria-hidden
      />
      <div className="p-5 space-y-4 flex-1 flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Tier
            </p>
            <h3 className="text-base font-semibold text-foreground font-display flex items-center gap-1.5">
              <Crown className="h-4 w-4" style={{ color }} />
              {tier.name}
            </h3>
          </div>
          <span
            className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums"
            style={{
              borderColor: color,
              color,
            }}
          >
            {tier.points_multiplier}x
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md border border-border bg-background p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Min Spend
            </p>
            <p className="text-sm font-semibold tabular-nums mt-0.5">
              {fmtSpend(tier.min_spend_jpy)}
            </p>
          </div>
          <div className="rounded-md border border-border bg-background p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Order
            </p>
            <p className="text-sm font-semibold tabular-nums mt-0.5">
              #{tier.display_order}
            </p>
          </div>
        </div>

        <div className="space-y-1.5 text-xs flex-1">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Benefits
          </p>
          <div className="flex items-center gap-1.5 text-foreground">
            <Sparkles className="h-3 w-3 text-primary" />
            <span>
              {tier.points_multiplier}x points on every loyalty-eligible
              purchase
            </span>
          </div>
          {tier.free_shipping_min_items != null && (
            <div className="flex items-center gap-1.5 text-foreground">
              <Truck className="h-3 w-3 text-primary" />
              <span>
                Free shipping on {tier.free_shipping_min_items}+ qualifying
                items
              </span>
            </div>
          )}
          {tier.mystery_gift && (
            <div className="flex items-center gap-1.5 text-foreground">
              <Gift className="h-3 w-3 text-primary" />
              <span>Mystery gift on tier-up</span>
            </div>
          )}
        </div>

        <div className="pt-1">
          {canEdit ? (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={onEdit}
            >
              <Pencil className="h-3 w-3 mr-1.5" />
              Edit Tier
            </Button>
          ) : (
            <div className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
              <Lock className="h-3 w-3" />
              Admin only
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function TiersTab() {
  const { roles } = useAuth();
  const rolesArr = roles as any[];
  const isAdmin = rolesArr.includes('admin');

  const { data: tiers, isLoading, isError } = useLoyaltyTiers();
  const [editingTier, setEditingTier] = useState<LoyaltyTierRow | null>(null);

  if (isError) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
        <p className="text-sm text-destructive">Failed to load tiers</p>
      </div>
    );
  }

  if (isLoading || !tiers) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-72 rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-muted/30 p-4 text-xs text-muted-foreground">
        Tier names are locked because promo configuration references them by
        name. Multiplier, threshold, color, free shipping, and mystery gift
        are editable. Each edit walks through a member-impact preview before
        confirming.
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {tiers.map((tier) => (
          <TierCard
            key={tier.id}
            tier={tier}
            canEdit={isAdmin}
            onEdit={() => setEditingTier(tier)}
          />
        ))}
      </div>

      <TierEditDialog
        tier={editingTier}
        onClose={() => setEditingTier(null)}
      />
    </div>
  );
}
