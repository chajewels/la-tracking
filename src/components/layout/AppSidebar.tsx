
import { ROUTES } from "@/constants/routes";
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Wallet,
  Users,
  Bell,
  ShieldCheck,
  Settings,
  LogOut,
  Megaphone,
  Upload,
  BarChart3,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
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

const menuItems: { label: string; icon: any; path: string; adminOnly?: boolean }[] = [
  { label: 'Dashboard', icon: LayoutDashboard, path: ROUTES.DASHBOARD },
  { label: 'Customers', icon: Users, path: ROUTES.CUSTOMERS },
  { label: 'CSR Monitoring', icon: Bell, path: ROUTES.MONITORING },
  { label: 'Finance', icon: Wallet, path: ROUTES.FINANCE },
  { label: 'Executive Dashboard', icon: BarChart3, path: ROUTES.EXECUTIVE_DASHBOARD, adminOnly: true },
  { label: 'Admin Audit', icon: ShieldCheck, path: ROUTES.ADMIN_AUDIT },
  { label: 'Bulk Import', icon: Upload, path: ROUTES.BULK_PAYMENT_IMPORT },
  { label: 'Promotions', icon: Megaphone, path: ROUTES.PROMOTIONS },
  { label: 'Settings', icon: Settings, path: ROUTES.SETTINGS },
];

export default function AppSidebar() {
  const location = useLocation();
  const { profile, signOut, user } = useAuth();
  const isExecAllowed = user?.email === 'sales@chajewelsjp.com';

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
          {menuItems.filter(item => !item.adminOnly || isExecAllowed).map((item) => {
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
                  <Link to={item.path}>
                    <Icon
                      className={cn(
                        'h-4 w-4',
                        isActive ? 'opacity-100 text-[#D4AF37]' : 'opacity-60'
                      )}
                    />
                    <span>{item.label}</span>
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
