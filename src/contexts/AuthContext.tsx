import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

type AppRole = 'admin' | 'staff' | 'finance' | 'csr';

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
        if (isInitial) { setLoading(false); setInitialLoadDone(true); }
        return;
      }

      const { data, error } = await supabase.auth.getUser(nextSession.access_token);

      if (error || !data.user) {
        await supabase.auth.signOut({ scope: 'local' });
        if (!isMounted) return;
        clearAuthState();
        if (isInitial) { setLoading(false); setInitialLoadDone(true); }
        return;
      }

      const { roles: nextRoles, profile: nextProfile } = await fetchUserData(data.user.id);

      if (!isMounted) return;
      setSession(nextSession);
      setUser(data.user);
      setRoles(nextRoles);
      setProfile(nextProfile);
      if (isInitial) { setLoading(false); setInitialLoadDone(true); }
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
      if (event === 'SIGNED_IN' && !initialLoadDone) {
        setLoading(true);
      }

      // For SIGNED_IN and other events, do a full sync
      globalThis.setTimeout(() => {
        void syncSession(nextSession, !initialLoadDone);
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

  return (
    <AuthContext.Provider value={{ session, user, roles, profile, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
