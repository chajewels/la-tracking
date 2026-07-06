
import { ROUTES } from "@/constants/routes";
import { Component, ErrorInfo, ReactNode, lazy, Suspense, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { PermissionsProvider } from "@/contexts/PermissionsContext";
import ProtectedRoute from "@/components/auth/ProtectedRoute";
import { useRealtimeSync } from "@/hooks/useRealtimeSync";

// Top-level error boundary — catches render-time errors that bypass the
// vite:preloadError listener in main.tsx (e.g. an error thrown while the
// imported chunk evaluates). Without this, a lazy-import rejection
// reaches React 18, which unmounts the entire root and the user sees a
// black screen with no recovery affordance.
class RootErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[RootErrorBoundary] uncaught error during render:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen w-full flex items-center justify-center bg-gradient-to-b from-black/90 via-black/80 to-black/72 text-white px-6">
          <div className="max-w-md w-full rounded-lg border border-primary/30 bg-card/95 p-6 text-center shadow-xl">
            <h1 className="font-display text-xl text-card-foreground mb-2">
              The app was just updated.
            </h1>
            <p className="text-sm text-muted-foreground mb-4">
              Please refresh to load the latest version.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="h-10 px-4 rounded-md gold-gradient text-primary-foreground font-medium"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// All pages are lazy-loaded to keep initial bundle small. Stale-chunk
// recovery is handled by the window 'vite:preloadError' listener in
// main.tsx plus the RootErrorBoundary below.
const Login = lazy(() => import("./pages/Login"));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const PortalLogin = lazy(() => import("./pages/PortalLogin"));
const PortalForgotPassword = lazy(() => import("./pages/PortalForgotPassword"));
const PortalResetPassword = lazy(() => import("./pages/PortalResetPassword"));
const PortalSetup = lazy(() => import("./pages/PortalSetup"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const AccountList = lazy(() => import("./pages/AccountList"));
const AccountDetail = lazy(() => import("./pages/AccountDetail"));
const Customers = lazy(() => import("./pages/Customers"));
const CustomerDetail = lazy(() => import("./pages/CustomerDetail"));
const Monitoring = lazy(() => import("./pages/Monitoring"));
const Inquiries = lazy(() => import("./pages/Inquiries"));
const Commissions = lazy(() => import("./pages/Commissions"));
const Timesheet = lazy(() => import("./pages/Timesheet"));
const CustomerPortal = lazy(() => import("./pages/CustomerPortal"));
const LoyaltyPortal = lazy(() => import("./pages/LoyaltyPortal"));
const Finance = lazy(() => import("./pages/Finance"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const AdminAudit = lazy(() => import("./pages/AdminAudit"));
const AdminActivityLog = lazy(() => import("./pages/AdminActivityLog"));
const NewAccount = lazy(() => import("./pages/NewAccount"));
const NotFound = lazy(() => import("./pages/NotFound"));
const PaymentVault = lazy(() => import("./pages/PaymentVault"));
const PaymentsHub = lazy(() => import("./pages/PaymentsHub"));
const BulkPaymentImport = lazy(() => import("./pages/BulkPaymentImport"));
const Unsubscribe = lazy(() => import("./pages/Unsubscribe"));
const Promotions = lazy(() => import("./pages/Promotions"));
const LoyaltyAdmin = lazy(() => import("./pages/LoyaltyAdmin"));
const ExecutiveDashboard = lazy(() => import("./pages/ExecutiveDashboard"));
const NewCashOrder = lazy(() => import("./pages/NewCashOrder"));
const CashOrderDetail = lazy(() => import("./pages/CashOrderDetail"));
const Help = lazy(() => import("./pages/Help"));
const Services = lazy(() => import("./pages/Services"));
const Sales = lazy(() => import("./pages/Sales"));
const Waivers = lazy(() => import("./pages/Waivers"));
const PolicyHub = lazy(() => import("./pages/PolicyHub"));

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

function RealtimeSyncMount() {
  useRealtimeSync();
  return null;
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    {/* reducedMotion="user": all framer-motion transforms collapse to
        fade-only when the OS prefers reduced motion (Deco Ledger rule). */}
    <MotionConfig reducedMotion="user">
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <PermissionsProvider>
            <RootErrorBoundary>
            <Suspense fallback={<PageLoader />}>
              <RecoveryRedirect />
              <RealtimeSyncMount />
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/forgot-password" element={<ForgotPassword />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route path="/portal" element={<CustomerPortal />} />
                <Route path="/portal/login" element={<PortalLogin />} />
                <Route path="/portal/forgot-password" element={<PortalForgotPassword />} />
                <Route path="/portal/reset-password" element={<PortalResetPassword />} />
                <Route path="/portal/setup" element={<PortalSetup />} />
                <Route path="/loyalty" element={<LoyaltyPortal />} />
                <Route path="/unsubscribe" element={<Unsubscribe />} />
                
                <Route path="/" element={<Protected><Dashboard /></Protected>} />
                <Route path="/accounts" element={<Protected><AccountList /></Protected>} />
                <Route path="/accounts/new" element={<Protected><NewAccount /></Protected>} />
                <Route path="/accounts/:id" element={<Protected><AccountDetail /></Protected>} />
                <Route path="/customers" element={<Protected><Customers /></Protected>} />
                <Route path="/customers/:customerId" element={<Protected><CustomerDetail /></Protected>} />
                <Route path="/services" element={<Protected><Services /></Protected>} />
                <Route path="/sales" element={<Protected><Sales /></Protected>} />
                <Route path="/waivers" element={<Protected><Waivers /></Protected>} />
                <Route path="/monitoring" element={<Protected><Monitoring /></Protected>} />
                <Route path="/inquiries" element={<Protected><Inquiries /></Protected>} />
                <Route path="/commissions" element={<Protected><Commissions /></Protected>} />
                <Route path="/timesheet" element={<Protected><Timesheet /></Protected>} />
                <Route path="/finance" element={<Protected><Finance /></Protected>} />
                <Route path="/admin-audit" element={<Protected><AdminAudit /></Protected>} />
                <Route path="/admin-activity" element={<Protected><AdminActivityLog /></Protected>} />
                <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
                <Route path="/payments-hub" element={<Protected><PaymentsHub /></Protected>} />
                <Route path="/bulk-payment-import" element={<Protected><BulkPaymentImport /></Protected>} />
                <Route path="/promotions" element={<Protected><Promotions /></Protected>} />
                <Route path="/loyalty/admin" element={<Protected><LoyaltyAdmin /></Protected>} />
                <Route path="/loyalty/redemptions" element={<Navigate to="/loyalty/admin?tab=redemptions" replace />} />
                <Route path="/executive-dashboard" element={<ExecutiveDashboard />} />
                {/* Cash orders */}
                <Route path="/cash-orders" element={<Navigate to="/customers?tab=cash" replace />} />
                <Route path="/cash-orders/new" element={<Protected><NewCashOrder /></Protected>} />
                <Route path="/cash-orders/:id" element={<Protected><CashOrderDetail /></Protected>} />
                {/* Legacy routes — redirect to the combined hub */}
                <Route path="/payment-submissions" element={<Navigate to="/payments-hub" replace />} />
                <Route path="/payment-proofs" element={<Navigate to="/payments-hub?tab=proofs" replace />} />
                <Route path="/admin/payment-vault" element={<Protected><PaymentVault /></Protected>} />
                <Route path="/help" element={<Protected><Help /></Protected>} />
                <Route path={ROUTES.POLICY_HUB} element={<Protected><PolicyHub /></Protected>} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
            </RootErrorBoundary>
          </PermissionsProvider>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
    </MotionConfig>
  </QueryClientProvider>
);

export default App;
