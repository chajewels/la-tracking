import { useMemo, useState } from 'react';
import {
  Sparkles,
  Plus,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronUp,
  Users as UsersIcon,
  TrendingUp,
  Coins,
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
  useLoyaltyPromos,
  useUpdateLoyaltyPromo,
  useDeleteLoyaltyPromo,
  type LoyaltyPromoRow,
  type LoyaltyPromoWithStats,
} from '@/hooks/loyalty-admin/useLoyaltyPromosAdmin';
import PromoEditDialog from '@/components/loyalty-admin/PromoEditDialog';
import { getPHTToday } from '@/lib/date-utils';

type Bucket = 'scheduled' | 'upcoming' | 'past';

function fmtDate(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function bucketOf(p: LoyaltyPromoRow, today: string): Bucket {
  if (p.end_date < today) return 'past';
  if (p.start_date > today) return 'upcoming';
  return 'scheduled';
}

export default function PromotionsTab() {
  const { roles } = useAuth();
  const rolesArr = roles as any[];
  const isAdmin = rolesArr.includes('admin');
  const isFinance = rolesArr.includes('finance');
  const canToggle = isAdmin || isFinance;
  const canEdit = isAdmin;

  const { data, isLoading, isError } = useLoyaltyPromos();
  const updateMutation = useUpdateLoyaltyPromo();
  const deleteMutation = useDeleteLoyaltyPromo();

  const [pastOpen, setPastOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<LoyaltyPromoRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LoyaltyPromoRow | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const today = getPHTToday();
  const promos = data ?? [];

  const grouped = useMemo(() => {
    const scheduled: LoyaltyPromoWithStats[] = [];
    const upcoming: LoyaltyPromoWithStats[] = [];
    const past: LoyaltyPromoWithStats[] = [];
    for (const p of promos) {
      const b = bucketOf(p, today);
      if (b === 'scheduled') scheduled.push(p);
      else if (b === 'upcoming') upcoming.push(p);
      else past.push(p);
    }
    scheduled.sort((a, b) => {
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
      if (a.display_priority !== b.display_priority) {
        return b.display_priority - a.display_priority;
      }
      return b.start_date.localeCompare(a.start_date);
    });
    upcoming.sort((a, b) => a.start_date.localeCompare(b.start_date));
    past.sort((a, b) => b.end_date.localeCompare(a.end_date));
    return { scheduled, upcoming, past };
  }, [promos, today]);

  function handleNew() {
    setEditing(null);
    setDialogOpen(true);
  }

  function handleEdit(p: LoyaltyPromoRow) {
    setEditing(p);
    setDialogOpen(true);
  }

  async function handleToggle(p: LoyaltyPromoRow, next: boolean) {
    if (p.is_active === next) return;
    setTogglingId(p.id);
    try {
      await updateMutation.mutateAsync({
        promoId: p.id,
        oldValues: p,
        updates: { is_active: next },
      });
      toast.success(next ? 'Promo activated' : 'Promo paused');
    } catch (err: any) {
      toast.error(err?.message || 'Could not update promo');
    } finally {
      setTogglingId(null);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget);
      toast.success('Promo deleted');
    } catch (err: any) {
      toast.error(err?.message || 'Could not delete promo');
    } finally {
      setDeleteTarget(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg gold-gradient">
            <Sparkles className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground font-display">
              Loyalty Bonus Promotions
            </h2>
            <p className="text-xs text-muted-foreground max-w-md">
              Award bonus points during promotional periods. Active promos
              automatically apply on eligible purchases.
            </p>
          </div>
        </div>
        {canEdit && (
          <Button
            onClick={handleNew}
            className="gold-gradient text-primary-foreground"
          >
            <Plus className="h-4 w-4 mr-1.5" /> New Promo
          </Button>
        )}
      </div>

      {isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
          <p className="text-sm text-destructive">Failed to load promos</p>
        </div>
      ) : isLoading ? (
        <div className="space-y-3">
          {[...Array(2)].map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : (
        <>
          <Section
            title="Currently Scheduled"
            empty="No promos within their date window right now"
            promos={grouped.scheduled}
            today={today}
            canEdit={canEdit}
            canToggle={canToggle}
            togglingId={togglingId}
            onEdit={handleEdit}
            onDelete={(p) => setDeleteTarget(p)}
            onToggle={handleToggle}
          />

          <Section
            title="Upcoming"
            empty="No upcoming promos scheduled"
            promos={grouped.upcoming}
            today={today}
            canEdit={canEdit}
            canToggle={canToggle}
            togglingId={togglingId}
            onEdit={handleEdit}
            onDelete={(p) => setDeleteTarget(p)}
            onToggle={handleToggle}
          />

          {/* Past — collapsible, read-only */}
          <div className="rounded-xl border border-border bg-card">
            <button
              type="button"
              onClick={() => setPastOpen((o) => !o)}
              className="flex w-full items-center justify-between px-4 py-3 text-left"
            >
              <span className="text-sm font-semibold text-foreground">
                Past Promos
                {grouped.past.length > 0 ? ` (${grouped.past.length})` : ''}
              </span>
              {pastOpen ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
            {pastOpen && (
              <div className="border-t border-border p-3 space-y-3">
                {grouped.past.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-3">
                    No past promos in the system
                  </p>
                ) : (
                  grouped.past.map((p) => (
                    <PromoCard
                      key={p.id}
                      promo={p}
                      today={today}
                      readOnly
                    />
                  ))
                )}
              </div>
            )}
          </div>
        </>
      )}

      <PromoEditDialog
        open={dialogOpen}
        promo={editing}
        onClose={() => setDialogOpen(false)}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this promo?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.name && (
                <>
                  <span className="font-semibold">{deleteTarget.name}</span>
                  {' '}— this cannot be undone. Already-awarded bonus points
                  remain on customer accounts.
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

interface SectionProps {
  title: string;
  empty: string;
  promos: LoyaltyPromoWithStats[];
  today: string;
  canEdit: boolean;
  canToggle: boolean;
  togglingId: string | null;
  onEdit: (p: LoyaltyPromoRow) => void;
  onDelete: (p: LoyaltyPromoRow) => void;
  onToggle: (p: LoyaltyPromoRow, next: boolean) => void;
}

function Section({
  title,
  empty,
  promos,
  today,
  canEdit,
  canToggle,
  togglingId,
  onEdit,
  onDelete,
  onToggle,
}: SectionProps) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {promos.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center text-xs text-muted-foreground">
          {empty}
        </div>
      ) : (
        <div className="space-y-3">
          {promos.map((p) => (
            <PromoCard
              key={p.id}
              promo={p}
              today={today}
              canEdit={canEdit}
              canToggle={canToggle}
              toggling={togglingId === p.id}
              onEdit={onEdit}
              onDelete={onDelete}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface PromoCardProps {
  promo: LoyaltyPromoWithStats;
  today: string;
  readOnly?: boolean;
  canEdit?: boolean;
  canToggle?: boolean;
  toggling?: boolean;
  onEdit?: (p: LoyaltyPromoRow) => void;
  onDelete?: (p: LoyaltyPromoRow) => void;
  onToggle?: (p: LoyaltyPromoRow, next: boolean) => void;
}

function PromoCard({
  promo,
  today,
  readOnly = false,
  canEdit = false,
  canToggle = false,
  toggling = false,
  onEdit,
  onDelete,
  onToggle,
}: PromoCardProps) {
  const inWindow = promo.start_date <= today && today <= promo.end_date;
  const isPaused = inWindow && !promo.is_active;
  const tiers =
    promo.applicable_tiers && promo.applicable_tiers.length > 0
      ? promo.applicable_tiers.join(', ')
      : 'All tiers';

  return (
    <div
      className="rounded-xl border bg-card p-4"
      style={{
        borderColor: isPaused ? 'var(--border)' : undefined,
        opacity: readOnly ? 0.85 : 1,
      }}
    >
      <div className="flex items-start gap-3">
        {promo.image_url && (
          <img
            src={promo.image_url}
            alt=""
            className="h-16 w-16 rounded-md object-cover border border-border shrink-0"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-foreground font-display">
              {promo.name}
            </h4>
            {isPaused && (
              <span className="inline-flex items-center rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Paused
              </span>
            )}
            {readOnly && (
              <span className="inline-flex items-center rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Past
              </span>
            )}
            {promo.display_priority > 0 && (
              <span className="inline-flex items-center rounded-md border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                P{promo.display_priority}
              </span>
            )}
          </div>
          {promo.description && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {promo.description}
            </p>
          )}
        </div>
        {!readOnly && canToggle && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] text-muted-foreground">
              {promo.is_active ? 'Active' : 'Inactive'}
            </span>
            <Switch
              checked={promo.is_active}
              disabled={toggling}
              onCheckedChange={(v) => onToggle?.(promo, v)}
            />
          </div>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <Field
          label="Period"
          value={`${fmtDate(promo.start_date)} — ${fmtDate(promo.end_date)}`}
        />
        <BonusField
          bonusPoints={Number(promo.bonus_points)}
          bonusMultiplier={Number(promo.bonus_multiplier ?? 1)}
        />
        <Field label="Applicable tiers" value={tiers} />
        <Field
          label="Max per customer"
          value={
            promo.max_per_customer != null
              ? Number(promo.max_per_customer).toLocaleString()
              : 'Unlimited'
          }
        />
      </div>

      {/* Stats panel */}
      <div className="mt-3 grid grid-cols-3 gap-2">
        <StatTile
          Icon={TrendingUp}
          label="Uses"
          value={promo.stats.uses.toLocaleString()}
        />
        <StatTile
          Icon={UsersIcon}
          label="Customers"
          value={promo.stats.unique_customers.toLocaleString()}
        />
        <StatTile
          Icon={Coins}
          label="Total bonus pts"
          value={promo.stats.total_bonus_points.toLocaleString()}
        />
      </div>

      {!readOnly && canEdit && (
        <div className="mt-3 flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onEdit?.(promo)}
            className="h-7 px-2 text-[11px]"
          >
            <Pencil className="h-3 w-3 mr-1" /> Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onDelete?.(promo)}
            className="h-7 px-2 text-[11px] text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3 w-3 mr-1" /> Delete
          </Button>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="text-xs font-medium text-foreground mt-0.5 truncate">
        {value}
      </p>
    </div>
  );
}

// Strip trailing zeros: 3.00 → "3", 2.50 → "2.5", 1.27 → "1.27"
function fmtMultiplier(n: number) {
  return parseFloat(n.toFixed(2)).toString();
}

function BonusField({
  bonusPoints,
  bonusMultiplier,
}: {
  bonusPoints: number;
  bonusMultiplier: number;
}) {
  const hasMultiplier = bonusMultiplier > 1;
  const hasPoints = bonusPoints > 0;
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Bonus
      </p>
      <div className="mt-0.5 flex flex-wrap items-center gap-1">
        {hasMultiplier && (
          <span
            className="inline-flex items-center rounded-md bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground"
            title="Multiplier stacks on top of the member's tier multiplier."
          >
            {fmtMultiplier(bonusMultiplier)}x Bonus
          </span>
        )}
        {hasPoints && (
          <span className="text-xs font-medium text-foreground">
            +{bonusPoints.toLocaleString()} pts
          </span>
        )}
        {!hasMultiplier && !hasPoints && (
          <span className="text-xs font-medium text-muted-foreground">
            +0 pts
          </span>
        )}
      </div>
    </div>
  );
}

function StatTile({
  Icon,
  label,
  value,
}: {
  Icon: typeof TrendingUp;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-2.5">
      <div className="flex items-center justify-between">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <Icon className="h-3 w-3 text-muted-foreground" />
      </div>
      <p className="text-sm font-semibold tabular-nums mt-0.5">{value}</p>
    </div>
  );
}
