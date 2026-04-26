import { useState } from "react";
import { motion } from "framer-motion";
import { Crown, Coins, Gift, Cake, Tag, ShoppingBag, Star, Shield, Activity, Award, Users } from "lucide-react";
// TODO: wire to Supabase
import { NOTIFICATIONS } from "@/components/loyalty/staticFallback";

const categoryIcons: Record<string, typeof Crown> = {
  tier: Crown,
  points: Coins,
  redemption: Gift,
  birthday: Cake,
  promo: Tag,
  order: ShoppingBag,
  vip: Star,
  security: Shield,
  activity: Activity,
  milestone: Award,
  referral: Users,
};

type FilterType = 'all' | 'unread';

export default function NotificationsScreen() {
  const [filter, setFilter] = useState<FilterType>('all');
  const [notifications, setNotifications] = useState(NOTIFICATIONS);

  const filtered = filter === 'unread' ? notifications.filter((n) => !n.isRead) : notifications;

  const today = filtered.filter((n) => n.date === 'Today');
  const yesterday = filtered.filter((n) => n.date === 'Yesterday');
  const earlier = filtered.filter((n) => n.date !== 'Today' && n.date !== 'Yesterday');

  const markAllRead = () => {
    setNotifications(notifications.map((n) => ({ ...n, isRead: true })));
  };

  const renderGroup = (title: string, items: typeof filtered) => {
    if (items.length === 0) return null;
    return (
      <div className="space-y-2">
        <p className="text-[12px] text-muted-foreground font-body tracking-[0.2em] uppercase">{title}</p>
        {items.map((notif) => {
          const Icon = categoryIcons[notif.category] || Star;
          const isMilestone = notif.category === 'milestone';
          return (
            <motion.div
              key={notif.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className={`rounded-xl p-4 shadow-card border-gold-accent ${!notif.isRead ? 'border-l-2 border-l-primary' : ''} ${
                isMilestone ? 'bg-gradient-to-r from-primary/8 via-card to-card' : 'bg-card'
              }`}
            >
              <div className="flex gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  isMilestone ? 'gradient-gold shadow-gold' : !notif.isRead ? 'bg-primary/10' : 'bg-muted'
                }`}>
                  <Icon size={14} className={isMilestone ? 'text-primary-foreground' : !notif.isRead ? 'text-primary' : 'text-muted-foreground'} />
                </div>
                <div className="flex-1">
                  <p className={`text-[13px] font-body font-medium ${!notif.isRead ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {notif.title}
                  </p>
                  <p className="text-[12px] text-muted-foreground font-body mt-1 leading-relaxed">
                    {notif.message}
                  </p>
                  <p className="text-[11px] text-muted-foreground/60 font-body mt-2">{notif.date}</p>
                </div>
                {!notif.isRead && <div className="w-2 h-2 rounded-full bg-primary mt-1 flex-shrink-0" />}
              </div>
            </motion.div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="px-5 pt-6 pb-4 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[12px] text-muted-foreground font-body tracking-[0.2em] uppercase">Stay Updated</p>
          <h1 className="font-display text-2xl font-semibold text-foreground mt-1">Notifications</h1>
        </div>
        <button
          onClick={markAllRead}
          className="text-[12px] text-primary font-body font-semibold"
        >
          Mark all read
        </button>
      </div>

      <div className="flex gap-2">
        {(['all', 'unread'] as FilterType[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full text-[13px] font-body font-medium capitalize transition-colors ${
              filter === f ? 'gradient-gold text-primary-foreground shadow-sm' : 'bg-card text-muted-foreground shadow-card border-gold-accent'
            }`}
          >
            {f === 'all' ? 'All' : `Unread (${notifications.filter((n) => !n.isRead).length})`}
          </button>
        ))}
      </div>

      <div className="space-y-5">
        {renderGroup("Today", today)}
        {renderGroup("Yesterday", yesterday)}
        {renderGroup("Earlier", earlier)}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-16">
          <span className="text-4xl mb-4 block">✨</span>
          <p className="font-display text-lg text-foreground">All caught up!</p>
          <p className="text-[13px] text-muted-foreground font-body mt-1">No unread notifications from Cha Jewels</p>
        </div>
      )}
    </div>
  );
}
