import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getPortalSession } from '@/lib/portal-session';
import { useAuth } from '@/contexts/AuthContext';

// /launch — recovery/entry point for installed PWAs.
//
// Reachable from PWA install (after Step 3b-3 manifest start_url
// change). Three cases:
//
//   (a) Customer with a valid session in localStorage → /portal
//   (b) Authenticated admin / staff / finance / csr user → /
//   (c) Neither → fallback message
//
// Currently unreachable from normal navigation. Step 3b-3 will
// flip vite.config.ts manifest start_url to /launch which makes
// installed PWAs land here.
export default function Launch() {
  const navigate = useNavigate();
  const { user, roles, loading } = useAuth();

  useEffect(() => {
    // Case (a) — valid customer session takes priority over admin auth
    const session = getPortalSession();
    if (session) {
      navigate('/portal', { replace: true });
      return;
    }

    // Wait for AuthContext to finish hydrating before deciding case (b) vs (c)
    if (loading) return;

    // Case (b) — authenticated admin / staff / finance / csr
    if (user && roles && roles.length > 0) {
      navigate('/', { replace: true });
      return;
    }

    // Case (c) — fall through to render fallback (no auto-redirect)
  }, [user, roles, loading, navigate]);

  // Suppress flash while the redirect effect runs
  const session = getPortalSession();
  if (session || loading || (user && roles && roles.length > 0)) {
    return null;
  }

  // Case (c) UI
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-md text-center space-y-4">
        <h1 className="text-2xl font-semibold">Welcome to Cha Jewels</h1>
        <p className="text-muted-foreground">
          To access your portal, please open this app from your portal link
          sent to you via Messenger.
        </p>
        <p className="text-sm text-muted-foreground">
          If you're an admin, please log in from the main login page.
        </p>
      </div>
    </div>
  );
}
