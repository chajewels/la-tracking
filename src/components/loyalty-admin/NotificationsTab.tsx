import { useMemo, useState } from 'react';
import {
  Bell, Plus, Pencil, X, Eye, Copy, Search, Sparkles, Crown, Cake, Gift,
  Megaphone, Settings as SettingsIcon, Send, Calendar, Users as UsersIcon,
  Clock, AlertCircle, CheckCircle2, Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  useLoyaltyNotifications,
  useCancelNotification,
  type LoyaltyNotificationWithStats,
  type NotificationCategory,
  type NotificationStatus,
  type NotificationFilters,
} from '@/hooks/loyalty-admin/useLoyaltyNotifications';
import NotificationComposeDialog from '@/components/loyalty-admin/NotificationComposeDialog';

const STATUS_FILTERS: Array<{ value: NotificationStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'sending', label: 'Sending' },
  { value: 'sent', label: 'Sent' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'failed', label: 'Failed' },
];

const CATEGORY_FILTERS: Array<{ value: NotificationCategory | 'all'; label: string }> = [
  { value: 'all', label: 'All categories' },
  { value: 'info', label: 'Info' },
  { value: 'promo', label: 'Promo' },
  { value: 'tier', label: 'Tier' },
  { value: 'system', label: 'System' },
  { value: 'reward', label: 'Reward' },
  { value: 'birthday', label: 'Birthday' },
  { value: 'expiry', label: 'Expiry' },
];

const CATEGORY_ICON: Record<NotificationCategory, typeof Megaphone> = {
  info: Megaphone,
  promo: Sparkles,
  tier: Crown,
  system: SettingsIcon,
  reward: Gift,
  birthday: Cake,
  expiry: Clock,
};

const STATUS_STYLES: Record<NotificationStatus, { label: string; className: string }> = {
  draft:     { label: 'Draft',     className: 'bg-muted text-muted-foreground border-border' },
  scheduled: { label: 'Scheduled', className: 'bg-blue-500/10 text-blue-700 border-blue-500/30' },
  sending:   { label: 'Sending',   className: 'bg-amber-500/10 text-amber-700 border-amber-500/30' },
  sent:      { label: 'Sent',      className: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30' },
  cancelled: { label: 'Cancelled', className: 'bg-muted text-muted-foreground border-border' },
  failed:    { label: 'Failed',    className: 'bg-destructive/10 text-destructive border-destructive/30' },
};

function fmtPht(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }) + ' PHT';
}

function audienceLabel(n: LoyaltyNotificationWithStats): string {
  if (n.audience_type === 'all') return 'All members';
  if (n.audience_type === 'tier') {
    return n.audience_tiers && n.audience_tiers.length > 0
      ? `Tier${n.audience_tiers.length > 1 ? 's' : ''}: ${n.audience_tiers.join(', ')}`
      : 'Tier: —';
  }
  return n.stats.total > 0
    ? `${n.stats.total} specific member(s)`
    : `${(n.audience_member_ids ?? []).length} specific member(s)`;
}

export default function NotificationsTab() {
  const [statusFilter, setStatusFilter] = useState<NotificationStatus | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<NotificationCategory | 'all'>('all');
  const [search, setSearch] = useState('');
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeMode, setComposeMode] = useState<'create' | 'edit' | 'duplicate'>('create');
  const [composeSource, setComposeSource] = useState<LoyaltyNotificationWithStats | null>(null);
  const [cancelTarget, setCancelTarget] = useState<LoyaltyNotificationWithStats | null>(null);

  const filters: NotificationFilters = useMemo(() => {
    const f: NotificationFilters = {};
    if (statusFilter !== 'all') f.status = [statusFilter];
    if (categoryFilter !== 'all') f.category = [categoryFilter];
    return f;
  }, [statusFilter, categoryFilter]);

  const { data, isLoading, isError } = useLoyaltyNotifications(filters);
  const cancelMutation = useCancelNotification();

  const visible = useMemo(() => {
    const list = data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.body.toLowerCase().includes(q),
    );
  }, [data, search]);

  function handleNew() {
    setComposeMode('create');
    setComposeSource(null);
    setComposeOpen(true);
  }

  function handleEdit(n: LoyaltyNotificationWithStats) {
    if (!['draft', 'scheduled'].includes(n.status)) {
      toast.error(`Cannot edit a ${n.status} notification`);
      return;
    }
    setComposeMode('edit');
    setComposeSource(n);
    setComposeOpen(true);
  }

  function handleView(n: LoyaltyNotificationWithStats) {
    setComposeMode('edit'); // editLocked banner inside the dialog handles read-only UX
    setComposeSource(n);
    setComposeOpen(true);
  }

  function handleDuplicate(n: LoyaltyNotificationWithStats) {
    setComposeMode('duplicate');
    setComposeSource(n);
    setComposeOpen(true);
  }

  function handleCloseCompose() {
    setComposeOpen(false);
    setComposeSource(null);
    setComposeMode('create');
  }

  async function confirmCancel() {
    if (!cancelTarget) return;
    try {
      await cancelMutation.mutateAsync(cancelTarget.id);
      toast.success('Notification cancelled.');
      setCancelTarget(null);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to cancel notification');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-primary" />
          <h2 className="text-base font-semibold text-foreground font-display">
            Notifications
          </h2>
        </div>
        <Button
          onClick={handleNew}
          size="sm"
          className="gold-gradient text-primary-foreground"
        >
          <Plus className="h-3.5 w-3.5 mr-1" /> Send Notification
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as NotificationStatus | 'all')}
        >
          <SelectTrigger className="h-9 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={categoryFilter}
          onValueChange={(v) => setCategoryFilter(v as NotificationCategory | 'all')}
        >
          <SelectTrigger className="h-9 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CATEGORY_FILTERS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title or body…"
            className="pl-7 h-9 text-xs"
          />
        </div>
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-44 w-full rounded-xl" />
          ))}
        </div>
      )}

      {isError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          Failed to load notifications. Try refreshing.
        </div>
      )}

      {!isLoading && !isError && visible.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mb-3">
            <Bell className="h-6 w-6 text-primary" />
          </div>
          <p className="text-base font-semibold text-foreground font-display">
            No notifications yet
          </p>
          <p className="text-xs text-muted-foreground mt-1 max-w-xs">
            Send your first loyalty notification — members see it in the portal's
            Notifications tab.
          </p>
          <Button
            onClick={handleNew}
            size="sm"
            className="gold-gradient text-primary-foreground mt-4"
          >
            <Plus className="h-3.5 w-3.5 mr-1" /> Send Notification
          </Button>
        </div>
      )}

      {!isLoading && !isError && visible.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {visible.map((n) => (
            <NotificationCard
              key={n.id}
              notif={n}
              onEdit={() => handleEdit(n)}
              onView={() => handleView(n)}
              onDuplicate={() => handleDuplicate(n)}
              onCancel={() => setCancelTarget(n)}
            />
          ))}
        </div>
      )}

      <NotificationComposeDialog
        open={composeOpen}
        notification={composeSource}
        mode={composeMode}
        onClose={handleCloseCompose}
      />

      <AlertDialog
        open={cancelTarget !== null}
        onOpenChange={(o) => !o && setCancelTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel scheduled notification?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p className="font-medium text-foreground">{cancelTarget?.title}</p>
                {cancelTarget?.scheduled_for && (
                  <p className="text-muted-foreground">
                    Was scheduled for {fmtPht(cancelTarget.scheduled_for)}.
                  </p>
                )}
                <p className="text-muted-foreground">
                  Recipients will not be notified. This cannot be undone.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelMutation.isPending}>
              Keep scheduled
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmCancel}
              disabled={cancelMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cancelMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              )}
              Cancel notification
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface NotificationCardProps {
  notif: LoyaltyNotificationWithStats;
  onEdit: () => void;
  onView: () => void;
  onDuplicate: () => void;
  onCancel: () => void;
}

function NotificationCard({
  notif, onEdit, onView, onDuplicate, onCancel,
}: NotificationCardProps) {
  // Defensive fallbacks: loyalty_notifications.category and .status are
  // free-text columns (not Postgres enums), so backend processes can
  // introduce unknown values. Without these guards, an unknown category
  // would set Icon=undefined and crash the entire tab (React #130) since
  // no ErrorBoundary catches it.
  const Icon = CATEGORY_ICON[notif.category] ?? Megaphone;
  const status = STATUS_STYLES[notif.status] ?? STATUS_STYLES.draft;
  const showStats = notif.status === 'sent' && notif.stats.total > 0;
  const readPct = showStats ? Math.round(notif.stats.read_rate * 100) : 0;

  // Per-status action matrix:
  //   draft     → Edit
  //   scheduled → Edit + Cancel
  //   sending   → View only (in-progress, no admin action)
  //   sent      → View + Duplicate (Duplicate is the primary action)
  //   cancelled → View + Duplicate
  //   failed    → View + Duplicate
  const canEdit = notif.status === 'draft' || notif.status === 'scheduled';
  const canCancel = notif.status === 'scheduled';
  const canDuplicate =
    notif.status === 'sent' ||
    notif.status === 'cancelled' ||
    notif.status === 'failed';

  return (
    <div className="rounded-xl border bg-card p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${status.className}`}
        >
          {status.label}
        </span>
        <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-1.5 py-0.5 text-[10px] font-semibold text-foreground">
          <Icon className="h-3 w-3" />
          {notif.category}
        </span>
        {notif.send_email && (
          <span className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
            <Send className="h-3 w-3" /> Email
          </span>
        )}
      </div>

      <div className="space-y-1">
        <h4 className="text-sm font-semibold text-foreground font-display line-clamp-1">
          {notif.title}
        </h4>
        <p className="text-xs text-muted-foreground line-clamp-2">{notif.body}</p>
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <UsersIcon className="h-3 w-3 shrink-0" />
        <span className="truncate">{audienceLabel(notif)}</span>
      </div>

      {showStats && (
        <div className="rounded-md border border-border bg-background p-2 grid grid-cols-3 gap-2 text-xs">
          <Stat label="Recipients" value={notif.stats.total.toLocaleString()} />
          <Stat label="Read" value={notif.stats.read_count.toLocaleString()} />
          <Stat label="Read rate" value={`${readPct}%`} />
        </div>
      )}

      <div className="text-[10px] text-muted-foreground space-y-0.5 border-t border-border pt-2">
        <Timestamp icon={Clock}    label="Created"   value={fmtPht(notif.created_at)} />
        {notif.scheduled_for && (
          <Timestamp icon={Calendar} label="Scheduled" value={fmtPht(notif.scheduled_for)} />
        )}
        {notif.sent_at && (
          <Timestamp icon={CheckCircle2} label="Sent" value={fmtPht(notif.sent_at)} />
        )}
        {notif.expires_at && (
          <Timestamp icon={AlertCircle} label="Expires" value={fmtPht(notif.expires_at)} />
        )}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        {canEdit && (
          <Button
            size="sm"
            variant="outline"
            onClick={onEdit}
            className="h-7 px-2 text-[11px]"
          >
            <Pencil className="h-3 w-3 mr-1" /> Edit
          </Button>
        )}
        {!canEdit && (
          <Button
            size="sm"
            variant="outline"
            onClick={onView}
            className="h-7 px-2 text-[11px]"
          >
            <Eye className="h-3 w-3 mr-1" /> View
          </Button>
        )}
        {canDuplicate && (
          <Button
            size="sm"
            onClick={onDuplicate}
            className="h-7 px-2 text-[11px] gold-gradient text-primary-foreground"
          >
            <Copy className="h-3 w-3 mr-1" /> Duplicate
          </Button>
        )}
        {canCancel && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onCancel}
            className="h-7 px-2 text-[11px] text-destructive hover:bg-destructive/10"
          >
            <X className="h-3 w-3 mr-1" /> Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-xs font-semibold text-foreground mt-0.5">{value}</p>
    </div>
  );
}

function Timestamp({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
}) {
  return (
    <p className="flex items-center gap-1">
      <Icon className="h-2.5 w-2.5" />
      <span>{label}: {value}</span>
    </p>
  );
}
