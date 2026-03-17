import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import ProtectedRoute from "@/components/auth/ProtectedRoute";
import Dashboard from "./pages/Dashboard";
import AccountList from "./pages/AccountList";
import AccountDetail from "./pages/AccountDetail";
import NewAccount from "./pages/NewAccount";
import Customers from "./pages/Customers";
import Monitoring from "./pages/Monitoring";
import Collections from "./pages/Collections";
import Finance from "./pages/Finance";
import Analytics from "./pages/Analytics";
import SettingsPage from "./pages/SettingsPage";
import Login from "./pages/Login";

import Reminders from "./pages/Reminders";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const Protected = ({ children }: { children: React.ReactNode }) => (
  <ProtectedRoute>{children}</ProtectedRoute>
);

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            
            <Route path="/" element={<Protected><Dashboard /></Protected>} />
            <Route path="/accounts" element={<Protected><AccountList /></Protected>} />
            <Route path="/accounts/new" element={<Protected><NewAccount /></Protected>} />
            <Route path="/accounts/:id" element={<Protected><AccountDetail /></Protected>} />
            <Route path="/customers" element={<Protected><Customers /></Protected>} />
            <Route path="/monitoring" element={<Protected><Monitoring /></Protected>} />
            <Route path="/collections" element={<Protected><Collections /></Protected>} />
            <Route path="/finance" element={<Protected><Finance /></Protected>} />
            <Route path="/analytics" element={<Protected><Analytics /></Protected>} />
            <Route path="/reminders" element={<Protected><Reminders /></Protected>} />
            <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
