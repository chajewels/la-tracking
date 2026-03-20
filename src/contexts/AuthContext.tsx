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

  const clearAuthState = () => {
    setSession(null);
    setUser(null);
    setRoles([]);
    setProfile(null);
  };

  const fetchUserData = async (userId: string) => {
    const [rolesRes, profileRes] = await Promise.all([
      supabase.from('user_roles').select('role').eq('user_id', userId),
      supabase.from('profiles').select('full_name, email').eq('user_id', userId).maybeSingle(),
    ]);

    return {
      roles: (rolesRes.data ?? []).map((r) => r.role as AppRole),
      profile: profileRes.data ?? null,
    };
  };

  useEffect(() => {
    let isMounted = true;

    const syncSession = async (nextSession: Session | null) => {
      if (!nextSession?.access_token) {
        if (!isMounted) return;
        clearAuthState();
        setLoading(false);
        return;
      }

      const { data, error } = await supabase.auth.getUser(nextSession.access_token);

      if (error || !data.user) {
        await supabase.auth.signOut({ scope: 'local' });
        if (!isMounted) return;
        clearAuthState();
        setLoading(false);
        return;
      }

      const { roles: nextRoles, profile: nextProfile } = await fetchUserData(data.user.id);

      if (!isMounted) return;
      setSession(nextSession);
      setUser(data.user);
      setRoles(nextRoles);
      setProfile(nextProfile);
      setLoading(false);
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!isMounted) return;
      setLoading(true);
      globalThis.setTimeout(() => {
        void syncSession(nextSession);
      }, 0);
    });

    void supabase.auth.getSession().then(({ data: { session } }) => {
      void syncSession(session);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
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
