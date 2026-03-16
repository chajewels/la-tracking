import { ReactNode } from 'react';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import AppSidebar from './AppSidebar';
import { Bell, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';

export default function AppLayout({ children }: { children: ReactNode }) {
  const { profile, roles, signOut } = useAuth();
  const initials = profile?.full_name
    ? profile.full_name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    : '??';
  const roleLabel = roles.length > 0 ? roles[0].charAt(0).toUpperCase() + roles[0].slice(1) : 'User';

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full dark">
        <AppSidebar />
        <div className="flex-1 flex flex-col min-w-0">
          {/* Top Header */}
          <header className="h-12 flex items-center justify-between border-b border-border px-4 shrink-0 bg-card/80 backdrop-blur-sm sticky top-0 z-30">
            <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground relative">
                <Bell className="h-4 w-4" />
                <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-destructive" />
              </Button>
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-full gold-gradient text-[10px] font-bold text-primary-foreground">
                  CA
                </div>
                <div className="hidden sm:block">
                  <p className="text-xs font-medium text-foreground leading-none">CSR Alice</p>
                  <p className="text-[10px] text-muted-foreground">Staff</p>
                </div>
              </div>
            </div>
          </header>

          {/* Main Content */}
          <main className="flex-1 overflow-auto">
            <div className="p-4 md:p-6 lg:p-8">
              {children}
            </div>
          </main>

          {/* Brand Footer */}
          <footer className="border-t border-border px-4 py-3 bg-card/50">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-1 text-center sm:text-left">
              <p className="text-[10px] text-muted-foreground font-medium">
                © {new Date().getFullYear()} Cha Jewels Co., Ltd.
              </p>
              <p className="text-[10px] text-muted-foreground/60">
                Layaway Payment Management System
              </p>
            </div>
          </footer>
        </div>
      </div>
    </SidebarProvider>
  );
}
