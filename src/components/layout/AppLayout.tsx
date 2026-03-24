import luxuryHero from '@/assets/luxury-jewelry-hero.jpg';
import { ReactNode } from 'react';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Link } from 'react-router-dom';
import { ROUTES } from '@/constants/routes';
import AppSidebar from './AppSidebar';
import { Bell, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';

export default function AppLayout({ children }: { children: ReactNode }) {
  const { profile, roles, signOut } = useAuth();

  const initials = profile?.full_name
    ? profile.full_name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : '??';

  const roleLabel =
    roles.length > 0
      ? roles[0].charAt(0).toUpperCase() + roles[0].slice(1)
      : 'User';

  return (
    <SidebarProvider>
      <div
        className="min-h-screen flex w-full text-white bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: `url(${luxuryHero})` }}
      >
        <div className="min-h-screen w-full flex bg-black/72">
          <AppSidebar />

          <div className="flex min-h-screen flex-1 flex-col">
            {/* Top Header */}
            <header className="h-14 flex items-center justify-between border-b border-[#D4AF37]/25 px-4 shrink-0 bg-black/55 backdrop-blur-md sticky top-0 z-30">
              <SidebarTrigger className="text-[#D4AF37] hover:text-white" />

              <div className="flex items-center gap-3">
                <Link to={ROUTES.MONITORING}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-[#D4AF37] hover:text-white hover:bg-white/10 relative"
                  >
                    <Bell className="h-4 w-4" />
                    <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-red-500" />
                  </Button>
                </Link>

                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#F7E7A1] via-[#D4AF37] to-[#8C6A00] text-black text-[10px] font-bold shadow-md">
                    {initials}
                  </div>

                  <div className="hidden sm:flex flex-col leading-tight">
                    <span className="text-sm font-semibold text-white">
                      {profile?.full_name || 'User'}
                    </span>
                    <span className="text-[11px] text-[#E7D7A2]">
                      {roleLabel}
                    </span>
                  </div>

                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={signOut}
                    className="h-8 w-8 text-[#D4AF37] hover:text-red-400 hover:bg-white/10"
                  >
                    <LogOut className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </header>

            {/* Main Content */}
            <main className="flex-1 p-4 md:p-6">
              {children}
            </main>
          </div>
        </div>
      </div>
    </SidebarProvider>
  );
}
