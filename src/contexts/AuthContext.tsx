import { createContext, useContext, useEffect, useState, useRef, useCallback, ReactNode } from 'react';
import { palette } from '@/theme/tokens';
import { Session, User } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { clearAccountDraft } from '@/hooks/use-account-draft';
import { clearAllPaymentDrafts } from '@/hooks/use-payment-draft';

type AppRole = 'admin' | 'staff' | 'finance' | 'csr' | 'customer' | 'live_agent';

// Idle-timeout constants (applies to both the internal app and the customer portal)
const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;   // 2 hours
const WARNING_BEFORE_MS = 5 * 60 * 1000;      // 5 minutes
const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'] as const;

interface AuthContextType {
  session: Session | null;
  user: User | null;
  roles: AppRole[];
  profile: { full_name: string; email: string | null } | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

// Exported only so the DEV fixture harness (src/dev/HubRouteShim.tsx) can
// render pages as a signed-in staff user; app code reads it through useAuth().
// eslint-disable-next-line react-refresh/only-export-components
export const AuthContext = createContext<AuthContextType>({
  session: null,
  user: null,
  roles: [],
  profile: null,
  loading: true,
  signOut: async () => {},
});

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: ReactNode }) {
  // App.tsx creates the QueryClient at MODULE scope, so it outlives every
  // sign-out and nothing in src/ ever emptied it. Taking it from context here
  // (AuthProvider sits inside QueryClientProvider in App.tsx) gives the
  // SIGNED_OUT handler the same instance the app reads from, without
  // importing the module-scope singleton. useQueryClient is referentially
  // stable, so the mount-once effect below can close over it safely.
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [profile, setProfile] = useState<{ full_name: string; email: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const initialLoadDoneRef = useRef(false);

  const clearAuthState = () => {
    setSession(null);
    setUser(null);
    setRoles([]);
    setProfile(null);
  };

  const fetchUserData = async (userId: string, retryCount = 0): Promise<{ roles: AppRole[]; profile: { full_name: string; email: string | null } | null }> => {
    try {
      const [rolesRes, profileRes] = await Promise.all([
        supabase.from('user_roles').select('role').eq('user_id', userId),
        supabase.from('profiles').select('full_name, email').eq('user_id', userId).maybeSingle(),
      ]);

      if ((rolesRes.error || profileRes.error) && retryCount < 2) {
        console.warn('Auth data fetch retry:', rolesRes.error?.message, profileRes.error?.message);
        await new Promise(r => setTimeout(r, 1500 * (retryCount + 1)));
        return fetchUserData(userId, retryCount + 1);
      }

      return {
        roles: (rolesRes.data ?? []).map((r) => r.role as AppRole),
        profile: profileRes.data ?? null,
      };
    } catch (err) {
      if (retryCount < 2) {
        console.warn('Auth data fetch retry after error:', err);
        await new Promise(r => setTimeout(r, 1500 * (retryCount + 1)));
        return fetchUserData(userId, retryCount + 1);
      }
      return { roles: [], profile: null };
    }
  };

  useEffect(() => {
    let isMounted = true;

    const syncSession = async (nextSession: Session | null, isInitial: boolean) => {
      if (!nextSession?.access_token) {
        if (!isMounted) return;
        clearAuthState();
        if (isInitial) { setLoading(false); setInitialLoadDone(true); initialLoadDoneRef.current = true; }
        return;
      }

      const { data, error } = await supabase.auth.getUser(nextSession.access_token);

      if (error || !data.user) {
        await supabase.auth.signOut({ scope: 'local' });
        if (!isMounted) return;
        clearAuthState();
        if (isInitial) { setLoading(false); setInitialLoadDone(true); initialLoadDoneRef.current = true; }
        return;
      }

      const { roles: nextRoles, profile: nextProfile } = await fetchUserData(data.user.id);

      if (!isMounted) return;
      setSession(nextSession);
      setUser(data.user);
      setRoles(nextRoles);
      setProfile(nextProfile);
      if (isInitial) { setLoading(false); setInitialLoadDone(true); initialLoadDoneRef.current = true; }
    };

    // ── F02 / #295: drop everything the previous user could still be read from ──
    //
    // Wired to the SIGNED_OUT EVENT, not to signOut(), on purpose. signOut() is
    // only the button in this tab; the event also fires when the session ends
    // some other way — and cross-tab, which matters on a shared machine.
    //
    // CROSS-TAB IS REAL, AND HERE IS THE EVIDENCE (checked against the pinned
    // @supabase/auth-js 2.116.0, not assumed):
    //   - GoTrueClient's constructor opens `new BroadcastChannel(this.storageKey)`
    //     when `isBrowser() && globalThis.BroadcastChannel && this.persistSession
    //     && this.storageKey` (GoTrueClient.js:267-269), and subscribes to its
    //     'message' event (:274).
    //   - Our client sets `persistSession: true`
    //     (src/integrations/supabase/client.ts), so the channel is opened.
    //   - `_signOut()` ends with `await this._notifyAllSubscribers('SIGNED_OUT', null)`
    //     (:4430), and `_notifyAllSubscribers(event, session, broadcast = true)`
    //     (:4332) posts to that channel; the receiving tab re-notifies its own
    //     subscribers with `broadcast = false` (:4341 comment).
    //   So a sign-out in tab A delivers SIGNED_OUT to this handler in tab B.
    //
    // THE ONE GAP, stated rather than papered over: auth-js wraps the channel
    // construction in try/catch and logs "Failed to create a new
    // BroadcastChannel, multi-tab state changes will not be available" (:272).
    // Where BroadcastChannel is missing or blocked, no cross-tab event arrives
    // and the other tab keeps its cache until it is reloaded or its own session
    // read fails. auth-js registers NO 'storage' event listener, so there is no
    // second mechanism to fall back on. Closing that would need our own
    // BroadcastChannel (or a `storage` listener on the auth key) posting a
    // logout ping that each tab acts on — deliberately not built here, because
    // it is a separate behaviour with its own failure modes.
    const clearSensitiveState = async () => {
      // Cancel first, then clear. A query already in flight resolves AFTER the
      // clear otherwise, and React Query writes the result back into the cache
      // — repopulating it with the signed-out user's rows a beat after we
      // emptied it. cancelQueries settles the in-flight ones before we wipe.
      try {
        await queryClient.cancelQueries();
      } catch {
        // Never let teardown block the sign-out itself.
      }
      queryClient.clear();

      // Drafts live in sessionStorage and are NOT auth state, so nothing else
      // removes them. Each hook owns its own key shape and exports its own
      // clear — AuthContext does not reach into sessionStorage itself.
      clearAccountDraft();
      clearAllPaymentDrafts();

      // Deliberately NOT touched: density toggle, notification sound, FX rate,
      // announcement dismissal, loyalty tier and every other unrelated
      // localStorage key. They are device preferences, hold nothing about who
      // was signed in, and wiping them would make sign-out feel like a reset.
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!isMounted) return;

      // On SIGNED_OUT, clear immediately without showing spinner
      if (event === 'SIGNED_OUT') {
        void clearSensitiveState();
        clearAuthState();
        return;
      }

      // TOKEN_REFRESHED: just update the session reference silently — don't re-fetch user/roles
      if (event === 'TOKEN_REFRESHED') {
        if (nextSession) {
          setSession(nextSession);
        }
        return;
      }

      // On SIGNED_IN, show loading only if we haven't loaded yet
      if (event === 'SIGNED_IN' && !initialLoadDoneRef.current) {
        setLoading(true);
      }

      // For SIGNED_IN and other events, do a full sync
      globalThis.setTimeout(() => {
        void syncSession(nextSession, !initialLoadDoneRef.current);
      }, 0);
    });

    void supabase.auth.getSession().then(({ data: { session } }) => {
      void syncSession(session, true);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  // ── Idle-timeout (2h inactivity → auto sign-out, 5min warning modal) ──
  const [showIdleWarning, setShowIdleWarning] = useState(false);
  const logoutTimerRef = useRef<number | null>(null);
  const warningTimerRef = useRef<number | null>(null);

  const handleIdleLogout = useCallback(async () => {
    setShowIdleWarning(false);
    await supabase.auth.signOut();
  }, []);

  const resetIdleTimer = useCallback(() => {
    if (warningTimerRef.current !== null) {
      clearTimeout(warningTimerRef.current);
      warningTimerRef.current = null;
    }
    if (logoutTimerRef.current !== null) {
      clearTimeout(logoutTimerRef.current);
      logoutTimerRef.current = null;
    }
    setShowIdleWarning(false);
    warningTimerRef.current = globalThis.setTimeout(() => {
      setShowIdleWarning(true);
    }, IDLE_TIMEOUT_MS - WARNING_BEFORE_MS) as unknown as number;
    logoutTimerRef.current = globalThis.setTimeout(() => {
      void handleIdleLogout();
    }, IDLE_TIMEOUT_MS) as unknown as number;
  }, [handleIdleLogout]);

  useEffect(() => {
    // Only arm timers while a session exists
    if (!session) return;

    resetIdleTimer();

    const handleActivity = () => resetIdleTimer();
    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, handleActivity, { passive: true });
    }

    return () => {
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, handleActivity);
      }
      if (warningTimerRef.current !== null) {
        clearTimeout(warningTimerRef.current);
        warningTimerRef.current = null;
      }
      if (logoutTimerRef.current !== null) {
        clearTimeout(logoutTimerRef.current);
        logoutTimerRef.current = null;
      }
      setShowIdleWarning(false);
    };
  }, [session, resetIdleTimer]);

  return (
    <AuthContext.Provider value={{ session, user, roles, profile, loading, signOut }}>
      {children}
      {showIdleWarning && session && (
        <div
          onClick={resetIdleTimer}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 100000,
            background: 'rgba(0,0,0,0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            cursor: 'pointer',
          }}
        >
          <div
            style={{
              background: '#111',
              border: `1px solid ${palette.gold500}`,
              borderRadius: 12,
              padding: '32px 28px',
              maxWidth: 420,
              textAlign: 'center',
              boxShadow: '0 0 32px rgba(212,175,55,0.18)',
            }}
          >
            <p style={{ color: palette.gold500, fontFamily: 'Georgia, serif', fontSize: 18, letterSpacing: '0.1em', marginBottom: 16 }}>
              Session Timeout Warning
            </p>
            <p style={{ color: '#fff', fontSize: 14, lineHeight: 1.6, marginBottom: 12 }}>
              You will be logged out in 5 minutes due to inactivity.
            </p>
            <p style={{ color: '#bbb', fontSize: 12 }}>
              Click anywhere to stay logged in.
            </p>
          </div>
        </div>
      )}
    </AuthContext.Provider>
  );
}
