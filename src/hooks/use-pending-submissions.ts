import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { type AppRole } from '@/lib/role-permissions';

export function usePendingSubmissionCount() {
  const { session, roles } = useAuth();
  const userRoles = roles as AppRole[];
  const canSee = userRoles.includes('admin') || userRoles.includes('finance');

  return useQuery({
    queryKey: ['pending-submission-count'],
    queryFn: async () => {
      const { count, error } = await (supabase as any)
        .from('payment_submissions')
        .select('id', { count: 'exact', head: true })
        .in('status', ['submitted', 'under_review']);
      if (error) throw error;
      return count ?? 0;
    },
    enabled: !!session && canSee,
    refetchInterval: 30_000, // poll every 30s for near-realtime
  });
}

export interface PendingSubmissionSummary {
  id: string;
  submitted_amount: number;
  payment_method: string;
  created_at: string;
  status: string;
  customer_name: string;
  invoice_number: string;
  currency: string;
  account_id: string;
}

export function usePendingSubmissions(limit = 5) {
  const { session, roles } = useAuth();
  const userRoles = roles as AppRole[];
  const canSee = userRoles.includes('admin') || userRoles.includes('finance');

  return useQuery({
    queryKey: ['pending-submissions-summary', limit],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('payment_submissions')
        .select('id, submitted_amount, payment_method, created_at, status, account_id, customers(full_name), layaway_accounts(invoice_number, currency)')
        .in('status', ['submitted', 'under_review'])
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data || []).map((s: any) => ({
        id: s.id,
        submitted_amount: s.submitted_amount,
        payment_method: s.payment_method,
        created_at: s.created_at,
        status: s.status,
        customer_name: s.customers?.full_name || '—',
        invoice_number: s.layaway_accounts?.invoice_number || '—',
        currency: s.layaway_accounts?.currency || 'PHP',
        account_id: s.account_id,
      })) as PendingSubmissionSummary[];
    },
    enabled: !!session && canSee,
    refetchInterval: 30_000,
  });
}
