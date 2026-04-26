import { useState } from 'react';
import { motion } from 'framer-motion';
import { Bell, BellOff } from 'lucide-react';
import { NOTIFICATIONS, type FallbackNotification } from '@/components/loyalty/staticFallback';

type FilterType = 'all' | 'unread';

const CATEGORY_META: Record<FallbackNotification['category'], { icon: string; color: string }> = {
  tier:      { icon: '👑', color: 'hsl(43,74%,52%)' },
  points:    { icon: '✨', color: 'hsl(43,74%,52%)' },
  redemption:{ icon: '🎁', color: 'hsl(280,60%,55%)' },
  birthday:  { icon: '🎂', color: 'hsl(340,70%,55%)' },
  promo:     { icon: '🏷️', color: 'hsl(200,70%,50%)' },
  order:     { icon: '💎', color: 'hsl(43,74%,52%)' },
  vip:       { icon: '💫', color: 'hsl(43,74%,52%)' },
  expiry:    { icon: '⏳', color: 'hsl(30,80%,50%)' },
  security:  { icon: '🔐', color: 'hsl(0,60%,50%)' },
  activity:  { icon: '✅', color: 'hsl(140,50%,45%)' },
  milestone: { icon: '🎉', color: 'hsl(43,74%,52%)' },
  referral:  { icon: '🤝', color: 'hsl(180,55%,45%)' },
};

export default function NotificationsScreen() {
  const [filter, setFilter] = useState<FilterType>('all');
  const [readIds, setReadIds] = useState<Set<string>>(
    () => new Set(NOTIFICATIONS.filter((n) => n.isRead).map((n) => n.id)),
  );

  const markAllRead = () => setReadIds(new Set(NOTIFICATIONS.map((n) => n.id)));

  const filtered = filter === 'unread'
    ? NOTIFICATIONS.filter((n) => !readIds.has(n.id))
    : NOTIFICATIONS;

  const unreadCount = NOTIFICATIONS.filter((n) => !readIds.has(n.id)).length;

  // Group by date label
  const groups: { label: string; items: FallbackNotification[] }[] = [];
  const seen = new Set<string>();
  for (const n of filtered) {
    if (!seen.has(n.date)) { seen.add(n.date); groups.push({ label: n.date, items: [] }); }
    groups[groups.length - 1]!.items.push(n);
  }
  // Re-sort so Today/Yesterday always come first
  const ORDER = ['Today', 'Yesterday'];
  groups.sort((a, b) => {
    const ai = ORDER.indexOf(a.label);
    const bi = ORDER.indexOf(b.label);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return 0;
  });

  return (
    <div className="px-5 pt-6 pb-24 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[11px] text-muted-foreground font-body tracking-[0.2em] uppercase">
            Stay Updated
          </p>
          <h1 className="font-display text-2xl font-semibold text-foreground mt-1">
            Notifications
          </h1>
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={markAllRead}
            className="text-[11px] font-body font-semibold text-primary mt-1 flex-shrink-0"
          >
            Mark all read
          </button>
        )}
      </div>

      {/* Filter pills */}
      <div className="flex gap-2">
        {(['all', 'unread'] as FilterType[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={`px-3 py-1.5 rounded-full text-[12px] font-body font-medium transition-colors ${
              filter === key
                ? 'gradient-gold text-primary-foreground shadow-sm'
                : 'bg-card text-muted-foreground shadow-card border-gold-accent'
            }`}
          >
            {key === 'all' ? 'All' : `Unread${unreadCount > 0 ? ` (${unreadCount})` : ''}`}
          </button>
        ))}
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="mt-8 rounded-2xl bg-card border-gold-accent shadow-card p-8 text-center space-y-3">
          <BellOff className="h-9 w-9 text-primary mx-auto opacity-40" />
          <p className="font-display text-base font-semibold text-foreground">All caught up!</p>
          <p className="text-[12px] text-muted-foreground font-body">No unread notifications.</p>
        </div>
      )}

      {/* Grouped notifications */}
      {groups.map((group, gi) => (
        <div key={group.label} className="space-y-2">
          {/* Date label */}
          <div className="flex items-center gap-3">
            <p className="text-[11px] font-body font-semibold text-muted-foreground tracking-wider uppercase flex-shrink-0">
              {group.label}
            </p>
            <div className="flex-1 h-px" style={{ background: 'hsla(36,30%,60%,0.15)' }} />
          </div>

          {group.items.map((notif, i) => {
            const isRead = readIds.has(notif.id);
            const meta = CATEGORY_META[notif.category];
            return (
              <motion.button
                key={notif.id}
                type="button"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.06 * i + 0.05 * gi }}
                onClick={() => setReadIds((prev) => new Set([...prev, notif.id]))}
                className={`w-full text-left rounded-2xl p-4 shadow-card transition-colors ${
                  isRead ? 'bg-card' : 'bg-card'
                }`}
                style={{ border: isRead ? '1px solid hsla(36,30%,60%,0.12)' : `1px solid ${meta.color}33` }}
              >
                <div className="flex items-start gap-3">
                  {/* Icon */}
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center text-lg flex-shrink-0 mt-0.5"
                    style={{ background: `${meta.color}1A` }}
                  >
                    {meta.icon}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p
                        className={`text-[13px] font-body leading-tight ${
                          isRead ? 'font-medium text-foreground' : 'font-semibold text-foreground'
                        }`}
                      >
                        {notif.title}
                      </p>
                      {!isRead && (
                        <div
                          className="w-2 h-2 rounded-full flex-shrink-0 mt-1"
                          style={{ background: meta.color }}
                        />
                      )}
                    </div>
                    <p className="text-[12px] text-muted-foreground font-body mt-1 leading-relaxed">
                      {notif.message}
                    </p>
                  </div>
                </div>
              </motion.button>
            );
          })}
        </div>
      ))}

      {/* Empty all-read footer */}
      {filtered.length > 0 && unreadCount === 0 && (
        <div className="text-center py-4 space-y-2">
          <Bell className="h-6 w-6 text-primary/40 mx-auto" />
          <p className="text-[11px] text-muted-foreground/50 font-body italic">
            You're all caught up
          </p>
        </div>
      )}

      <p className="text-center text-[11px] text-muted-foreground/50 font-body italic pb-2">
        Stay informed · Never miss a reward
      </p>
    </div>
  );
}
