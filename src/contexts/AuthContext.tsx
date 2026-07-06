import { createContext, useContext, useEffect, useState, useRef, useCallback, ReactNode } from 'react';
import { palette } from '@/theme/tokens';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

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

const AuthContext = createContext<AuthContextType>({
  session: null,
  user: null,
  roles: [],
  profile: null,
  loading: true,
  signOut: async () => {},
});

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: ReactNode }) {
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

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!isMounted) return;

      // On SIGNED_OUT, clear immediately without showing spinner
      if (event === 'SIGNED_OUT') {
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
