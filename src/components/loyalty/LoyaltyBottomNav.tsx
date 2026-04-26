import { Home, Gift, Coins, Bell, User } from 'lucide-react';

export type LoyaltyTab = 'home' | 'rewards' | 'points' | 'notifications' | 'profile' | 'tiers';

interface NavTab {
  key: LoyaltyTab;
  label: string;
  icon: typeof Home;
}

const TABS: NavTab[] = [
  { key: 'home', label: 'Home', icon: Home },
  { key: 'rewards', label: 'Rewards', icon: Gift },
  { key: 'points', label: 'Points', icon: Coins },
  { key: 'notifications', label: 'Alerts', icon: Bell },
  { key: 'profile', label: 'Profile', icon: User },
];

interface LoyaltyBottomNavProps {
  active: LoyaltyTab;
  unreadCount?: number;
  onChange: (tab: LoyaltyTab) => void;
}

export default function LoyaltyBottomNav({
  active,
  unreadCount = 0,
  onChange,
}: LoyaltyBottomNavProps) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-card/97 backdrop-blur-xl border-t border-border/60">
      <div className="max-w-lg mx-auto flex items-center justify-around py-2.5 px-1">
        {TABS.map((tab) => {
          // Tiers is reached via QuickActions; BottomNav highlights nothing
          // when active === 'tiers'.
          const isActive = active === tab.key;
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onChange(tab.key)}
              className="relative flex flex-col items-center gap-1 py-1 px-4 rounded-xl transition-all"
            >
              {isActive && (
                <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 w-5 h-0.5 rounded-full gradient-gold" />
              )}
              <Icon
                size={20}
                className={`transition-colors ${isActive ? 'text-primary' : 'text-muted-foreground'}`}
                strokeWidth={isActive ? 2 : 1.4}
              />
              <span
                className={`text-[9px] font-medium tracking-wide transition-colors ${
                  isActive ? 'text-primary' : 'text-muted-foreground'
                }`}
              >
                {tab.label}
              </span>
              {tab.key === 'notifications' && unreadCount > 0 && (
                <span className="absolute top-0 right-2 w-2 h-2 bg-primary rounded-full shadow-gold" />
              )}
            </button>
          );
        })}
      </div>
      <div className="h-[env(safe-area-inset-bottom)]" />
    </nav>
  );
}
