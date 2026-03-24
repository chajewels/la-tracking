import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

type PermissionKey = string;

interface FeatureToggle {
  feature_key: string;
  is_enabled: boolean;
  label: string;
  description: string | null;
  module: string;
  sort_order: number;
}

interface RolePermission {
  role: string;
  permission_key: string;
  is_allowed: boolean;
}

interface PermissionsContextType {
  /** Check if current user can perform an action */
  can: (permissionKey: PermissionKey) => boolean;
  /** Check if a feature is globally enabled */
  isFeatureEnabled: (featureKey: string) => boolean;
  /** Check if current user can access a page path */
  canAccessPage: (path: string) => boolean;
  /** Check if current user can see a nav item */
  canSeeNav: (path: string) => boolean;
  /** All role permissions (for admin matrix) */
  allPermissions: RolePermission[];
  /** All feature toggles (for admin panel) */
  featureToggles: FeatureToggle[];
  /** Update a permission (admin only) */
  updatePermission: (role: string, permissionKey: string, isAllowed: boolean) => Promise<void>;
  /** Update a feature toggle (admin only) */
  updateFeatureToggle: (featureKey: string, isEnabled: boolean) => Promise<void>;
  /** Refresh permissions from DB */
  refresh: () => Promise<void>;
  loading: boolean;
}

const PermissionsContext = createContext<PermissionsContextType>({
  can: () => false,
  isFeatureEnabled: () => true,
  canAccessPage: () => false,
  canSeeNav: () => false,
  allPermissions: [],
  featureToggles: [],
  updatePermission: async () => {},
  updateFeatureToggle: async () => {},
  refresh: async () => {},
  loading: true,
});

export const usePermissions = () => useContext(PermissionsContext);

// Map page paths to required permission keys
const PAGE_PERMISSION_MAP: Record<string, PermissionKey> = {
  '/': 'view_dashboard',
  '/accounts': 'view_accounts',
  '/accounts/new': 'create_account',
  '/customers': 'view_customers',
  '/monitoring': 'view_monitoring',
  '/reminders': 'view_reminders',
  '/collections': 'view_collections',
  '/finance': 'view_finance',
  '/payment-submissions': 'view_submissions',
  '/waivers': 'view_waivers',
  '/analytics': 'view_analytics',
  '/admin-audit': 'view_audit_logs',
  '/settings': 'admin_settings',
};

// Map page paths to feature toggle keys
const PAGE_FEATURE_MAP: Record<string, string> = {
  '/monitoring': 'csr_monitoring',
  '/reminders': 'reminder_system',
  '/collections': 'collections_module',
  '/payment-submissions': 'payment_submissions',
  '/waivers': 'waiver_system',
  '/analytics': 'analytics_module',
};

// Sidebar nav paths (same as PAGE_PERMISSION_MAP minus dynamic routes)
const NAV_PATHS = ['/', '/accounts', '/customers', '/monitoring', '/reminders', '/collections', '/finance', '/payment-submissions', '/waivers', '/analytics', '/admin-audit', '/settings'];

export function PermissionsProvider({ children }: { children: ReactNode }) {
  const { user, roles, loading: authLoading } = useAuth();
  const [allPermissions, setAllPermissions] = useState<RolePermission[]>([]);
  const [featureToggles, setFeatureToggles] = useState<FeatureToggle[]>([]);
  const [loading, setLoading] = useState(true);

  const userId = user?.id;

  const fetchData = useCallback(async (retryCount = 0) => {
    if (!userId) {
      setAllPermissions([]);
      setFeatureToggles([]);
      setLoading(false);
      return;
    }

    try {
      const [permRes, toggleRes] = await Promise.all([
        supabase.from('role_permissions').select('role, permission_key, is_allowed'),
        supabase.from('feature_toggles').select('feature_key, is_enabled, label, description, module, sort_order').order('sort_order'),
      ]);

      if (permRes.error || toggleRes.error) {
        console.warn('Permissions fetch error:', permRes.error?.message, toggleRes.error?.message);
        if (retryCount < 2) {
          await new Promise(r => setTimeout(r, 1500 * (retryCount + 1)));
          return fetchData(retryCount + 1);
        }
      }

      setAllPermissions((permRes.data as RolePermission[] | null) ?? []);
      setFeatureToggles((toggleRes.data as FeatureToggle[] | null) ?? []);
    } catch (err) {
      console.error('Permissions fetch failed:', err);
      if (retryCount < 2) {
        await new Promise(r => setTimeout(r, 1500 * (retryCount + 1)));
        return fetchData(retryCount + 1);
      }
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!authLoading) {
      fetchData();
    }
  }, [authLoading, fetchData]);

  const can = useCallback((permissionKey: PermissionKey): boolean => {
    if (roles.length === 0) return false;
    // Check if any of the user's roles has this permission
    return roles.some(role => {
      const perm = allPermissions.find(p => p.role === role && p.permission_key === permissionKey);
      return perm?.is_allowed ?? false;
    });
  }, [roles, allPermissions]);

  const isFeatureEnabled = useCallback((featureKey: string): boolean => {
    const toggle = featureToggles.find(t => t.feature_key === featureKey);
    return toggle?.is_enabled ?? true; // default enabled if not found
  }, [featureToggles]);

  const canAccessPage = useCallback((path: string): boolean => {
    // Check feature toggle first
    const featureKey = PAGE_FEATURE_MAP[path];
    if (featureKey && !isFeatureEnabled(featureKey)) return false;

    // Check permission
    let permKey = PAGE_PERMISSION_MAP[path];
    if (!permKey) {
      // Dynamic routes: /accounts/:id -> view_accounts, /customers/:id -> view_customers
      if (path.startsWith('/accounts/')) permKey = 'view_accounts';
      else if (path.startsWith('/customers/')) permKey = 'view_customers';
      else return false;
    }
    return can(permKey);
  }, [can, isFeatureEnabled]);

  const canSeeNav = useCallback((path: string): boolean => {
    return canAccessPage(path);
  }, [canAccessPage]);

  const updatePermission = useCallback(async (role: string, permissionKey: string, isAllowed: boolean) => {
    const { error } = await supabase
      .from('role_permissions')
      .update({ is_allowed: isAllowed, updated_by_user_id: user?.id })
      .eq('role', role as any)
      .eq('permission_key', permissionKey);

    if (error) throw error;

    // Log to audit
    await supabase.from('audit_logs').insert({
      action: 'ROLE_PERMISSION_UPDATED',
      entity_type: 'role_permission',
      entity_id: role,
      performed_by_user_id: user?.id,
      new_value_json: { role, permission_key: permissionKey, is_allowed: isAllowed },
    });

    // Update local state
    setAllPermissions(prev =>
      prev.map(p => p.role === role && p.permission_key === permissionKey ? { ...p, is_allowed: isAllowed } : p)
    );
  }, [user]);

  const updateFeatureToggle = useCallback(async (featureKey: string, isEnabled: boolean) => {
    const { error } = await supabase
      .from('feature_toggles')
      .update({ is_enabled: isEnabled, updated_by_user_id: user?.id })
      .eq('feature_key', featureKey);

    if (error) throw error;

    // Log to audit
    await supabase.from('audit_logs').insert({
      action: 'FEATURE_TOGGLE_UPDATED',
      entity_type: 'feature_toggle',
      entity_id: featureKey,
      performed_by_user_id: user?.id,
      new_value_json: { feature_key: featureKey, is_enabled: isEnabled },
    });

    // Update local state
    setFeatureToggles(prev =>
      prev.map(t => t.feature_key === featureKey ? { ...t, is_enabled: isEnabled } : t)
    );
  }, [user]);

  return (
    <PermissionsContext.Provider value={{
      can,
      isFeatureEnabled,
      canAccessPage,
      canSeeNav,
      allPermissions,
      featureToggles,
      updatePermission,
      updateFeatureToggle,
      refresh: fetchData,
      loading,
    }}>
      {children}
    </PermissionsContext.Provider>
  );
}
