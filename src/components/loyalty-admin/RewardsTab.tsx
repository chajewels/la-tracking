import { useMemo, useState } from 'react';
import {
  Gift,
  Plus,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronUp,
  Lock,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  useLoyaltyRewards,
  useUpdateLoyaltyReward,
  useDeleteLoyaltyReward,
  type LoyaltyRewardRow,
  type RewardCategory,
} from '@/hooks/loyalty-admin/useLoyaltyRewards';
import RewardEditDialog from '@/components/loyalty-admin/RewardEditDialog';

const CATEGORY_ORDER: RewardCategory[] = [
  'Redeem with Points',
  'Tier Exclusive',
  'Shipping Rewards',
  'Member-Only Offers',
  'VIP Vault',
];

const CATEGORY_DESCRIPTIONS: Record<RewardCategory, string> = {
  'Redeem with Points': 'Vouchers and credits exchangeable for points',
  'Tier Exclusive': 'Items locked to specific tiers',
  'Shipping Rewards': 'Free shipping passes and shipping perks',
  'Member-Only Offers': 'Services and experiences for enrolled members',
  'VIP Vault': 'Hidden vault items for high-tier customers',
};

function fmtStock(r: LoyaltyRewardRow): { label: string; tone: 'normal' | 'low' | 'out' | 'unlimited' } {
  if (r.stock_limit == null) return { label: 'Unlimited', tone: 'unlimited' };
  const current = r.current_stock ?? r.stock_limit;
  if (current <= 0) return { label: 'Out of stock', tone: 'out' };
  if (current <= Math.max(1, Math.floor(r.stock_limit * 0.1))) {
    return { label: `${current} / ${r.stock_limit} left`, tone: 'low' };
  }
  return { label: `${current} / ${r.stock_limit} left`, tone: 'normal' };
}

export default function RewardsTab() {
  const { roles } = useAuth();
  const rolesArr = roles as any[];
  const isAdmin = rolesArr.includes('admin');
  const isFinance = rolesArr.includes('finance');
  const canToggle = isAdmin || isFinance;
  const canEdit = isAdmin;

  const { data, isLoading, isError } = useLoyaltyRewards();
  const updateMutation = useUpdateLoyaltyReward();
  const deleteMutation = useDeleteLoyaltyReward();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<LoyaltyRewardRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LoyaltyRewardRow | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<RewardCategory>>(new Set());

  const grouped = useMemo(() => {
    const map = new Map<RewardCategory, LoyaltyRewardRow[]>();
    for (const c of CATEGORY_ORDER) map.set(c, []);
    for (const r of data ?? []) {
      const list = map.get(r.category);
      if (list) list.push(r);
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
        if (a.display_priority !== b.display_priority) {
          return b.display_priority - a.display_priority;
        }
        return a.name.localeCompare(b.name);
      });
    }
    return map;
  }, [data]);

  function toggleCollapsed(c: RewardCategory) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  function handleNew() {
    setEditing(null);
    setDialogOpen(true);
  }

  function handleEdit(r: LoyaltyRewardRow) {
    setEditing(r);
    setDialogOpen(true);
  }

  async function handleToggle(r: LoyaltyRewardRow, next: boolean) {
    if (r.is_active === next) return;
    setTogglingId(r.id);
    try {
      await updateMutation.mutateAsync({
        rewardId: r.id,
        oldValues: r,
        updates: { is_active: next },
      });
      toast.success(next ? 'Reward activated' : 'Reward paused');
    } catch (err: any) {
      toast.error(err?.message || 'Could not update reward');
    } finally {
      setTogglingId(null);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget);
      toast.success('Reward deleted');
    } catch (err: any) {
      toast.error(err?.message || 'Could not delete reward');
    } finally {
      setDeleteTarget(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg gold-gradient">
            <Gift className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground font-display">
              Rewards Catalog
            </h2>
            <p className="text-xs text-muted-foreground max-w-md">
              Items customers can redeem with their points. Active rewards
              appear in the customer-facing portal grouped by the same
              categories shown below.
            </p>
          </div>
        </div>
        {canEdit && (
          <Button
            onClick={handleNew}
            className="gold-gradient text-primary-foreground"
          >
            <Plus className="h-4 w-4 mr-1.5" /> New Reward
          </Button>
        )}
      </div>

      {isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
          <p className="text-sm text-destructive">Failed to load rewards</p>
        </div>
      ) : isLoading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {CATEGORY_ORDER.map((category) => {
            const rewards = grouped.get(category) ?? [];
            const isCollapsed = collapsed.has(category);
            return (
              <CategoryGroup
                key={category}
                category={category}
                rewards={rewards}
                isCollapsed={isCollapsed}
                onToggleCollapse={() => toggleCollapsed(category)}
                canEdit={canEdit}
                canToggle={canToggle}
                togglingId={togglingId}
                onEdit={handleEdit}
                onDelete={(r) => setDeleteTarget(r)}
                onToggle={handleToggle}
              />
            );
          })}
        </div>
      )}

      <RewardEditDialog
        open={dialogOpen}
        reward={editing}
        onClose={() => setDialogOpen(false)}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this reward?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.name && (
                <>
                  <span className="font-semibold">{deleteTarget.name}</span>
                  {' '}— this cannot be undone. Already-confirmed redemptions
                  remain valid; only the catalog listing is removed.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending}
              onClick={handleConfirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface CategoryGroupProps {
  category: RewardCategory;
  rewards: LoyaltyRewardRow[];
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  canEdit: boolean;
  canToggle: boolean;
  togglingId: string | null;
  onEdit: (r: LoyaltyRewardRow) => void;
  onDelete: (r: LoyaltyRewardRow) => void;
  onToggle: (r: LoyaltyRewardRow, next: boolean) => void;
}

function CategoryGroup({
  category,
  rewards,
  isCollapsed,
  onToggleCollapse,
  canEdit,
  canToggle,
  togglingId,
  onEdit,
  onDelete,
  onToggle,
}: CategoryGroupProps) {
  const activeCount = rewards.filter((r) => r.is_active).length;

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <button
        type="button"
        onClick={onToggleCollapse}
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-muted/30"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-foreground">
              {category}
            </h3>
            <span className="inline-flex items-center rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
              {rewards.length} item{rewards.length === 1 ? '' : 's'}
              {rewards.length > 0 && ` · ${activeCount} active`}
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {CATEGORY_DESCRIPTIONS[category]}
          </p>
        </div>
        {isCollapsed ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
        ) : (
          <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
        )}
      </button>

      {!isCollapsed && (
        <div className="border-t border-border p-3 space-y-3">
          {rewards.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4 italic">
              No rewards in this category yet
            </p>
          ) : (
            rewards.map((r) => (
              <RewardCard
                key={r.id}
                reward={r}
                canEdit={canEdit}
                canToggle={canToggle}
                toggling={togglingId === r.id}
                onEdit={onEdit}
                onDelete={onDelete}
                onToggle={onToggle}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface RewardCardProps {
  reward: LoyaltyRewardRow;
  canEdit: boolean;
  canToggle: boolean;
  toggling: boolean;
  onEdit: (r: LoyaltyRewardRow) => void;
  onDelete: (r: LoyaltyRewardRow) => void;
  onToggle: (r: LoyaltyRewardRow, next: boolean) => void;
}

function RewardCard({
  reward,
  canEdit,
  canToggle,
  toggling,
  onEdit,
  onDelete,
  onToggle,
}: RewardCardProps) {
  const stock = fmtStock(reward);
  const stockToneClass =
    stock.tone === 'out'
      ? 'text-destructive'
      : stock.tone === 'low'
      ? 'text-amber-600'
      : 'text-muted-foreground';

  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex items-start gap-3">
        {reward.image_url && (
          <img
            src={reward.image_url}
            alt=""
            className="h-14 w-14 rounded-md object-cover border border-border shrink-0"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-foreground">
              {reward.name}
            </h4>
            {!reward.is_active && (
              <span className="inline-flex items-center rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Paused
              </span>
            )}
            {reward.is_limited && (
              <span className="inline-flex items-center rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700">
                Limited
              </span>
            )}
            {reward.is_vip_only && (
              <span className="inline-flex items-center rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                VIP only
              </span>
            )}
            {reward.is_vault && (
              <span className="inline-flex items-center gap-1 rounded-md border border-purple-500/40 bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-purple-700">
                <Lock className="h-3 w-3" /> Vault
              </span>
            )}
            {reward.display_priority > 0 && (
              <span className="inline-flex items-center rounded-md border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                P{reward.display_priority}
              </span>
            )}
          </div>
          {reward.description && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
              {reward.description}
            </p>
          )}
        </div>
        {canToggle && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] text-muted-foreground">
              {reward.is_active ? 'Active' : 'Inactive'}
            </span>
            <Switch
              checked={reward.is_active}
              disabled={toggling}
              onCheckedChange={(v) => onToggle(reward, v)}
            />
          </div>
        )}
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <Field
          label="Cost"
          value={`${reward.points_cost.toLocaleString()} pts`}
        />
        <Field
          label="Tier visibility"
          value={reward.tier_visibility}
        />
        <Field
          label="Stock"
          value={stock.label}
          valueClass={stockToneClass}
        />
      </div>

      {canEdit && (
        <div className="mt-2 flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onEdit(reward)}
            className="h-7 px-2 text-[11px]"
          >
            <Pencil className="h-3 w-3 mr-1" /> Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onDelete(reward)}
            className="h-7 px-2 text-[11px] text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3 w-3 mr-1" /> Delete
          </Button>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={`text-xs font-medium mt-0.5 truncate ${
          valueClass ?? 'text-foreground'
        }`}
      >
        {value}
      </p>
    </div>
  );
}
