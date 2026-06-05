import { useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  Bell,
  AlertTriangle,
  CheckCircle,
  Sparkles,
  FileText,
  UserPlus,
  Mail,
  ShieldAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { ROUTES } from '@/constants/routes';
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

function iconForType(type: string) {
  switch (type) {
    case 'loyalty_award':
      return <Sparkles className="h-3.5 w-3.5 text-primary" />;
    case 'loyalty_award_failed':
      return <ShieldAlert className="h-3.5 w-3.5 text-destructive" />;
    case 'submission_created':
    case 'submission_confirmed':
    case 'submission_rejected':
      return <FileText className="h-3.5 w-3.5 text-blue-400" />;
    case 'account_created':
      return <UserPlus className="h-3.5 w-3.5 text-emerald-400" />;
    case 'customer_notified':
      return <Mail className="h-3.5 w-3.5 text-amber-400" />;
    case 'extension_requested':
    case 'extension_granted':
    case 'waiver_requested':
    case 'waiver_approved':
    case 'waiver_rejected':
      return <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />;
    default:
      return <CheckCircle className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

export default function StaffNotificationBell() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, session } = useAuth();

  const { data: notifications = [] } = useQuery<StaffNotificationRow[]>({
    queryKey: ['staff-notifications'],
    enabled: !!session,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('staff_notifications' as any)
        .select(
          'id, type, title, body, account_id, customer_id, invoice_number, metadata, created_at'
        )
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as StaffNotificationRow[];
    },
  });

  const notificationIds = useMemo(() => notifications.map((n) => n.id), [notifications]);

  const { data: readIds = new Set<string>() } = useQuery<Set<string>>({
    queryKey: ['staff-notification-reads', user?.id, notificationIds],
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
      for (const row of (data ?? []) as Array<{ notification_id: string }>) {
        set.add(row.notification_id);
      }
      return set;
    },
  });

  const unreadCount = useMemo(
    () => notifications.filter((n) => !readIds.has(n.id)).length,
    [notifications, readIds]
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
      queryClient.invalidateQueries({ queryKey: ['staff-notification-reads', user?.id] });
    },
  });

  const handleItemClick = (n: StaffNotificationRow) => {
    if (!readIds.has(n.id)) {
      markRead.mutate([n.id]);
    }
    if (n.account_id) {
      navigate(`/accounts/${n.account_id}`);
    }
  };

  const handleMarkAllRead = () => {
    const unreadIds = notifications.filter((n) => !readIds.has(n.id)).map((n) => n.id);
    if (unreadIds.length > 0) {
      markRead.mutate(unreadIds);
    }
  };

  const badgeLabel = unreadCount > 9 ? '9+' : String(unreadCount);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-primary hover:text-white hover:bg-white/10 relative"
          aria-label="Notifications"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 inline-flex items-center justify-center rounded-full bg-red-500 text-[10px] font-semibold text-white">
              {badgeLabel}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[22rem] p-0 bg-zinc-950 border border-border text-foreground"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Notifications</h3>
            {unreadCount > 0 && (
              <span className="text-[10px] font-medium text-muted-foreground">
                {unreadCount} unread
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-primary hover:text-primary/80"
            onClick={handleMarkAllRead}
            disabled={unreadCount === 0 || markRead.isPending}
          >
            Mark all read
          </Button>
        </div>

        <ScrollArea className="max-h-96">
          {notifications.length === 0 ? (
            <div className="py-12 text-center text-xs text-muted-foreground">
              No notifications yet.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {notifications.map((n) => {
                const isUnread = !readIds.has(n.id);
                const isFailure = n.type === 'loyalty_award_failed';
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
                      isFailure && 'border-l-2 border-l-destructive bg-destructive/[0.06]'
                    )}
                  >
                    <div className="mt-0.5 shrink-0">{iconForType(n.type)}</div>
                    <div className="flex-1 min-w-0">
                      <div
                        className={cn(
                          'text-xs leading-tight',
                          isUnread ? 'font-semibold text-foreground' : 'text-foreground/80',
                          isFailure && 'text-destructive'
                        )}
                      >
                        {n.title}
                      </div>
                      {n.body && (
                        <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2">
                          {n.body}
                        </p>
                      )}
                      <div className="mt-1 flex items-center gap-2">
                        <span className="text-[10px] text-muted-foreground">
                          {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                        </span>
                        {n.invoice_number && (
                          <span className="text-[10px] text-muted-foreground">
                            · INV #{n.invoice_number}
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>

        <div className="border-t border-border px-4 py-2">
          <Link
            to={ROUTES.MONITORING}
            className="text-[11px] text-muted-foreground hover:text-primary transition-colors"
          >
            Open Monitoring →
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
