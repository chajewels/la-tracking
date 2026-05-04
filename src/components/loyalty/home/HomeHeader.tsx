import { motion } from 'framer-motion';
import { Bell, ChevronRight } from 'lucide-react';
import { useLoyaltyData } from '@/components/loyalty/loyaltyData';
import type { LoyaltyTab } from '@/components/loyalty/LoyaltyBottomNav';

export interface HomeHeaderUnreadPreview {
  title: string;
  body: string;
}

interface HomeHeaderProps {
  setTab: (tab: LoyaltyTab) => void;
  unreadCount: number;
  latestUnread?: HomeHeaderUnreadPreview | null;
}

export default function HomeHeader({
  setTab,
  unreadCount,
  latestUnread,
}: HomeHeaderProps) {
  const { member } = useLoyaltyData();
  const firstName = (member?.customer_name || 'there').split(' ')[0];

  // No preview when there's nothing unread — avoids leaking stale fixture
  // data and keeps the header clean for caught-up members.
  const showPreview = unreadCount > 0 && !!latestUnread;

  return (
    <div className="space-y-3">
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-between"
      >
        <div>
          <p className="text-muted-foreground text-[12px] font-body tracking-[0.2em] uppercase">
            Welcome back
          </p>
          <h1 className="font-display text-2xl font-semibold text-foreground mt-0.5 tracking-tight">
            Hello, {firstName}
          </h1>
        </div>
        <button
          onClick={() => setTab('notifications')}
          className="relative w-10 h-10 rounded-full bg-card shadow-card border-gold-accent flex items-center justify-center"
        >
          <Bell size={18} className="text-foreground" strokeWidth={1.5} />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 bg-primary text-primary-foreground text-[10px] font-bold rounded-full flex items-center justify-center shadow-gold min-w-[18px] min-h-[18px]">
              {unreadCount}
            </span>
          )}
        </button>
      </motion.div>

      {showPreview && (
        <motion.button
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          onClick={() => setTab('notifications')}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-primary/8 border border-primary/12 text-left"
        >
          <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0">
            <Bell size={14} className="text-primary" strokeWidth={2} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-body font-semibold text-foreground truncate">{latestUnread!.title}</p>
            <p className="text-[12px] text-muted-foreground font-body mt-0.5 truncate">{latestUnread!.body}</p>
          </div>
          <ChevronRight size={14} className="text-primary/50 flex-shrink-0" />
        </motion.button>
      )}
    </div>
  );
}
