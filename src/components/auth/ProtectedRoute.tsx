import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';

function AccessDenied() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-transparent">
      <div className="text-center space-y-4 p-8">
        <div className="flex justify-center">
          <div className="h-16 w-16 rounded-full bg-destructive/10 flex items-center justify-center">
            <ShieldAlert className="h-8 w-8 text-destructive" />
          </div>
        </div>
        <h1 className="text-xl font-bold text-foreground">Access Denied</h1>
        <p className="text-sm text-muted-foreground max-w-sm">
          You don't have permission to view this page. Contact your administrator if you believe this is an error.
        </p>
        <Button variant="outline" asChild>
          <a href="/">Return to Dashboard</a>
        </Button>
      </div>
    </div>
  );
}

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { session, roles, loading } = useAuth();
  const { canAccessPage, loading: permLoading } = usePermissions();
  const location = useLocation();
  const hasInternalRole = roles.some(role => ['admin', 'staff', 'finance', 'csr', 'live_agent'].includes(role));

  if (loading || permLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-transparent">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;  {/* /login is not in ROUTES — it's public */}
  }

  // Customer/external sessions are valid auth sessions, but they are not
  // internal Hub sessions. Send them to staff sign-in instead of trapping
  // the preview on Access Denied at the dashboard route.
  if (!hasInternalRole) {
    return <Navigate to="/login" replace />;
  }

  // Check dynamic role-based + feature-toggle page access
  if (!canAccessPage(location.pathname)) {
    // Timesheet-only roles (e.g. live_agent) can't access the dashboard at '/'.
    // Instead of a dead-end Access Denied, send them to their home page (/timesheet),
    // which they CAN access (it's in PUBLIC_AUTHENTICATED_PATHS + own-row RLS).
    // Guard against a redirect loop: only redirect when they're NOT already on /timesheet.
    if (roles.includes('live_agent') && location.pathname !== '/timesheet') {
      return <Navigate to="/timesheet" replace />;
    }
    return <AccessDenied />;
  }

  return <>{children}</>;
}
