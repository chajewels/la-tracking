import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { REALTIME_INVALIDATE_KEYS } from './use-supabase-data';
import { useAuth } from '@/contexts/AuthContext';

const SYNC_TABLES = [
  'payments',
  'payment_allocations',
  'layaway_schedule',
  'layaway_accounts',
  'penalty_fees',
  'payment_submissions',
  'account_services',
] as const;

const DEBOUNCE_MS = 250;

/**
 * Global cross-user realtime sync. Render ONCE at the App root (inside the auth
 * provider). The subscription is gated on the user being an authorized INTERNAL
 * user (admin/staff/finance/csr) — the same predicate ProtectedRoute uses — so it
 * is inert for the customer portal and unauthenticated visitors (no channel opens).
 * On any postgres_changes event (debounced) it invalidates the shared React Query
 * key groups so every actively-rendered internal dashboard card refetches live.
 * Requires the SYNC_TABLES to be in the supabase_realtime publication.
 */
export function useRealtimeSync() {
  const qc = useQueryClient();
  const { session, roles } = useAuth();
  // Same signal ProtectedRoute admits internal users with: an authenticated
  // session AND at least one assigned AppRole (admin/staff/finance/csr).
  // Portal customers and unauthenticated visitors have roles=[] → false.
  const isInternalUser = !!session && roles.length > 0;

  useEffect(() => {
    if (!isInternalUser) return; // no channel for customers / unauthenticated

    let timer: ReturnType<typeof setTimeout> | null = null;
    const invalidate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        for (const key of REALTIME_INVALIDATE_KEYS) {
          qc.invalidateQueries({ queryKey: [key] });
        }
        timer = null;
      }, DEBOUNCE_MS);
    };

    let channel = supabase.channel('global-sync');
    for (const table of SYNC_TABLES) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        invalidate,
      );
    }
    channel.subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [qc, isInternalUser]);
}
