import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, FileText, Users, Bell, DollarSign, BarChart3, Activity, Settings, Send, LogOut, Scale, Shield, CreditCard,
} from 'lucide-react';
import { NavLink } from '@/components/NavLink';
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarFooter, SidebarHeader,
  useSidebar,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { canSeeNavItem, type AppRole } from '@/lib/role-permissions';
import chaJewelsLogo from '@/assets/cha-jewels-logo.jpeg';

const allNavItems = [
  { icon: LayoutDashboard, label: 'Dashboard', path: '/' },
  { icon: FileText, label: 'Layaway Accounts', path: '/accounts' },
  { icon: Users, label: 'Customers', path: '/customers' },
  { icon: Bell, label: 'CSR Monitoring', path: '/monitoring' },
  { icon: Send, label: 'Reminders', path: '/reminders' },
  { icon: Activity, label: 'Collections', path: '/collections' },
  { icon: DollarSign, label: 'Finance', path: '/finance' },
  { icon: CreditCard, label: 'Payment Submissions', path: '/payment-submissions' },
  { icon: Scale, label: 'Waivers', path: '/waivers' },
  { icon: BarChart3, label: 'Analytics', path: '/analytics' },
  { icon: Shield, label: 'Admin Audit', path: '/admin-audit' },
  { icon: Settings, label: 'Settings', path: '/settings' },
];

export default function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === 'collapsed';
  const location = useLocation();
  const { profile, roles, signOut } = useAuth();

  const initials = profile?.full_name
    ? profile.full_name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    : '??';
  const roleLabel = roles.length > 0 ? roles.map(r => r.charAt(0).toUpperCase() + r.slice(1)).join(', ') : 'No role';

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader className="border-b border-sidebar-border px-3 py-3">
        <Link to="/" className="flex items-center gap-3 group">
          <img
            src={chaJewelsLogo}
            alt="Cha Jewels"
            className="h-9 w-9 shrink-0 rounded-lg object-cover"
          />
          {!collapsed && (
            <div>
              <h1 className="text-sm font-bold text-sidebar-accent-foreground font-display tracking-wide">
                CHA JEWELS
              </h1>
              <p className="text-[10px] text-sidebar-foreground/50 font-medium tracking-wider">
                LAYAWAY SYSTEM
              </p>
            </div>
          )}
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-sidebar-foreground/40 text-[10px] font-semibold tracking-widest">
            MENU
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.path}>
                  <SidebarMenuButton asChild tooltip={item.label}>
                    <NavLink
                      to={item.path}
                      end={item.path === '/'}
                      className="hover:bg-sidebar-accent"
                      activeClassName="bg-sidebar-accent text-sidebar-primary font-medium"
                    >
                      <item.icon className="h-4 w-4" />
                      <span>{item.label}</span>
                      {item.label === 'CSR Monitoring' && (
                        <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground px-1.5">
                          3
                        </span>
                      )}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full gold-gradient text-xs font-bold text-primary-foreground">
            {initials}
          </div>
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-sidebar-accent-foreground truncate">{profile?.full_name ?? 'User'}</p>
              <p className="text-[10px] text-sidebar-foreground/50">{roleLabel}</p>
            </div>
          )}
          {!collapsed && (
            <Button variant="ghost" size="icon" className="h-7 w-7 text-sidebar-foreground/50 hover:text-destructive" onClick={signOut}>
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
