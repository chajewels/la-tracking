import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Sparkles, Plus, Pencil, Trash2, ChevronDown, ChevronUp,
} from 'lucide-react';
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
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import {
  LoyaltyPromoFormModal,
  type LoyaltyPromoRow,
} from '@/components/loyalty/LoyaltyPromoFormModal';
import { getPHTToday } from '@/lib/date-utils';

type Bucket = 'scheduled' | 'upcoming' | 'past';

function fmtDate(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function todayYmd() {
  return getPHTToday();
}

function bucketOf(p: LoyaltyPromoRow, today: string): Bucket {
  if (p.end_date < today) return 'past';
  if (p.start_date > today) return 'upcoming';
  return 'scheduled';
}

function useLoyaltyPromos() {
  return useQuery<LoyaltyPromoRow[]>({
    queryKey: ['loyalty-promos'],
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('loyalty_promos')
        .select(
          'id, name, description, start_date, end_date, bonus_points, applicable_tiers, max_per_customer, is_active, created_at',
        )
        .order('start_date', { ascending: false });
      if (error) throw error;
      return ((data || []) as unknown) as LoyaltyPromoRow[];
    },
  });
}

export default function LoyaltyPromosTab() {
  const { roles } = useAuth();
  const rolesArr = roles as any[];
  const isAdmin = rolesArr.includes('admin');
  const isFinance = rolesArr.includes('finance');
  const canToggle = isAdmin || isFinance;
  const canEdit = isAdmin;

  const queryClient = useQueryClient();
  const { data, isLoading } = useLoyaltyPromos();

  const [pastOpen, setPastOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<LoyaltyPromoRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LoyaltyPromoRow | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const today = todayYmd();
  const promos = data ?? [];

  const grouped = useMemo(() => {
    const scheduled: LoyaltyPromoRow[] = [];
    const upcoming: LoyaltyPromoRow[] = [];
    const past: LoyaltyPromoRow[] = [];
    for (const p of promos) {
      const b = bucketOf(p, today);
      if (b === 'scheduled') scheduled.push(p);
      else if (b === 'upcoming') upcoming.push(p);
      else past.push(p);
    }
    // Active first inside scheduled, then by start_date desc.
    scheduled.sort((a, b) => {
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
      return b.start_date.localeCompare(a.start_date);
    });
    upcoming.sort((a, b) => a.start_date.localeCompare(b.start_date));
    past.sort((a, b) => b.end_date.localeCompare(a.end_date));
    return { scheduled, upcoming, past };
  }, [promos, today]);

  function handleNew() {
    setEditing(null);
    setFormOpen(true);
  }

  function handleEdit(p: LoyaltyPromoRow) {
    setEditing(p);
    setFormOpen(true);
  }

  function handleSaved() {
    queryClient.invalidateQueries({ queryKey: ['loyalty-promos'] });
  }

  async function handleToggle(p: LoyaltyPromoRow, next: boolean) {
    setTogglingId(p.id);
    try {
      const { error } = await supabase
        .from('loyalty_promos')
        .update({ is_active: next })
        .eq('id', p.id);
      if (error) throw error;
      toast.success(next ? 'Promo activated' : 'Promo paused');
      await queryClient.invalidateQueries({ queryKey: ['loyalty-promos'] });
    } catch (err: any) {
      toast.error(err?.message || 'Could not update promo');
    } finally {
      setTogglingId(null);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    try {
      const { error } = await supabase
        .from('loyalty_promos')
        .delete()
        .eq('id', deleteTarget.id);
      if (error) throw error;
      toast.success('Promo deleted');
      await queryClient.invalidateQueries({ queryKey: ['loyalty-promos'] });
    } catch (err: any) {
      toast.error(err?.message || 'Could not delete promo');
    } finally {
      setDeleteTarget(null);
    }
  }

  return (
    <div className="space-y-6">
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
              Award bonus points during promotional periods. Active promos automatically
              apply on eligible purchases.
            </p>
          </div>
        </div>
        {canEdit && (
          <Button onClick={handleNew} className="gold-gradient text-primary-foreground">
            <Plus className="h-4 w-4 mr-1.5" /> New Promo
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(2)].map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
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
                Past Promos {grouped.past.length > 0 ? `(${grouped.past.length})` : ''}
              </span>
              {pastOpen
                ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
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

      <LoyaltyPromoFormModal
        isOpen={formOpen}
        onClose={() => setFormOpen(false)}
        promo={editing}
        onSaved={handleSaved}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => (!o ? setDeleteTarget(null) : undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete promo?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleteTarget?.name}" will be removed permanently. Bonus points already
              awarded under this promo are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
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
}: {
  title: string;
  empty: string;
  promos: LoyaltyPromoRow[];
  today: string;
  canEdit: boolean;
  canToggle: boolean;
  togglingId: string | null;
  onEdit: (p: LoyaltyPromoRow) => void;
  onDelete: (p: LoyaltyPromoRow) => void;
  onToggle: (p: LoyaltyPromoRow, next: boolean) => void;
}) {
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
}: {
  promo: LoyaltyPromoRow;
  today: string;
  readOnly?: boolean;
  canEdit?: boolean;
  canToggle?: boolean;
  toggling?: boolean;
  onEdit?: (p: LoyaltyPromoRow) => void;
  onDelete?: (p: LoyaltyPromoRow) => void;
  onToggle?: (p: LoyaltyPromoRow, next: boolean) => void;
}) {
  const inWindow = promo.start_date <= today && today <= promo.end_date;
  const isPaused = inWindow && !promo.is_active;
  const tiers = promo.applicable_tiers && promo.applicable_tiers.length > 0
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
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-foreground font-display">
              {promo.name}
            </h4>
            {isPaused && (
              <span className="inline-flex items-center rounded-md border border-border bg-muted px-1.5 py-0.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                Paused
              </span>
            )}
            {readOnly && (
              <span className="inline-flex items-center rounded-md border border-border bg-muted px-1.5 py-0.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
                Past
              </span>
            )}
          </div>
          {promo.description && (
            <p className="text-xs text-muted-foreground mt-0.5">{promo.description}</p>
          )}
        </div>
        {!readOnly && canToggle && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[13px] text-muted-foreground">
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
        <Field label="Period" value={`${fmtDate(promo.start_date)} — ${fmtDate(promo.end_date)}`} />
        <Field label="Bonus" value={`+${Number(promo.bonus_points).toLocaleString()} pts`} />
        <Field label="Applicable tiers" value={tiers} />
        <Field
          label="Max per customer"
          value={promo.max_per_customer != null ? Number(promo.max_per_customer).toLocaleString() : 'Unlimited'}
        />
      </div>

      {!readOnly && canEdit && (
        <div className="mt-3 flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onEdit?.(promo)}
            className="h-7 px-2 text-[13px]"
          >
            <Pencil className="h-3 w-3 mr-1" /> Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onDelete?.(promo)}
            className="h-7 px-2 text-[13px] text-destructive hover:bg-destructive/10"
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
      <p className="text-[12px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-xs font-medium text-foreground">{value}</p>
    </div>
  );
}
