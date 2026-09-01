import { useMemo, useState } from 'react';
import {
  Megaphone,
  Plus,
  Pencil,
  Trash2,
  Image as ImageIcon,
  Calendar,
  Eye,
  EyeOff,
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
  useLoyaltyBanners,
  useUpdateLoyaltyBanner,
  useDeleteLoyaltyBanner,
  type BannerType,
  type LoyaltyBannerRow,
} from '@/hooks/loyalty-admin/useLoyaltyBanners';
import BannerEditDialog from '@/components/loyalty-admin/BannerEditDialog';

type TypeFilter = 'all' | BannerType;

const TYPE_FILTERS: Array<{ value: TypeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'featured', label: 'Featured' },
  { value: 'promo', label: 'Promo' },
];

function fmtDateTime(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function isWithinSchedule(b: LoyaltyBannerRow, nowMs: number): boolean {
  if (b.start_at && new Date(b.start_at).getTime() > nowMs) return false;
  if (b.end_at && new Date(b.end_at).getTime() < nowMs) return false;
  return true;
}

function scheduleStatusLabel(
  b: LoyaltyBannerRow,
  nowMs: number,
): { label: string; tone: 'live' | 'scheduled' | 'expired' | 'always' } {
  if (!b.start_at && !b.end_at) return { label: 'Always on', tone: 'always' };
  if (b.start_at && new Date(b.start_at).getTime() > nowMs) {
    return { label: 'Scheduled', tone: 'scheduled' };
  }
  if (b.end_at && new Date(b.end_at).getTime() < nowMs) {
    return { label: 'Expired', tone: 'expired' };
  }
  return { label: 'In window', tone: 'live' };
}

export default function BannersTab() {
  const { roles } = useAuth();
  const rolesArr = roles as any[];
  const isAdmin = rolesArr.includes('admin');
  const isFinance = rolesArr.includes('finance');
  const canToggle = isAdmin || isFinance;
  // Staff may create and edit banners (owner direction 2026-09-01); the matching
  // loyalty_banners INSERT/UPDATE policies allow admin/finance/staff. Deletion
  // stays admin-only via canDelete.
  const isStaff = rolesArr.includes('staff');
  const canEdit = isAdmin || isFinance || isStaff;
  const canDelete = isAdmin;

  const { data, isLoading, isError } = useLoyaltyBanners();
  const updateMutation = useUpdateLoyaltyBanner();
  const deleteMutation = useDeleteLoyaltyBanner();

  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<LoyaltyBannerRow | null>(null);
  const [defaultType, setDefaultType] = useState<BannerType>('featured');
  const [deleteTarget, setDeleteTarget] = useState<LoyaltyBannerRow | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const banners = data ?? [];

  const filtered = useMemo(() => {
    if (typeFilter === 'all') return banners;
    return banners.filter((b) => b.banner_type === typeFilter);
  }, [banners, typeFilter]);

  const grouped = useMemo(() => {
    const featured: LoyaltyBannerRow[] = [];
    const promo: LoyaltyBannerRow[] = [];
    for (const b of filtered) {
      if (b.banner_type === 'featured') featured.push(b);
      else promo.push(b);
    }
    return { featured, promo };
  }, [filtered]);

  function handleNew(type: BannerType) {
    setEditing(null);
    setDefaultType(type);
    setDialogOpen(true);
  }

  function handleEdit(b: LoyaltyBannerRow) {
    setEditing(b);
    setDefaultType(b.banner_type);
    setDialogOpen(true);
  }

  async function handleToggle(b: LoyaltyBannerRow, next: boolean) {
    if (b.is_active === next) return;
    setTogglingId(b.id);
    try {
      await updateMutation.mutateAsync({
        bannerId: b.id,
        oldValues: b,
        updates: { is_active: next },
      });
      toast.success(next ? 'Banner activated' : 'Banner paused');
    } catch (err: any) {
      toast.error(err?.message || 'Could not update banner');
    } finally {
      setTogglingId(null);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget);
      toast.success('Banner deleted');
    } catch (err: any) {
      toast.error(err?.message || 'Could not delete banner');
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
            <Megaphone className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground font-display">
              Featured Banners
            </h2>
            <p className="text-xs text-muted-foreground max-w-md">
              Surface promotions and announcements on the customer loyalty
              home screen. Featured banners are the hero card; promo banners
              are the small card list below.
            </p>
          </div>
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => handleNew('featured')}
              className="gold-gradient text-primary-foreground"
            >
              <Plus className="h-4 w-4 mr-1.5" /> New Featured
            </Button>
            <Button
              onClick={() => handleNew('promo')}
              variant="outline"
            >
              <Plus className="h-4 w-4 mr-1.5" /> New Promo
            </Button>
          </div>
        )}
      </div>

      {/* Type filter */}
      <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-card p-1 w-fit">
        {TYPE_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setTypeFilter(f.value)}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${
              typeFilter === f.value
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            {f.label}
            {f.value !== 'all' && (
              <span className="ml-1 text-[10px] opacity-70">
                (
                {f.value === 'featured'
                  ? grouped.featured.length
                  : grouped.promo.length}
                )
              </span>
            )}
          </button>
        ))}
      </div>

      {isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
          <p className="text-sm text-destructive">Failed to load banners</p>
        </div>
      ) : isLoading ? (
        <div className="space-y-3">
          {[...Array(2)].map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="space-y-5">
          {(typeFilter === 'all' || typeFilter === 'featured') && (
            <Section
              title="Featured"
              empty="No featured banners. Customer hero card area will be hidden."
              banners={grouped.featured}
              canEdit={canEdit}
              canDelete={canDelete}
              canToggle={canToggle}
              togglingId={togglingId}
              onEdit={handleEdit}
              onDelete={(b) => setDeleteTarget(b)}
              onToggle={handleToggle}
            />
          )}
          {(typeFilter === 'all' || typeFilter === 'promo') && (
            <Section
              title="Promo"
              empty="No promo banners. Customer promo card list will be hidden."
              banners={grouped.promo}
              canEdit={canEdit}
              canDelete={canDelete}
              canToggle={canToggle}
              togglingId={togglingId}
              onEdit={handleEdit}
              onDelete={(b) => setDeleteTarget(b)}
              onToggle={handleToggle}
            />
          )}
        </div>
      )}

      <BannerEditDialog
        open={dialogOpen}
        banner={editing}
        defaultType={defaultType}
        onClose={() => setDialogOpen(false)}
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this banner?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.title && (
                <>
                  <span className="font-semibold">{deleteTarget.title}</span>
                  {' '}— this cannot be undone.
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
  banners: LoyaltyBannerRow[];
  canEdit: boolean;
  canDelete: boolean;
  canToggle: boolean;
  togglingId: string | null;
  onEdit: (b: LoyaltyBannerRow) => void;
  onDelete: (b: LoyaltyBannerRow) => void;
  onToggle: (b: LoyaltyBannerRow, next: boolean) => void;
}

function Section({
  title,
  empty,
  banners,
  canEdit,
  canDelete,
  canToggle,
  togglingId,
  onEdit,
  onDelete,
  onToggle,
}: SectionProps) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {banners.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center text-xs text-muted-foreground">
          {empty}
        </div>
      ) : (
        <div className="space-y-3">
          {banners.map((b) => (
            <BannerCard
              key={b.id}
              banner={b}
              canEdit={canEdit}
              canDelete={canDelete}
              canToggle={canToggle}
              toggling={togglingId === b.id}
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

interface BannerCardProps {
  banner: LoyaltyBannerRow;
  canEdit: boolean;
  canDelete: boolean;
  canToggle: boolean;
  toggling: boolean;
  onEdit: (b: LoyaltyBannerRow) => void;
  onDelete: (b: LoyaltyBannerRow) => void;
  onToggle: (b: LoyaltyBannerRow, next: boolean) => void;
}

function BannerCard({
  banner,
  canEdit,
  canDelete,
  canToggle,
  toggling,
  onEdit,
  onDelete,
  onToggle,
}: BannerCardProps) {
  const now = Date.now();
  const inWindow = isWithinSchedule(banner, now);
  const scheduleStatus = scheduleStatusLabel(banner, now);
  const isLive = banner.is_active && inWindow;
  const tiers =
    banner.applicable_tiers && banner.applicable_tiers.length > 0
      ? banner.applicable_tiers.join(', ')
      : 'All tiers';

  const scheduleToneClass =
    scheduleStatus.tone === 'live'
      ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30'
      : scheduleStatus.tone === 'scheduled'
      ? 'bg-amber-500/15 text-amber-700 border-amber-500/30'
      : scheduleStatus.tone === 'expired'
      ? 'bg-muted text-muted-foreground border-border'
      : 'bg-muted text-muted-foreground border-border';

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="h-14 w-14 rounded-md bg-primary/8 flex items-center justify-center shrink-0 overflow-hidden border border-border">
          {banner.image_url ? (
            <img
              src={banner.image_url}
              alt=""
              className="h-full w-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : banner.emoji ? (
            <span className="text-2xl">{banner.emoji}</span>
          ) : (
            <ImageIcon className="h-5 w-5 text-muted-foreground/40" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-foreground">
              {banner.title}
            </h4>
            <span className="inline-flex items-center rounded-md border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
              {banner.banner_type}
            </span>
            <span
              className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${scheduleToneClass}`}
            >
              {scheduleStatus.label}
            </span>
            {!banner.is_active && (
              <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <EyeOff className="h-3 w-3" /> Paused
              </span>
            )}
            {isLive && (
              <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                <Eye className="h-3 w-3" /> Live
              </span>
            )}
            {banner.display_priority > 0 && (
              <span className="inline-flex items-center rounded-md border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                P{banner.display_priority}
              </span>
            )}
          </div>
          {banner.subtitle && (
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mt-1">
              {banner.subtitle}
            </p>
          )}
          {banner.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
              {banner.description}
            </p>
          )}
        </div>
        {canToggle && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] text-muted-foreground">
              {banner.is_active ? 'Active' : 'Inactive'}
            </span>
            <Switch
              checked={banner.is_active}
              disabled={toggling}
              onCheckedChange={(v) => onToggle(banner, v)}
            />
          </div>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
        <Field label="Tier visibility" value={tiers} />
        <Field label="Link target" value={banner.link_target ?? '—'} mono />
        <Field
          label="Schedule"
          value={
            banner.start_at || banner.end_at
              ? `${fmtDateTime(banner.start_at) ?? '—'} → ${
                  fmtDateTime(banner.end_at) ?? '—'
                }`
              : 'Always on'
          }
          Icon={Calendar}
        />
      </div>

      {(canEdit || canDelete) && (
        <div className="mt-3 flex justify-end gap-2">
          {canEdit && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onEdit(banner)}
              className="h-7 px-2 text-[11px]"
            >
              <Pencil className="h-3 w-3 mr-1" /> Edit
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onDelete(banner)}
              className="h-7 px-2 text-[11px] text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-3 w-3 mr-1" /> Delete
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  Icon,
  mono,
}: {
  label: string;
  value: string;
  Icon?: typeof Calendar;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </p>
      <p
        className={`text-xs font-medium text-foreground mt-0.5 truncate ${
          mono ? 'font-mono' : ''
        }`}
      >
        {value}
      </p>
    </div>
  );
}
