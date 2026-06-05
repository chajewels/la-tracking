import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow, format } from 'date-fns';
import {
  Bell,
  AlertTriangle,
  CheckCircle,
  Sparkles,
  FileText,
  UserPlus,
  Mail,
  ShieldAlert,
  CircleDot,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';

interface StaffNotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  account_id: string | null;
  customer_id: string | null;
  invoice_number: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

const PAGE_SIZE = 25;

function iconForType(type: string) {
  switch (type) {
    case 'loyalty_award':
      return <Sparkles className="h-4 w-4 text-primary" />;
    case 'loyalty_award_failed':
    case 'loyalty_award_missing':
      return <ShieldAlert className="h-4 w-4 text-destructive" />;
    case 'submission_created':
    case 'submission_confirmed':
    case 'submission_rejected':
      return <FileText className="h-4 w-4 text-blue-400" />;
    case 'account_created':
      return <UserPlus className="h-4 w-4 text-emerald-400" />;
    case 'customer_notified':
      return <Mail className="h-4 w-4 text-amber-400" />;
    case 'extension_requested':
    case 'extension_granted':
    case 'waiver_requested':
    case 'waiver_approved':
    case 'waiver_rejected':
      return <AlertTriangle className="h-4 w-4 text-amber-400" />;
    default:
      return <CheckCircle className="h-4 w-4 text-muted-foreground" />;
  }
}

export default function NotificationsPanel() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, session } = useAuth();

  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(0);

  // Distinct types — read once (cheap) for the filter dropdown.
  const { data: distinctTypes = [] } = useQuery<string[]>({
    queryKey: ['staff-notifications-types'],
    enabled: !!session,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('staff_notifications' as any)
        .select('type')
        .limit(2000);
      if (error) throw error;
      const set = new Set<string>();
      for (const row of (data ?? []) as unknown as Array<{ type: string }>) {
        if (row.type) set.add(row.type);
      }
      return Array.from(set).sort();
    },
  });

  const { data: notifications = [], isLoading } = useQuery<StaffNotificationRow[]>({
    queryKey: ['staff-notifications-panel', typeFilter, page],
    enabled: !!session,
    refetchInterval: 60_000,
    queryFn: async () => {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      let q = supabase
        .from('staff_notifications' as any)
        .select(
          'id, type, title, body, account_id, customer_id, invoice_number, metadata, created_at'
        )
        .order('created_at', { ascending: false })
        .range(from, to);
      if (typeFilter !== 'all') q = q.eq('type', typeFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as StaffNotificationRow[];
    },
  });

  const notificationIds = useMemo(() => notifications.map(n => n.id), [notifications]);

  const { data: readIds = new Set<string>() } = useQuery<Set<string>>({
    queryKey: ['staff-notification-reads-panel', user?.id, notificationIds],
    enabled: !!session && !!user?.id && notificationIds.length > 0,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('staff_notification_reads' as any)
        .select('notification_id')
        .eq('user_id', user!.id)
        .in('notification_id', notificationIds);
      if (error) throw error;
      const set = new Set<string>();
      for (const row of (data ?? []) as unknown as Array<{ notification_id: string }>) {
        set.add(row.notification_id);
      }
      return set;
    },
  });

  const visible = useMemo(
    () => (unreadOnly ? notifications.filter(n => !readIds.has(n.id)) : notifications),
    [notifications, readIds, unreadOnly]
  );

  const markRead = useMutation({
    mutationFn: async (ids: string[]) => {
      if (!user?.id || ids.length === 0) return;
      const rows = ids.map((notification_id) => ({
        notification_id,
        user_id: user.id,
      }));
      const { error } = await supabase
        .from('staff_notification_reads' as any)
        .upsert(rows, { onConflict: 'notification_id,user_id', ignoreDuplicates: true });
      if (error && !/duplicate key|unique constraint/i.test(error.message ?? '')) {
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staff-notification-reads-panel', user?.id] });
      queryClient.invalidateQueries({ queryKey: ['staff-notification-reads', user?.id] });
    },
  });

  const handleItemClick = (n: StaffNotificationRow) => {
    if (!readIds.has(n.id)) markRead.mutate([n.id]);
    if (n.account_id) {
      navigate(`/accounts/${n.account_id}`);
      return;
    }
    const cashOrderId = (n.metadata as { cash_order_id?: string } | null)?.cash_order_id;
    if (cashOrderId) navigate(`/cash-orders/${cashOrderId}`);
  };

  const handleMarkAllRead = () => {
    const ids = visible.filter(n => !readIds.has(n.id)).map(n => n.id);
    if (ids.length > 0) markRead.mutate(ids);
  };

  const unreadInPage = visible.filter(n => !readIds.has(n.id)).length;
  const hasNextPage = notifications.length === PAGE_SIZE;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Notifications</h3>
            <span className="text-xs text-muted-foreground">
              {visible.length} shown · {unreadInPage} unread
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleMarkAllRead}
            disabled={unreadInPage === 0 || markRead.isPending}
          >
            Mark all read
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Type</Label>
            <Select
              value={typeFilter}
              onValueChange={(v) => { setTypeFilter(v); setPage(0); }}
            >
              <SelectTrigger className="h-8 w-[200px] text-xs">
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {distinctTypes.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="unread-only"
              checked={unreadOnly}
              onCheckedChange={setUnreadOnly}
            />
            <Label htmlFor="unread-only" className="text-xs text-muted-foreground cursor-pointer">
              Unread only
            </Label>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Loading notifications…
          </div>
        ) : visible.length === 0 ? (
          <div className="py-16 text-center text-xs text-muted-foreground">
            No notifications match the current filters.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((n) => {
              const isUnread = !readIds.has(n.id);
              const isFailure = n.type === 'loyalty_award_failed';
              const isMissing = n.type === 'loyalty_award_missing';
              const accent = isFailure ? 'destructive' : isMissing ? 'amber' : null;
              return (
                <li
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleItemClick(n)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleItemClick(n);
                    }
                  }}
                  className={cn(
                    'px-4 py-3 cursor-pointer transition-colors flex gap-3 items-start',
                    isUnread ? 'bg-primary/[0.04] hover:bg-primary/[0.08]' : 'hover:bg-white/[0.04]',
                    accent === 'destructive' && 'border-l-2 border-l-destructive bg-destructive/[0.06]',
                    accent === 'amber' && 'border-l-2 border-l-amber-500 bg-amber-500/[0.06]'
                  )}
                >
                  <div className="mt-0.5 shrink-0 flex flex-col items-center gap-1">
                    {iconForType(n.type)}
                    {isUnread && <CircleDot className="h-2.5 w-2.5 text-primary" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={cn(
                          'text-sm leading-tight',
                          isUnread ? 'font-semibold text-foreground' : 'text-foreground/85',
                          isFailure && 'text-destructive'
                        )}
                      >
                        {n.title}
                      </span>
                      <Badge variant="outline" className="text-[10px]">{n.type}</Badge>
                      {n.invoice_number && (
                        <Badge variant="outline" className="text-[10px]">INV #{n.invoice_number}</Badge>
                      )}
                    </div>
                    {n.body && (
                      <p className="mt-1 text-xs text-foreground/80 whitespace-pre-line">{n.body}</p>
                    )}
                    <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted-foreground">
                      <span>{formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}</span>
                      <span>· {format(new Date(n.created_at), 'yyyy-MM-dd HH:mm')}</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex items-center justify-between border-t border-border px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            ← Previous
          </Button>
          <span className="text-xs text-muted-foreground">Page {page + 1}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={!hasNextPage}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </Button>
        </div>
      </div>
    </div>
  );
}
