
import { ROUTES } from "@/constants/routes";
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Wallet,
  Users,
  Bell,
  CalendarClock,
  FileText,
  BarChart3,
  ShieldCheck,
  Settings,
  LogOut,
  Vault,
  Inbox,
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

const menuItems = [
  { label: 'Dashboard', icon: LayoutDashboard, path: ROUTES.DASHBOARD },
  { label: 'Layaway Accounts', icon: Wallet, path: ROUTES.ACCOUNTS },
  { label: 'Customers', icon: Users, path: ROUTES.CUSTOMERS },
  { label: 'CSR Monitoring', icon: Bell, path: ROUTES.MONITORING },
  { label: 'Reminders', icon: CalendarClock, path: ROUTES.REMINDERS },
  { label: 'Collections', icon: Wallet, path: ROUTES.COLLECTIONS },
  { label: 'Finance', icon: Wallet, path: ROUTES.FINANCE },
  { label: 'Submissions & Proofs', icon: Inbox, path: ROUTES.PAYMENTS_HUB },
  { label: 'Waivers', icon: FileText, path: ROUTES.WAIVERS },
  { label: 'Analytics', icon: BarChart3, path: ROUTES.ANALYTICS },
  { label: 'Admin Audit', icon: ShieldCheck, path: ROUTES.ADMIN_AUDIT },
  { label: 'Payment Vault', icon: Vault, path: ROUTES.PAYMENT_VAULT },
  { label: 'Settings', icon: Settings, path: ROUTES.SETTINGS },
];

export default function AppSidebar() {
  const location = useLocation();
  const { profile, signOut } = useAuth();

  const initials = profile?.full_name
    ? profile.full_name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : 'CJ';

  return (
    <Sidebar className="border-r border-[#D4AF37]/20 bg-black/90 text-white backdrop-blur-md">
      <SidebarHeader className="border-b border-[#D4AF37]/20 px-5 py-5">
        <div>
          <h1 className="text-lg font-semibold tracking-wide text-[#D4AF37]">
            CHA JEWELS
          </h1>
          <p className="text-[10px] tracking-[0.24em] text-[#E7D7A2]">
            LAYAWAY SYSTEM
          </p>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-3 py-4">
        <SidebarMenu>
          {menuItems.map((item) => {
            const isActive = location.pathname === item.path;
            const Icon = item.icon;

            return (
              <SidebarMenuItem key={item.label}>
                <SidebarMenuButton
                  asChild
                  className={cn(
                    'mb-1 h-11 rounded-lg px-3 text-sm transition-all',
                    isActive
                      ? 'border border-[#D4AF37]/30 bg-[#D4AF37]/15 text-[#D4AF37] hover:bg-[#D4AF37]/20 hover:text-[#D4AF37]'
                      : 'text-white/75 hover:bg-white/5 hover:text-white'
                  )}
                >
                  <Link to={item.path}>
                    <Icon className="h-4 w-4" />
                    <span>{item.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarContent>

      <SidebarFooter className="border-t border-[#D4AF37]/20 bg-black/60 p-4 backdrop-blur-md">
        <div className="mb-3 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-[#F7E7A1] via-[#D4AF37] to-[#8C6A00] text-xs font-bold text-black">
            {initials}
          </div>

          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium text-white">
              {profile?.full_name || 'Cha Jewels'}
            </div>
            <div className="text-[11px] text-[#E7D7A2]">Admin</div>
          </div>
        </div>

        <button
          onClick={signOut}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-400 transition hover:bg-red-500/10"
        >
          <LogOut className="h-4 w-4" />
          Logout
        </button>
      </SidebarFooter>
    </Sidebar>
  );
}
