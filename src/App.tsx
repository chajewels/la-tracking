import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
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

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Dashboard />} />
          <Route path="/accounts" element={<AccountList />} />
          <Route path="/accounts/new" element={<NewAccount />} />
          <Route path="/accounts/:id" element={<AccountDetail />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/monitoring" element={<Monitoring />} />
          <Route path="/collections" element={<Collections />} />
          <Route path="/finance" element={<Finance />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/reminders" element={<Reminders />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
