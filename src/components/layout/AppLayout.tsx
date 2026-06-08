import { ReactNode, useState, useEffect } from 'react';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import AppSidebar from './AppSidebar';
import { LogOut, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import StaffNotificationBell from '@/components/notifications/StaffNotificationBell';
import AICommandModal from '@/components/ai/AICommandModal';
import RecordPaymentModal from '@/components/payments/RecordPaymentModal';

export default function AppLayout({ children }: { children: ReactNode }) {
  const { profile, roles, signOut } = useAuth();
  const [aiOpen, setAiOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const [initialInvoice, setInitialInvoice] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      setInitialInvoice(detail.invoice_number ?? null);
      setRecordOpen(true);
    };
    window.addEventListener('open-record-payment-modal', handler);
    return () => window.removeEventListener('open-record-payment-modal', handler);
  }, []);

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
        style={{ backgroundImage: "url('https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/brand-assets/IMG_4761.jpeg')" }}
      >
        <div className="min-h-screen w-full flex bg-gradient-to-b from-black/90 via-black/80 to-black/72">
          <AppSidebar />

          <div className="flex min-h-screen flex-1 flex-col min-w-0">
            {/* Top Header */}
            <header className="h-14 flex items-center justify-between border-b border-primary/25 px-4 shrink-0 bg-black/55 backdrop-blur-md sticky top-0 z-30">
              <SidebarTrigger className="text-primary hover:text-white" />

              <div className="flex items-center gap-3">
                <StaffNotificationBell />

                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#F7E7A1] via-primary to-[#8C6A00] text-black text-[10px] font-bold shadow-md">
                    {initials}
                  </div>

                  <div className="hidden sm:flex flex-col leading-tight">
                    <span className="text-sm font-semibold text-white">
                      {profile?.full_name || 'User'}
                    </span>
                    <span className="text-[11px] text-gold-light">
                      {roleLabel}
                    </span>
                  </div>

                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={signOut}
                    className="h-8 w-8 text-primary hover:text-red-400 hover:bg-white/10"
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

        <button
          type="button"
          onClick={() => setAiOpen(true)}
          className="fixed bottom-6 right-6 z-50 h-12 w-12 rounded-full gold-gradient shadow-lg flex items-center justify-center hover:scale-110 transition-transform focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
          aria-label="AI Command"
          title="AI Command"
        >
          <Sparkles className="h-5 w-5 text-primary-foreground" />
        </button>

        <AICommandModal open={aiOpen} onOpenChange={setAiOpen} />
      </div>
    </SidebarProvider>
  );
}
