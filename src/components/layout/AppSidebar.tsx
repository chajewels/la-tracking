
import { useState, useEffect } from 'react';
import { ROUTES } from "@/constants/routes";
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  LayoutDashboard,
  Wallet,
  Users,
  Bell,
  Settings,
  LogOut,
  Megaphone,
  BarChart3,
  Sparkles,
  ScrollText,
  ChevronDown,
  ChevronRight,
  HelpCircle,
  Wrench,
  ShoppingBag,
  BookOpen,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { useLoyaltyPendingCount } from '@/hooks/useLoyaltyPendingCount';
import { usePendingSubmissionCount } from '@/hooks/use-pending-submissions';
import { useWaiverRequestCount } from '@/hooks/useWaiverRequestCount';
import { useExtensionRequestCount } from '@/hooks/useExtensionRequestCount';
import { useNewLayawayTodayCount } from '@/hooks/useNewLayawayTodayCount';
import { useNewCashOrdersTodayCount } from '@/hooks/useNewCashOrdersTodayCount';
import { cn } from '@/lib/utils';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar';

type SubMenuItem = {
  label: string;
  tab: string;
  // Optional override: when set, the sub-item navigates to this absolute path
  // instead of `${parentPath}?tab=${tab}`. Used for sub-items that are real
  // routes rather than tab states (e.g. Inquiries under CSR Operations).
  path?: string;
  badgeKey?: 'finance_docs' | 'monitoring_extensions' | 'loyalty_redemptions' | 'sales_payments';
  permFilter?: (can: (key: string) => boolean) => boolean;
};

type MenuItem = {
  label: string;
  icon: any;
  path?: string;
  parentPath?: string;
  children?: SubMenuItem[];
  adminOnly?: boolean;
  permPath?: string;
};

type CategoryHeader = {
  type: 'category';
  label: string;
};

const sidebarItems: (CategoryHeader | MenuItem)[] = [
  { label: 'Dashboard', icon: LayoutDashboard, path: ROUTES.DASHBOARD },
  { label: 'Executive Dashboard', icon: BarChart3, path: ROUTES.EXECUTIVE_DASHBOARD, adminOnly: true },

  { type: 'category', label: 'Business' },

  {
    label: 'Sales', icon: ShoppingBag, parentPath: ROUTES.SALES,
    children: [
      { label: 'Cash', tab: 'cash' },
      { label: 'Layaway', tab: 'layaway' },
      { label: 'Payments', tab: 'payments', badgeKey: 'sales_payments' },
      { label: 'Waivers', tab: 'waivers' },
    ],
  },
  {
    label: 'Services', icon: Wrench, parentPath: ROUTES.SERVICES, permPath: ROUTES.SERVICES,
    children: [
      { label: 'Service Jobs', tab: 'service-jobs' },
      { label: 'Trade-Ins', tab: 'trade-ins' },
    ],
  },
  {
    label: 'Customers', icon: Users, parentPath: ROUTES.CUSTOMERS,
    children: [
      { label: 'Directory', tab: 'customers' },
    ],
  },
  {
    label: 'Promotions', icon: Megaphone, parentPath: ROUTES.PROMOTIONS,
    children: [
      { label: 'Promos', tab: 'promos' },
      { label: 'Categories', tab: 'categories' },
      { label: 'Announcements', tab: 'announcements' },
    ],
  },
  {
    label: 'Loyalty', icon: Sparkles, parentPath: ROUTES.LOYALTY_ADMIN, permPath: ROUTES.LOYALTY_ADMIN,
    children: [
      { label: 'Dashboard', tab: 'dashboard' },
      { label: 'Members', tab: 'members' },
      { label: 'Tiers', tab: 'tiers' },
      { label: 'Rewards', tab: 'rewards' },
      { label: 'Redemptions', tab: 'redemptions', badgeKey: 'loyalty_redemptions' },
      { label: 'Transactions', tab: 'transactions' },
      { label: 'Banners', tab: 'banners' },
      { label: 'Beta Whitelist', tab: 'beta' },
      { label: 'Notifications', tab: 'notifications' },
      { label: 'Settings', tab: 'settings' },
      { label: 'Audit Log', tab: 'audit' },
    ],
  },

  { type: 'category', label: 'Accounting' },

  {
    label: 'Finance', icon: Wallet, parentPath: ROUTES.FINANCE,
    children: [
      { label: 'Overview', tab: 'overview' },
      { label: 'Analytics', tab: 'analytics', permFilter: (can) => can('view_analytics') },
      { label: 'Payment Tracking', tab: 'tracking', permFilter: (can) => can('admin_settings') },
      { label: 'Collections', tab: 'collections', permFilter: (can) => can('view_collections') },
      { label: 'Vault', tab: 'vault', permFilter: (can) => can('admin_settings') },
    ],
  },

  { type: 'category', label: 'System & Admin' },

  {
    label: 'CSR Operations', icon: Bell, parentPath: ROUTES.MONITORING,
    children: [
      { label: 'CSR Alerts', tab: 'alerts' },
      { label: 'Smart Reminders', tab: 'reminders' },
      { label: 'Extensions', tab: 'extensions', badgeKey: 'monitoring_extensions' },
      { label: 'Notifications', tab: 'notifications' },
      { label: 'Audit', tab: 'audit' },
      { label: 'Inquiries', tab: 'inquiries', path: ROUTES.INQUIRIES, permFilter: (can) => can('view_inquiries') },
      { label: 'Commissions', tab: 'commissions', path: ROUTES.COMMISSIONS },
    ],
  },
  {
    label: 'Settings', icon: Settings, parentPath: ROUTES.SETTINGS,
    children: [
      { label: 'General', tab: 'general' },
      { label: 'Team', tab: 'team' },
      { label: 'Roles', tab: 'roles' },
      { label: 'Matrix', tab: 'matrix' },
      { label: 'Features', tab: 'features' },
    ],
  },
  { label: 'Policy Hub', icon: BookOpen, path: ROUTES.POLICY_HUB },
  { label: 'Admin Audit', icon: ScrollText, path: ROUTES.ADMIN_ACTIVITY, adminOnly: true },
  { label: 'Help', icon: HelpCircle, path: '/help' },
];

function isCategory(item: CategoryHeader | MenuItem): item is CategoryHeader {
  return (item as CategoryHeader).type === 'category';
}

export default function AppSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { profile, signOut, user } = useAuth();
  const isExecAllowed = user?.email === 'sales@chajewelsjp.com';
  const { canSeeNav, can } = usePermissions();
  const { count: pendingRedemptions } = useLoyaltyPendingCount();
  const { data: pendingSubmissions } = usePendingSubmissionCount();
  const { count: pendingWaivers } = useWaiverRequestCount();
  const { count: pendingExtensions } = useExtensionRequestCount();
  const { count: newLayawayToday } = useNewLayawayTodayCount();
  const { count: newCashToday } = useNewCashOrdersTodayCount();

  const badgeCountByPath: Record<string, number> = {
    [ROUTES.LOYALTY_ADMIN]: pendingRedemptions ?? 0,
    [ROUTES.SALES]: (pendingSubmissions ?? 0) + (pendingWaivers ?? 0),
    [ROUTES.MONITORING]: pendingExtensions ?? 0,
    [ROUTES.DASHBOARD]: (newLayawayToday ?? 0) + (newCashToday ?? 0),
  };

  const badgeBySubKey: Record<string, number> = {
    sales_payments: (pendingSubmissions ?? 0) + (pendingWaivers ?? 0),
    monitoring_extensions: pendingExtensions ?? 0,
    loyalty_redemptions: pendingRedemptions ?? 0,
  };

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const match = sidebarItems.find(
      (m): m is MenuItem => !isCategory(m) && !!m.parentPath && location.pathname === m.parentPath,
    );
    if (match) {
      setExpanded({ [match.label]: true });
    } else {
      setExpanded({});
    }
  }, [location.pathname]);

  const initials = profile?.full_name
    ? profile.full_name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : 'CJ';

  const visibleItems: (CategoryHeader | MenuItem)[] = sidebarItems
    .filter(item => {
      if (isCategory(item)) return true;
      if (item.adminOnly && !isExecAllowed) return false;
      if (item.permPath && !canSeeNav(item.permPath)) return false;
      return true;
    })
    .map(item => {
      if (isCategory(item) || !item.children) return item;
      const visibleChildren = item.children.filter(c => !c.permFilter || c.permFilter(can));
      return { ...item, children: visibleChildren };
    })
    .filter(item => isCategory(item) || !(item as MenuItem).children || ((item as MenuItem).children!.length > 0));

  return (
    <Sidebar
      className="text-white"
      style={{
        background: '#1A1410',
        borderRight: '1px solid rgba(212,175,55,0.12)',
      }}
    >
      <SidebarHeader
        className="px-5 py-5"
        style={{
          background: '#150F0B',
          borderBottom: '1px solid rgba(212,175,55,0.1)',
        }}
      >
        <h1
          className="font-display text-lg tracking-wide"
          style={{ color: '#D4AF37' }}
        >
          Cha Jewels Hub
        </h1>
      </SidebarHeader>

      <SidebarContent className="px-3 py-4" style={{ background: '#1A1410' }}>
        <SidebarMenu>
          {visibleItems.map((item) => {
            // Category header — non-interactive label
            if (isCategory(item)) {
              return (
                <div
                  key={`cat-${item.label}`}
                  className="mt-3 mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-white/30 select-none"
                >
                  {item.label}
                </div>
              );
            }

            const Icon = item.icon;

            // Leaf item (no children) — unchanged from previous behavior
            if (!item.children) {
              const isActive = location.pathname === item.path;
              return (
                <SidebarMenuItem key={item.label} onMouseEnter={() => setExpanded({})}>
                  <SidebarMenuButton
                    onClick={() => navigate(item.path!)}
                    className={cn(
                      'mb-1 h-11 rounded-md pl-3 pr-3 text-sm transition-all duration-200 ease-out cursor-pointer',
                      isActive
                        ? 'border-l-2 border-l-primary bg-primary/10 font-medium text-primary hover:bg-primary/15 hover:text-primary'
                        : 'text-white/55 hover:bg-primary/[0.06] hover:text-white/90'
                    )}
                  >
                    <Icon
                      className={cn(
                        'h-4 w-4 flex-shrink-0',
                        isActive ? 'opacity-100 text-primary' : 'opacity-60'
                      )}
                    />
                    <span className="flex-1 text-left">{item.label}</span>
                    {(badgeCountByPath[item.path!] ?? 0) > 0 && (
                      <span
                        className="ml-auto inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                        style={{
                          background: 'rgba(245, 158, 11, 0.18)',
                          color: '#F59E0B',
                          border: '1px solid rgba(245, 158, 11, 0.35)',
                        }}
                      >
                        {badgeCountByPath[item.path!]}
                      </span>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            }

            // Parent item with children — collapsible
            const isOnParent = location.pathname === item.parentPath;
            const isExpanded = !!expanded[item.label];
            const parentBadge = badgeCountByPath[item.parentPath!] ?? 0;
            const Chevron = isExpanded ? ChevronDown : ChevronRight;

            return (
              <SidebarMenuItem key={item.label} onMouseEnter={() => setExpanded({ [item.label]: true })}>
                <SidebarMenuButton
                  onClick={() => setExpanded(prev => prev[item.label] ? {} : { [item.label]: true })}
                  className={cn(
                    'mb-1 h-11 rounded-md pl-3 pr-3 text-sm transition-all duration-200 ease-out cursor-pointer',
                    isOnParent
                      ? 'border-l border-l-primary/40 bg-primary/[0.04] text-white/80 hover:bg-primary/[0.08]'
                      : 'text-white/55 hover:bg-primary/[0.06] hover:text-white/90'
                  )}
                >
                  <Icon
                    className={cn(
                      'h-4 w-4',
                      isOnParent ? 'opacity-80 text-primary/70' : 'opacity-60'
                    )}
                  />
                  <span className="flex-1 text-left">{item.label}</span>
                  {parentBadge > 0 && (
                    <span
                      className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                      style={{
                        background: 'rgba(245, 158, 11, 0.18)',
                        color: '#F59E0B',
                        border: '1px solid rgba(245, 158, 11, 0.35)',
                      }}
                    >
                      {parentBadge}
                    </span>
                  )}
                  <Chevron className="h-3.5 w-3.5 opacity-60" />
                </SidebarMenuButton>

                {isExpanded && (
                  <SidebarMenuSub className="border-l border-l-primary/15 ml-4 pl-2 mt-0.5 mb-1">
                    {item.children.map((child) => {
                      const isChildActive = child.path
                        ? location.pathname === child.path
                        : (location.pathname === item.parentPath &&
                          (searchParams.get('tab') === child.tab ||
                            (!searchParams.get('tab') && child.tab === item.children![0].tab)));
                      const subBadge = child.badgeKey ? (badgeBySubKey[child.badgeKey] ?? 0) : 0;
                      const target = child.path ?? `${item.parentPath}?tab=${child.tab}`;
                      return (
                        <SidebarMenuSubItem key={child.tab}>
                          <SidebarMenuSubButton
                            asChild
                            className={cn(
                              'h-8 rounded-md pl-3 pr-2 text-xs transition-all duration-200 ease-out',
                              isChildActive
                                ? 'bg-primary/10 font-medium text-primary hover:bg-primary/15 hover:text-primary'
                                : 'text-white/55 hover:bg-primary/[0.06] hover:text-white/90'
                            )}
                          >
                            <Link to={target} className="flex w-full items-center gap-2">
                              <span className="flex-1">{child.label}</span>
                              {subBadge > 0 && (
                                <span
                                  className="ml-auto inline-flex min-w-[1.1rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold"
                                  style={{
                                    background: 'rgba(245, 158, 11, 0.18)',
                                    color: '#F59E0B',
                                    border: '1px solid rgba(245, 158, 11, 0.35)',
                                  }}
                                >
                                  {subBadge}
                                </span>
                              )}
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      );
                    })}
                  </SidebarMenuSub>
                )}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarContent>

      <SidebarFooter
        className="p-4"
        style={{
          background: '#1A1410',
          borderTop: '1px solid rgba(212,175,55,0.1)',
        }}
      >
        <div className="mb-3 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-[#F7E7A1] via-primary to-[#8C6A00] text-xs font-bold text-black">
            {initials}
          </div>

          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium text-white/80">
              {profile?.full_name || 'Cha Jewels'}
            </div>
            <div className="text-xs text-primary">Admin</div>
          </div>
        </div>

        <button
          onClick={signOut}
          className="flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-sm text-white/40 transition-colors duration-200 hover:text-white/80"
        >
          <LogOut className="h-4 w-4" />
          Logout
        </button>

        <p className="mt-1 text-center text-[10px] text-muted-foreground select-none">
          v {__APP_VERSION__}
        </p>
      </SidebarFooter>
    </Sidebar>
  );
}
