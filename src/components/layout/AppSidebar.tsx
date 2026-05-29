
import { ROUTES } from "@/constants/routes";
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Wallet,
  Users,
  Bell,
  Settings,
  LogOut,
  Megaphone,
  Upload,
  BarChart3,
  Sparkles,
  ScrollText,
  Shield,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { useLoyaltyPendingCount } from '@/hooks/useLoyaltyPendingCount';
import { useWaiverRequestCount } from '@/hooks/useWaiverRequestCount';
import { cn } from '@/lib/utils';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

type MenuItem = {
  label: string;
  icon: any;
  path: string;
  adminOnly?: boolean;
  /**
   * Optional path used by canSeeNav() for permission-based filtering.
   * When set, the item is hidden if the current user's roles don't grant
   * view access to that path in role_permissions / SIDEBAR_ACCESS.
   */
  permPath?: string;
};

const menuItems: MenuItem[] = [
  { label: 'Dashboard', icon: LayoutDashboard, path: ROUTES.DASHBOARD },
  { label: 'Customers', icon: Users, path: ROUTES.CUSTOMERS },
  { label: 'CSR Monitoring', icon: Bell, path: ROUTES.MONITORING },
  { label: 'Finance', icon: Wallet, path: ROUTES.FINANCE },
  { label: 'Waivers', icon: Shield, path: ROUTES.WAIVERS },
  { label: 'Executive Dashboard', icon: BarChart3, path: ROUTES.EXECUTIVE_DASHBOARD, adminOnly: true },
  { label: 'Bulk Import', icon: Upload, path: ROUTES.BULK_PAYMENT_IMPORT },
  { label: 'Promotions', icon: Megaphone, path: ROUTES.PROMOTIONS },
  { label: 'Loyalty', icon: Sparkles, path: ROUTES.LOYALTY_ADMIN, permPath: ROUTES.LOYALTY_ADMIN },
  { label: 'Settings', icon: Settings, path: ROUTES.SETTINGS },
  { label: 'Admin Audit', icon: ScrollText, path: ROUTES.ADMIN_ACTIVITY, adminOnly: true },
];

export default function AppSidebar() {
  const location = useLocation();
  const { profile, signOut, user } = useAuth();
  const isExecAllowed = user?.email === 'sales@chajewelsjp.com';
  const { canSeeNav } = usePermissions();
  const { count: pendingRedemptions } = useLoyaltyPendingCount();
  const { count: pendingWaivers } = useWaiverRequestCount();
  const badgeCountByPath: Record<string, number> = {
    [ROUTES.LOYALTY_ADMIN]: pendingRedemptions,
    [ROUTES.WAIVERS]: pendingWaivers,
  };

  const initials = profile?.full_name
    ? profile.full_name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : 'CJ';

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
          {menuItems
            .filter(item => !item.adminOnly || isExecAllowed)
            .filter(item => !item.permPath || canSeeNav(item.permPath))
            .map((item) => {
            const isActive = location.pathname === item.path;
            const Icon = item.icon;

            return (
              <SidebarMenuItem key={item.label}>
                <SidebarMenuButton
                  asChild
                  className={cn(
                    'mb-1 h-11 rounded-md pl-3 pr-3 text-sm transition-all duration-200 ease-out',
                    isActive
                      ? 'border-l-2 border-l-[#D4AF37] bg-[#D4AF37]/10 font-medium text-[#D4AF37] hover:bg-[#D4AF37]/15 hover:text-[#D4AF37]'
                      : 'text-white/55 hover:bg-[#D4AF37]/[0.06] hover:text-white/90'
                  )}
                >
                  <Link to={item.path} className="flex w-full items-center gap-2">
                    <Icon
                      className={cn(
                        'h-4 w-4',
                        isActive ? 'opacity-100 text-[#D4AF37]' : 'opacity-60'
                      )}
                    />
                    <span className="flex-1">{item.label}</span>
                    {(badgeCountByPath[item.path] ?? 0) > 0 && (
                      <span
                        className="ml-auto inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                        style={{
                          background: 'rgba(245, 158, 11, 0.18)',
                          color: '#F59E0B',
                          border: '1px solid rgba(245, 158, 11, 0.35)',
                        }}
                      >
                        {badgeCountByPath[item.path]}
                      </span>
                    )}
                  </Link>
                </SidebarMenuButton>
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
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-[#F7E7A1] via-[#D4AF37] to-[#8C6A00] text-xs font-bold text-black">
            {initials}
          </div>

          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium text-white/80">
              {profile?.full_name || 'Cha Jewels'}
            </div>
            <div className="text-xs text-[#D4AF37]">Admin</div>
          </div>
        </div>

        <button
          onClick={signOut}
          className="flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-sm text-white/40 transition-colors duration-200 hover:text-white/80"
        >
          <LogOut className="h-4 w-4" />
          Logout
        </button>
      </SidebarFooter>
    </Sidebar>
  );
}
