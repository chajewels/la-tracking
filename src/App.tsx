import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { PermissionsProvider } from "@/contexts/PermissionsContext";
import ProtectedRoute from "@/components/auth/ProtectedRoute";
import Login from "./pages/Login";

// Lazy-loaded pages for better initial load
const Dashboard = lazy(() => import("./pages/Dashboard"));
const AccountList = lazy(() => import("./pages/AccountList"));
const AccountDetail = lazy(() => import("./pages/AccountDetail"));
const NewAccount = lazy(() => import("./pages/NewAccount"));
const Customers = lazy(() => import("./pages/Customers"));
const CustomerDetail = lazy(() => import("./pages/CustomerDetail"));
const Monitoring = lazy(() => import("./pages/Monitoring"));
const Collections = lazy(() => import("./pages/Collections"));
const Finance = lazy(() => import("./pages/Finance"));
const Analytics = lazy(() => import("./pages/Analytics"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const Waivers = lazy(() => import("./pages/Waivers"));
const AdminAudit = lazy(() => import("./pages/AdminAudit"));
const CustomerStatement = lazy(() => import("./pages/CustomerStatement"));
const CustomerPortal = lazy(() => import("./pages/CustomerPortal"));
const PaymentSubmissions = lazy(() => import("./pages/PaymentSubmissions"));
const Reminders = lazy(() => import("./pages/Reminders"));
const NotFound = lazy(() => import("./pages/NotFound"));

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
