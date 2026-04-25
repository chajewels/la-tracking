
import { ROUTES } from "@/constants/routes";
import { lazy, Suspense, ComponentType, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { PermissionsProvider } from "@/contexts/PermissionsContext";
import ProtectedRoute from "@/components/auth/ProtectedRoute";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

function InstallAppBanner() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (sessionStorage.getItem('install-prompt-dismissed') === '1') return;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const onInstalled = () => setVisible(false);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!visible || !deferred) return null;

  const dismiss = () => {
    sessionStorage.setItem('install-prompt-dismissed', '1');
    setVisible(false);
  };

  const install = async () => {
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
    setVisible(false);
  };

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[10000] flex items-center gap-3 rounded-xl border border-[#D4AF37]/40 bg-black/90 px-4 py-2.5 text-sm text-white shadow-xl backdrop-blur">
      <span className="text-[#D4AF37] font-semibold">Install Cha Jewels</span>
      <span className="text-white/70 hidden sm:inline">for a faster, app-like experience</span>
      <button
        onClick={install}
        className="rounded-lg bg-[#D4AF37] px-3 py-1 text-xs font-semibold text-black hover:bg-[#E7D7A2] transition"
      >
        Install App
      </button>
      <button
        onClick={dismiss}
        className="text-xs text-white/60 hover:text-white transition"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

// Retry wrapper for lazy imports — handles stale chunks after dev server restart
function lazyWithRetry(factory: () => Promise<{ default: ComponentType<any> }>) {
  return lazy(() =>
    factory().catch(() => {
      // Chunk failed to load (stale hash) — force one reload
      const key = 'chunk-reload';
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        window.location.reload();
      } else {
        sessionStorage.removeItem(key);
      }
      return factory();
    })
  );
}

// All pages are lazy-loaded to keep initial bundle small
const Login = lazyWithRetry(() => import("./pages/Login"));
const ForgotPassword = lazyWithRetry(() => import("./pages/ForgotPassword"));
const ResetPassword = lazyWithRetry(() => import("./pages/ResetPassword"));
const Dashboard = lazyWithRetry(() => import("./pages/Dashboard"));
const AccountList = lazyWithRetry(() => import("./pages/AccountList"));
const AccountDetail = lazyWithRetry(() => import("./pages/AccountDetail"));
const Customers = lazyWithRetry(() => import("./pages/Customers"));
const CustomerDetail = lazyWithRetry(() => import("./pages/CustomerDetail"));
const Monitoring = lazyWithRetry(() => import("./pages/Monitoring"));
const CustomerPortal = lazyWithRetry(() => import("./pages/CustomerPortal"));
const LoyaltyPortal = lazyWithRetry(() => import("./pages/LoyaltyPortal"));
const Finance = lazyWithRetry(() => import("./pages/Finance"));
const SettingsPage = lazyWithRetry(() => import("./pages/SettingsPage"));
const AdminAudit = lazyWithRetry(() => import("./pages/AdminAudit"));
const CustomerStatement = lazyWithRetry(() => import("./pages/CustomerStatement"));
const NewAccount = lazyWithRetry(() => import("./pages/NewAccount"));
const NotFound = lazyWithRetry(() => import("./pages/NotFound"));
const PaymentVault = lazyWithRetry(() => import("./pages/PaymentVault"));
const PaymentsHub = lazyWithRetry(() => import("./pages/PaymentsHub"));
const BulkPaymentImport = lazyWithRetry(() => import("./pages/BulkPaymentImport"));
const Unsubscribe = lazyWithRetry(() => import("./pages/Unsubscribe"));
const Promotions = lazyWithRetry(() => import("./pages/Promotions"));
const ExecutiveDashboard = lazyWithRetry(() => import("./pages/ExecutiveDashboard"));
const NewCashOrder = lazyWithRetry(() => import("./pages/NewCashOrder"));
const CashOrderDetail = lazyWithRetry(() => import("./pages/CashOrderDetail"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const Protected = ({ children }: { children: React.ReactNode }) => (
  <ProtectedRoute>{children}</ProtectedRoute>
);

function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-transparent">
      <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
    </div>
  );
}

function RecoveryRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.includes('type=recovery') && !window.location.pathname.includes('reset-password')) {
      navigate('/reset-password' + hash, { replace: true });
    }
  }, [navigate]);
  return null;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <InstallAppBanner />
      <BrowserRouter>
        <AuthProvider>
          <PermissionsProvider>
            <Suspense fallback={<PageLoader />}>
              <RecoveryRedirect />
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/forgot-password" element={<ForgotPassword />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route path="/statement" element={<CustomerStatement />} />
                <Route path="/portal" element={<CustomerPortal />} />
                <Route path="/loyalty" element={<LoyaltyPortal />} />
                <Route path="/unsubscribe" element={<Unsubscribe />} />
                
                <Route path="/" element={<Protected><Dashboard /></Protected>} />
                <Route path="/accounts" element={<Protected><AccountList /></Protected>} />
                <Route path="/accounts/new" element={<Protected><NewAccount /></Protected>} />
                <Route path="/accounts/:id" element={<Protected><AccountDetail /></Protected>} />
                <Route path="/customers" element={<Protected><Customers /></Protected>} />
                <Route path="/customers/:customerId" element={<Protected><CustomerDetail /></Protected>} />
                <Route path="/monitoring" element={<Protected><Monitoring /></Protected>} />
                <Route path="/finance" element={<Protected><Finance /></Protected>} />
                <Route path="/admin-audit" element={<Protected><AdminAudit /></Protected>} />
                <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
                <Route path="/payments-hub" element={<Protected><PaymentsHub /></Protected>} />
                <Route path="/bulk-payment-import" element={<Protected><BulkPaymentImport /></Protected>} />
                <Route path="/promotions" element={<Protected><Promotions /></Protected>} />
                <Route path="/executive-dashboard" element={<ExecutiveDashboard />} />
                {/* Cash orders */}
                <Route path="/cash-orders" element={<Navigate to="/customers?tab=cash" replace />} />
                <Route path="/cash-orders/new" element={<Protected><NewCashOrder /></Protected>} />
                <Route path="/cash-orders/:id" element={<Protected><CashOrderDetail /></Protected>} />
                {/* Legacy routes — redirect to the combined hub */}
                <Route path="/payment-submissions" element={<Navigate to="/payments-hub" replace />} />
                <Route path="/payment-proofs" element={<Navigate to="/payments-hub?tab=proofs" replace />} />
                <Route path="/admin/payment-vault" element={<Protected><PaymentVault /></Protected>} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </PermissionsProvider>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
