import { lazy, Suspense, ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { PermissionsProvider } from "@/contexts/PermissionsContext";
import ProtectedRoute from "@/components/auth/ProtectedRoute";
import Login from "./pages/Login";

// Core pages — loaded eagerly for instant navigation
import Dashboard from "./pages/Dashboard";
import AccountList from "./pages/AccountList";
import AccountDetail from "./pages/AccountDetail";
import Customers from "./pages/Customers";
import CustomerDetail from "./pages/CustomerDetail";
import Monitoring from "./pages/Monitoring";
import CustomerPortal from "./pages/CustomerPortal";

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

// Secondary pages — lazy loaded (visited less frequently)
const Collections = lazyWithRetry(() => import("./pages/Collections"));
const Finance = lazyWithRetry(() => import("./pages/Finance"));
const Analytics = lazyWithRetry(() => import("./pages/Analytics"));
const SettingsPage = lazyWithRetry(() => import("./pages/SettingsPage"));
const Waivers = lazyWithRetry(() => import("./pages/Waivers"));
const AdminAudit = lazyWithRetry(() => import("./pages/AdminAudit"));
const CustomerStatement = lazyWithRetry(() => import("./pages/CustomerStatement"));
const PaymentSubmissions = lazyWithRetry(() => import("./pages/PaymentSubmissions"));
const Reminders = lazyWithRetry(() => import("./pages/Reminders"));
const NewAccount = lazyWithRetry(() => import("./pages/NewAccount"));
const NotFound = lazyWithRetry(() => import("./pages/NotFound"));

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
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
    </div>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <PermissionsProvider>
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/statement" element={<CustomerStatement />} />
                <Route path="/portal" element={<CustomerPortal />} />
                
                <Route path="/" element={<Protected><Dashboard /></Protected>} />
                <Route path="/accounts" element={<Protected><AccountList /></Protected>} />
                <Route path="/accounts/new" element={<Protected><NewAccount /></Protected>} />
                <Route path="/accounts/:id" element={<Protected><AccountDetail /></Protected>} />
                <Route path="/customers" element={<Protected><Customers /></Protected>} />
                <Route path="/customers/:customerId" element={<Protected><CustomerDetail /></Protected>} />
                <Route path="/monitoring" element={<Protected><Monitoring /></Protected>} />
                <Route path="/collections" element={<Protected><Collections /></Protected>} />
                <Route path="/finance" element={<Protected><Finance /></Protected>} />
                <Route path="/analytics" element={<Protected><Analytics /></Protected>} />
                <Route path="/reminders" element={<Protected><Reminders /></Protected>} />
                <Route path="/waivers" element={<Protected><Waivers /></Protected>} />
                <Route path="/admin-audit" element={<Protected><AdminAudit /></Protected>} />
                <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
                <Route path="/payment-submissions" element={<Protected><PaymentSubmissions /></Protected>} />
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
