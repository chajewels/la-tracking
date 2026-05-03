import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Crown, Coins, Gift, Cake, Tag, ShoppingBag, Star, Shield, Activity, Award,
  Users, Megaphone, Settings, Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toPHTDateString } from '@/lib/date-utils';
import type { LoyaltyTab } from '@/components/loyalty/LoyaltyBottomNav';

const categoryIcons: Record<string, typeof Crown> = {
  // Phase 4 admin-pickable categories
  info: Megaphone,
  promo: Tag,
  tier: Crown,
  system: Settings,
  reward: Gift,
  birthday: Cake,
  // Categories reserved for future Phase 4.2 auto-triggers; mapping kept
  // so existing data renders sensibly even before those are emitted.
  points: Coins,
  redemption: Gift,
  order: ShoppingBag,
  vip: Star,
  expiry: Shield,
  security: Shield,
  activity: Activity,
  milestone: Award,
  referral: Users,
};

type FilterType = 'all' | 'unread';

interface PortalNotification {
  id: string;
  title: string;
  body: string;
  category: string;
  link_target: string | null;
  expires_at: string | null;
  created_at: string;
  is_read: boolean;
  read_at: string | null;
}

interface NotificationsScreenProps {
  notifications: PortalNotification[];
  portalToken: string | null;
  sessionId: string | null;
  onSetTab: (tab: LoyaltyTab) => void;
}

const VALID_TABS = new Set<LoyaltyTab>([
  'home', 'rewards', 'points', 'notifications', 'profile', 'tiers',
]);

function dateLabel(iso: string, todayPht: string, yesterdayPht: string): string {
  const ymd = toPHTDateString(iso);
  if (ymd === todayPht) return 'Today';
  if (ymd === yesterdayPht) return 'Yesterday';
  // "Apr 28" / "Mar 15" — older entries
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso));
}

function previousPhtDate(todayPht: string): string {
  // todayPht is YYYY-MM-DD; subtract one day in UTC then re-format in PHT.
  // PHT has no DST so subtracting 24h is safe.
  const d = new Date(todayPht + 'T12:00:00Z'); // noon UTC anchor avoids tz boundary edge cases
  d.setUTCDate(d.getUTCDate() - 1);
  return toPHTDateString(d);
}

export default function NotificationsScreen({
  notifications,
  portalToken,
  sessionId,
  onSetTab,
}: NotificationsScreenProps) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<FilterType>('all');
  // Optimistic shadow — mirrors `notifications` on first render and is
  // updated locally on click for a snappy UI; reconciles back when the
  // parent refetches and passes a fresh array.
  const [localRead, setLocalRead] = useState<Record<string, boolean>>({});

  // Reset local optimistic overrides whenever the source array identity
  // changes (refetch landed). Items still optimistically marked but not
  // yet confirmed by the refetch are dropped; the new prop carries truth.
  useEffect(() => {
    setLocalRead({});
  }, [notifications]);

  const merged = useMemo(
    () =>
      notifications.map((n) => ({
        ...n,
        is_read: localRead[n.id] ?? n.is_read,
      })),
    [notifications, localRead],
  );

  const filtered = filter === 'unread' ? merged.filter((n) => !n.is_read) : merged;
  const unreadCount = merged.filter((n) => !n.is_read).length;

  const todayPht = toPHTDateString(new Date());
  const yesterdayPht = previousPhtDate(todayPht);

  // Group by computed date label, preserving newest-first order.
  const groups = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, typeof filtered>();
    for (const n of filtered) {
      const label = dateLabel(n.created_at, todayPht, yesterdayPht);
      if (!map.has(label)) {
        map.set(label, []);
        order.push(label);
      }
      map.get(label)!.push(n);
    }
    return { order, map };
  }, [filtered, todayPht, yesterdayPht]);

  const markReadMutation = useMutation({
    mutationFn: async (vars: { mode: 'single' | 'all'; notification_id?: string }) => {
      const { data, error } = await supabase.functions.invoke(
        'mark-loyalty-notification-read',
        {
          body: {
            mode: vars.mode,
            notification_id: vars.notification_id,
            session_id: sessionId ?? undefined,
            portal_token: portalToken ?? undefined,
          },
        },
      );
      if (error) throw error;
      if (data?.error) throw new Error(data.detail || data.error);
      return data;
    },
    onSuccess: () => {
      // Refetch the portal so the parent's notifications array picks up
      // the persisted is_read flips. Our local optimistic shadow resets
      // when the new notifications array prop arrives.
      queryClient.invalidateQueries({ queryKey: ['portal'] });
    },
  });

  function handleClick(n: PortalNotification) {
    if (markReadMutation.isPending) return;

    // Optimistic mark-as-read on first click
    if (!n.is_read && !localRead[n.id]) {
      setLocalRead((prev) => ({ ...prev, [n.id]: true }));
      markReadMutation.mutate(
        { mode: 'single', notification_id: n.id },
        {
          onError: (err: any) => {
            // Roll back the optimistic flip
            setLocalRead((prev) => {
              const { [n.id]: _, ...rest } = prev;
              return rest;
            });
            toast.error(err?.message || 'Failed to mark as read');
          },
        },
      );
    }

    // Link target navigation
    const target = n.link_target;
    if (!target) return;
    if (target.startsWith('tab:')) {
      const tab = target.slice(4) as LoyaltyTab;
      if (VALID_TABS.has(tab)) onSetTab(tab);
    } else if (target.startsWith('http://') || target.startsWith('https://')) {
      window.open(target, '_blank', 'noopener,noreferrer');
    }
  }

  function handleMarkAllRead() {
    if (markReadMutation.isPending || unreadCount === 0) return;
    // Optimistic — flip every unread row locally
    const ids = merged.filter((n) => !n.is_read).map((n) => n.id);
    setLocalRead((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = true;
      return next;
    });
    markReadMutation.mutate(
      { mode: 'all' },
      {
        onSuccess: (data: any) => {
          const count = data?.updated_count ?? ids.length;
          toast.success(
            count === 1
              ? 'Marked 1 notification as read'
              : `Marked ${count} notifications as read`,
          );
        },
        onError: (err: any) => {
          // Roll back
          setLocalRead((prev) => {
            const next = { ...prev };
            for (const id of ids) delete next[id];
            return next;
          });
          toast.error(err?.message || 'Failed to mark all as read');
        },
      },
    );
  }

  const renderGroup = (title: string, items: typeof filtered) => {
    if (items.length === 0) return null;
    return (
      <div key={title} className="space-y-2">
        <p className="text-[12px] text-muted-foreground font-body tracking-[0.2em] uppercase">
          {title}
        </p>
        {items.map((notif) => {
          const Icon = categoryIcons[notif.category] || Star;
          return (
            <motion.button
              key={notif.id}
              type="button"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              onClick={() => handleClick(notif)}
              className={`w-full text-left rounded-xl p-4 shadow-card border-gold-accent bg-card transition-colors ${
                !notif.is_read ? 'border-l-2 border-l-primary' : ''
              } ${notif.link_target ? 'hover:bg-muted/30' : ''}`}
            >
              <div className="flex gap-3">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                    !notif.is_read ? 'bg-primary/10' : 'bg-muted'
                  }`}
                >
                  <Icon
                    size={14}
                    className={!notif.is_read ? 'text-primary' : 'text-muted-foreground'}
                  />
                </div>
                <div className="flex-1">
                  <p
                    className={`text-[13px] font-body font-medium ${
                      !notif.is_read ? 'text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    {notif.title}
                  </p>
                  <p className="text-[12px] text-muted-foreground font-body mt-1 leading-relaxed">
                    {notif.body}
                  </p>
                  <p className="text-[11px] text-muted-foreground/60 font-body mt-2">
                    {dateLabel(notif.created_at, todayPht, yesterdayPht)}
                  </p>
                </div>
                {!notif.is_read && (
                  <div className="w-2 h-2 rounded-full bg-primary mt-1 flex-shrink-0" />
                )}
              </div>
            </motion.button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="px-5 pt-6 pb-4 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[12px] text-muted-foreground font-body tracking-[0.2em] uppercase">
            Stay Updated
          </p>
          <h1 className="font-display text-2xl font-semibold text-foreground mt-1">
            Notifications
          </h1>
        </div>
        <button
          type="button"
          onClick={handleMarkAllRead}
          disabled={markReadMutation.isPending || unreadCount === 0}
          className="text-[12px] text-primary font-body font-semibold disabled:opacity-40 inline-flex items-center gap-1"
        >
          {markReadMutation.isPending && (
            <Loader2 className="h-3 w-3 animate-spin" />
          )}
          Mark all read
        </button>
      </div>

      <div className="flex gap-2">
        {(['all', 'unread'] as FilterType[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full text-[13px] font-body font-medium capitalize transition-colors ${
              filter === f
                ? 'gradient-gold text-primary-foreground shadow-sm'
                : 'bg-card text-muted-foreground shadow-card border-gold-accent'
            }`}
          >
            {f === 'all' ? 'All' : `Unread (${unreadCount})`}
          </button>
        ))}
      </div>

      <div className="space-y-5">
        {groups.order.map((label) => renderGroup(label, groups.map.get(label)!))}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-16">
          <span className="text-4xl mb-4 block">✨</span>
          <p className="font-display text-lg text-foreground">All caught up!</p>
          <p className="text-[13px] text-muted-foreground font-body mt-1">
            {filter === 'unread'
              ? 'No unread notifications.'
              : 'No notifications from Cha Jewels yet.'}
          </p>
        </div>
      )}
    </div>
  );
}
