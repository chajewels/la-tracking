import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  FileText,
  Users,
  Bell,
  DollarSign,
  BarChart3,
  Activity,
  Settings,
  Gem,
} from 'lucide-react';

const navItems = [
  { icon: LayoutDashboard, label: 'Dashboard', path: '/' },
  { icon: FileText, label: 'Layaway Accounts', path: '/accounts' },
  { icon: Users, label: 'Customers', path: '/customers' },
  { icon: Bell, label: 'Monitoring', path: '/monitoring' },
  { icon: Activity, label: 'Collections', path: '/collections' },
  { icon: DollarSign, label: 'Finance', path: '/finance' },
  { icon: BarChart3, label: 'Analytics', path: '/analytics' },
  { icon: Settings, label: 'Settings', path: '/settings' },
];

export default function AppSidebar() {
  const location = useLocation();

  return (
    <aside className="fixed left-0 top-0 z-40 flex h-screen w-64 flex-col bg-sidebar border-r border-sidebar-border">
      {/* Brand */}
      <div className="flex h-16 items-center gap-3 px-6 border-b border-sidebar-border">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg gold-gradient">
          <Gem className="h-5 w-5 text-primary-foreground" />
        </div>
        <div>
          <h1 className="text-sm font-bold text-sidebar-accent-foreground font-display tracking-wide">CHA JEWELS</h1>
          <p className="text-[10px] text-sidebar-foreground/60 uppercase tracking-widest">Layaway System</p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path || 
            (item.path !== '/' && location.pathname.startsWith(item.path));
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-sidebar-accent text-sidebar-primary'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
              }`}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
              {item.label === 'Monitoring' && (
                <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground px-1.5">
                  3
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-sidebar-border p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-sidebar-accent text-xs font-bold text-sidebar-primary">
            CA
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-sidebar-accent-foreground truncate">CSR Alice</p>
            <p className="text-[10px] text-sidebar-foreground/60">Staff</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
