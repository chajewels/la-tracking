import { ReactNode, useState, useEffect } from 'react';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import AppSidebar from './AppSidebar';
import { LogOut, Sparkles, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useVersionCheck } from '@/hooks/useVersionCheck';
import { applyUpdate } from '@/lib/pwaUpdate';
import { useAuth } from '@/contexts/AuthContext';
import StaffNotificationBell from '@/components/notifications/StaffNotificationBell';
import AICommandModal from '@/components/ai/AICommandModal';
import RecordPaymentModal from '@/components/payments/RecordPaymentModal';
import CommandPalette from '@/components/layout/CommandPalette';
import PageTransition from '@/components/motion/PageTransition';

export default function AppLayout({ children }: { children: ReactNode }) {
  const { profile, roles, signOut } = useAuth();
  const [aiOpen, setAiOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const [initialInvoice, setInitialInvoice] = useState<string | null>(null);
  const [initialPaymentMethod, setInitialPaymentMethod] = useState<string | null>(null);
  const [initialPaymentMode, setInitialPaymentMode] = useState<'single' | 'split' | null>(null);
  const [initialAmount, setInitialAmount] = useState<number | null>(null);
  const updateAvailable = useVersionCheck();
  const [updateDismissed, setUpdateDismissed] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail ?? {};
      setInitialInvoice(detail.invoice_number ?? null);
      // Map AI payment_channel to payment method registry key
      const channelMap: Record<string, string> = {
        gcash: 'gcash', bdo: 'bdo', bpi: 'bpi',
        paypal: 'paypal', cash: 'cash', maya: 'maya',
        paymaya: 'maya',
      };
      const rawChannel = (detail.payment_channel ?? '').toLowerCase();
      setInitialPaymentMethod(channelMap[rawChannel] ?? null);
      setInitialPaymentMode(detail.payment_mode ?? null);
      setInitialAmount(detail.amount ? Number(detail.amount) : null);
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
      ? roles[0].split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
      : 'User';

  return (
    <SidebarProvider>
      <div
        className="min-h-screen flex w-full text-white bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/brand-assets/IMG_4761.jpeg')" }}
      >
        <div className="min-h-screen w-full flex bg-gradient-to-b from-black/90 via-black/80 to-black/72">
          <AppSidebar updateAvailable={updateAvailable} />

          <div className="flex min-h-screen flex-1 flex-col min-w-0">
            {/* Top Header */}
            {/* hairline-b: the Deco Ledger gold "ledger line" divider */}
            <header className="h-14 flex items-center justify-between hairline-b px-4 shrink-0 bg-black/55 backdrop-blur-md sticky top-0 z-30">
              <SidebarTrigger className="text-primary hover:text-white" />

              <div className="flex items-center gap-3">
                <StaffNotificationBell />

                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full gold-gradient text-black text-[10px] font-bold shadow-md">
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
                    aria-label="Sign out"
                  >
                    <LogOut className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </header>

            {/* Main Content */}
            <main className="flex-1 flex flex-col p-4 md:p-6">
              <PageTransition>
              {updateAvailable && !updateDismissed && (
                <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/10 px-4 py-2.5 backdrop-blur-sm">
                  <div className="flex items-center gap-2 text-sm text-white">
                    <RefreshCw className="h-4 w-4 text-primary shrink-0" />
                    <span>A new version of the app is available. Reload to load the latest update.</span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button size="sm" onClick={() => applyUpdate()} className="h-8 gold-gradient text-primary-foreground">
                      Reload
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setUpdateDismissed(true)} className="h-8 w-8 text-primary hover:text-white hover:bg-white/10" aria-label="Dismiss">
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
              {children}
              </PageTransition>
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

        {/* ⌘K palette — internal chrome only, never the customer portal */}
        <CommandPalette />
        <AICommandModal open={aiOpen} onOpenChange={setAiOpen} />
        <RecordPaymentModal
          open={recordOpen}
          onOpenChange={(next) => {
            setRecordOpen(next);
            if (!next) {
              setInitialInvoice(null);
              setInitialPaymentMethod(null);
              setInitialPaymentMode(null);
              setInitialAmount(null);
            }
          }}
          initialInvoice={initialInvoice}
          initialPaymentMethod={initialPaymentMethod}
          initialPaymentMode={initialPaymentMode}
          initialAmount={initialAmount}
        />
      </div>
    </SidebarProvider>
  );
}
