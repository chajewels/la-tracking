import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';

// ── Re-export DB row types with short aliases ──
export type DbCustomer = Tables<'customers'>;
export type DbAccount = Tables<'layaway_accounts'>;
export type DbSchedule = Tables<'layaway_schedule'>;
export type DbPayment = Tables<'payments'>;
export type DbPenalty = Tables<'penalty_fees'>;
export type DbWaiverRequest = Tables<'penalty_waiver_requests'>;

// ── Joined account type for list / detail views ──
export interface AccountWithCustomer extends DbAccount {
  customers: DbCustomer;
}

// ── Scoped invalidation for better performance ──
const CORE_KEYS = ['accounts', 'dashboard-summary', 'payments-with-accounts', 'customers'] as const;
const PAYMENT_KEYS = ['payments', 'schedule', 'collections-upcoming-schedule', 'weekly-collections', 'aging-buckets', 'overdue-schedule'] as const;
const MONITORING_KEYS = ['monitoring-schedules', 'csr-notifications', 'penalty-followup-alerts', 'csr-notifications-penalty'] as const;
const SUBMISSION_KEYS = ['pending-submission-count', 'pending-submissions-summary', 'payment-submissions'] as const;

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const key of [...CORE_KEYS, ...PAYMENT_KEYS]) {
    qc.invalidateQueries({ queryKey: [key] });
  }
}

function invalidatePaymentRelated(qc: ReturnType<typeof useQueryClient>) {
  for (const key of [...CORE_KEYS, ...PAYMENT_KEYS, ...MONITORING_KEYS]) {
    qc.invalidateQueries({ queryKey: [key] });
  }
}

function invalidateSubmissions(qc: ReturnType<typeof useQueryClient>) {
  for (const key of SUBMISSION_KEYS) {
    qc.invalidateQueries({ queryKey: [key] });
  }
}

// ── Shared staleTime configs ──
const STALE_SHORT = 30_000;    // 30s - for frequently changing data
const STALE_MEDIUM = 60_000;   // 1min - for moderately changing data  
const STALE_LONG = 5 * 60_000; // 5min - for rarely changing data

// ──────────────────────────────────────────────
// CUSTOMERS
// ──────────────────────────────────────────────
export function useCustomers() {
  return useQuery({
    queryKey: ['customers'],
    staleTime: STALE_MEDIUM,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('customers')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as DbCustomer[];
    },
  });
}

// ──────────────────────────────────────────────
// LAYAWAY ACCOUNTS (with joined customer)
// ──────────────────────────────────────────────
export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    staleTime: STALE_SHORT,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('layaway_accounts')
        .select('*, customers(*)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as AccountWithCustomer[];
    },
  });
}

export function useAccount(id: string | undefined) {
  return useQuery({
    queryKey: ['accounts', id],
    enabled: !!id,
    staleTime: STALE_SHORT,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('layaway_accounts')
        .select('*, customers(*)')
        .eq('id', id!)
        .maybeSingle();
      if (error) throw error;
      return data as AccountWithCustomer | null;
    },
  });
}

// ──────────────────────────────────────────────
// CUSTOMER DETAIL (all accounts + schedules + penalties)
// ──────────────────────────────────────────────
export function useCustomerAccounts(customerId: string | undefined) {
  return useQuery({
    queryKey: ['customer-detail', customerId],
    enabled: !!customerId,
    staleTime: STALE_SHORT,
    queryFn: async () => {
      const { data: customer, error: custErr } = await supabase
        .from('customers')
        .select('*')
        .eq('id', customerId!)
        .single();
      if (custErr) throw custErr;

      const { data: accts, error: acctErr } = await supabase
        .from('layaway_accounts')
        .select('*')
        .eq('customer_id', customerId!)
        .order('created_at', { ascending: false });
      if (acctErr) throw acctErr;

      const accountIds = (accts || []).map(a => a.id);

      const [schedRes, penRes, payRes, svcRes] = await Promise.all([
        accountIds.length > 0
          ? supabase.from('layaway_schedule').select('*').in('account_id', accountIds).order('installment_number', { ascending: true })
          : Promise.resolve({ data: [] as DbSchedule[], error: null }),
        accountIds.length > 0
          ? supabase.from('penalty_fees').select('*').in('account_id', accountIds)
          : Promise.resolve({ data: [] as DbPenalty[], error: null }),
        accountIds.length > 0
          ? supabase.from('payments').select('*').in('account_id', accountIds).order('date_paid', { ascending: true })
          : Promise.resolve({ data: [] as any[], error: null }),
        accountIds.length > 0
          ? supabase.from('account_services' as any).select('*').in('account_id', accountIds).order('created_at', { ascending: true })
          : Promise.resolve({ data: [] as any[], error: null }),
      ]);

      const schedules = (schedRes.data || []) as DbSchedule[];
      const penalties = (penRes.data || []) as DbPenalty[];
      const allPayments = (payRes.data || []) as any[];
      const allServices = (svcRes.data || []) as any[];

      const scheduleIds = schedules.map(s => s.id);
      const allocations = scheduleIds.length > 0
        ? (await supabase.from('payment_allocations').select('*').in('schedule_id', scheduleIds)).data || []
        : [];

      const schedulePaymentDateMap: Record<string, string> = {};
      for (const alloc of allocations as any[]) {
        const payment = allPayments.find(p => p.id === alloc.payment_id && !p.voided_at);
        if (payment) {
          const existing = schedulePaymentDateMap[alloc.schedule_id];
          if (!existing || payment.date_paid > existing) {
            schedulePaymentDateMap[alloc.schedule_id] = payment.date_paid;
          }
        }
      }

      const accounts = (accts || []).map(acct => ({
        account: acct,
        schedule: schedules.filter(s => s.account_id === acct.id),
        penalties: penalties.filter(p => p.account_id === acct.id),
        payments: allPayments.filter(p => p.account_id === acct.id),
        services: allServices.filter((s: any) => s.account_id === acct.id),
        schedulePaymentDates: schedulePaymentDateMap,
      }));

      return { customer: customer as DbCustomer, accounts };
    },
  });
}

// ──────────────────────────────────────────────
// SCHEDULE
// ──────────────────────────────────────────────
export function useSchedule(accountId: string | undefined) {
  return useQuery({
    queryKey: ['schedule', accountId],
    enabled: !!accountId,
    staleTime: STALE_SHORT,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('layaway_schedule')
        .select('*')
        .eq('account_id', accountId!)
        .order('installment_number', { ascending: true });
      if (error) throw error;
      return data as DbSchedule[];
    },
  });
}

// ──────────────────────────────────────────────
// ACCOUNT SERVICES
// ──────────────────────────────────────────────
export function useAccountServices(accountId: string | undefined) {
  return useQuery({
    queryKey: ['account-services', accountId],
    enabled: !!accountId,
    staleTime: STALE_MEDIUM,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('account_services' as any)
        .select('*')
        .eq('account_id', accountId!)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data as any[];
    },
  });
}

// ──────────────────────────────────────────────
// PAYMENTS
// ──────────────────────────────────────────────
export function usePayments(accountId?: string) {
  return useQuery({
    queryKey: accountId ? ['payments', accountId] : ['payments'],
    staleTime: STALE_SHORT,
    queryFn: async () => {
      let query = supabase
        .from('payments')
        .select('*')
        .order('date_paid', { ascending: false });
      if (accountId) query = query.eq('account_id', accountId);
      else query = query.limit(500); // Limit global payment fetch
      const { data, error } = await query;
      if (error) throw error;
      return data as DbPayment[];
    },
  });
}

export function useRecentPaymentsWithAccount() {
  return useQuery({
    queryKey: ['payments-with-accounts'],
    staleTime: STALE_SHORT,
    queryFn: async () => {
      const { data: payments, error: pErr } = await supabase
        .from('payments')
        .select('*')
        .is('voided_at', null)
        .order('date_paid', { ascending: false })
        .limit(10);
      if (pErr) throw pErr;

      const accountIds = [...new Set((payments || []).map(p => p.account_id))];
      if (accountIds.length === 0) return [];

      const { data: accounts, error: aErr } = await supabase
        .from('layaway_accounts')
        .select('*, customers(*)')
        .in('id', accountIds);
      if (aErr) throw aErr;

      const accountMap = new Map((accounts || []).map(a => [a.id, a as AccountWithCustomer]));
      return (payments || []).map(p => ({
        ...p,
        account: accountMap.get(p.account_id) || null,
      }));
    },
  });
}

// ──────────────────────────────────────────────
// PENALTIES
// ──────────────────────────────────────────────
export function usePenalties(accountId?: string) {
  return useQuery({
    queryKey: accountId ? ['penalties', accountId] : ['penalties'],
    staleTime: STALE_MEDIUM,
    queryFn: async () => {
      let query = supabase.from('penalty_fees').select('*');
      if (accountId) query = query.eq('account_id', accountId);
      const { data, error } = await query.order('penalty_date', { ascending: true });
      if (error) throw error;
      return data as DbPenalty[];
    },
  });
}

// ──────────────────────────────────────────────
// WAIVER REQUESTS
// ──────────────────────────────────────────────
export function useWaiverRequests(accountId?: string) {
  return useQuery({
    queryKey: accountId ? ['waivers', accountId] : ['waivers'],
    staleTime: STALE_MEDIUM,
    queryFn: async () => {
      let query = supabase.from('penalty_waiver_requests').select('*');
      if (accountId) query = query.eq('account_id', accountId);
      const { data, error } = await query.order('created_at', { ascending: false });
      if (error) throw error;
      return data as DbWaiverRequest[];
    },
  });
}

// ──────────────────────────────────────────────
// DASHBOARD SUMMARY (from edge function)
// ──────────────────────────────────────────────
export function useDashboardSummary(currencyMode: 'PHP' | 'JPY' | 'ALL', enabled = true) {
  return useQuery({
    queryKey: ['dashboard-summary', currencyMode],
    enabled,
    retry: false,
    staleTime: STALE_MEDIUM,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('dashboard-summary', {
        body: { currency_mode: currencyMode },
      });
      if (error) throw error;
      return data as {
        total_receivables: number;
        active_layaways: number;
        payments_today: number;
        collections_this_month: number;
        overdue_accounts: number;
        overdue_amount: number;
        completed_this_month: number;
        forfeited_accounts: number;
        due_today_count: number;
        due_3_days_count: number;
        due_7_days_count: number;
        penalties_today_count: number;
        penalties_today_amount: number;
        pending_waivers_count: number;
        total_penalties_applied: number;
        total_penalties_waived: number;
        total_penalties_amount: number;
        total_waived_amount: number;
        reminder_total: number;
        reminder_success: number;
        reminder_failed: number;
        currency: string;
        currency_filter: string;
        conversion_rate: number;
        predicted_30d: number;
        predicted_30d_raw: number;
        predicted_90d: number;
        predicted_90d_raw: number;
        next_month_expected: number;
        next_month_adjusted: number;
        forecast_6_months: { month: string; expected: number; adjusted: number }[];
      };
    },
  });
}

// ──────────────────────────────────────────────
// CREATE ACCOUNT (via edge function)
// ──────────────────────────────────────────────
export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      customer_id: string;
      invoice_number: string;
      currency: 'PHP' | 'JPY';
      total_amount: number;
      order_date: string;
      payment_plan_months: number;
      notes?: string;
      downpayment_amount?: number;
      downpayment_paid?: number;
      remaining_dp_option?: 'split' | 'add_to_installments';
      split_allocations?: { account_id: string; amount: number }[];
      lump_sum_total?: number;
      custom_installments?: number[];
    }) => {
      const { data, error } = await supabase.functions.invoke('create-layaway-account', {
        body: payload,
      });
      if (error) {
        // Extract detailed error from FunctionsHttpError response body
        let detailedMsg = error.message || 'Failed to create account';
        try {
          if ('context' in error && (error as any).context?.body) {
            const body = await new Response((error as any).context.body).json();
            if (body?.error) detailedMsg = body.error;
          }
        } catch {
          // Fallback to generic message
        }
        throw new Error(detailedMsg);
      }
      if (data?.error) {
        const msg = (typeof data.error === 'string' && data.error.includes('duplicate key') && data.error.includes('invoice_number'))
          ? `Invoice number "${payload.invoice_number}" already exists. Please use a different invoice number.`
          : (typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
        throw new Error(msg);
      }
      return data;
    },
    onSuccess: () => invalidateAll(qc),
  });
}

// ──────────────────────────────────────────────
// RECORD PAYMENT (via edge function)
// ──────────────────────────────────────────────
export function useRecordPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      account_id: string;
      amount: number;
      currency: 'PHP' | 'JPY';
      date_paid?: string;
      payment_method?: string;
      remarks?: string;
      preview_only?: boolean;
    }) => {
      const { amount, ...rest } = payload;
      const { data, error } = await supabase.functions.invoke('record-payment', {
        body: { ...rest, amount_paid: amount },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_data, variables) => {
      if (!variables.preview_only) invalidatePaymentRelated(qc);
    },
  });
}

// ──────────────────────────────────────────────
// CREATE CUSTOMER
// ──────────────────────────────────────────────
export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      customer_code: string;
      full_name: string;
      mobile_number?: string;
      email?: string;
      facebook_name?: string;
      messenger_link?: string;
      preferred_contact_method?: string;
      notes?: string;
      location?: string;
    }) => {
      const { data, error } = await supabase
        .from('customers')
        .insert(payload)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

// ──────────────────────────────────────────────
// VOID PAYMENT (via edge function)
// ──────────────────────────────────────────────
export function useVoidPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { payment_id: string; reason?: string }) => {
      const { data, error } = await supabase.functions.invoke('void-payment', {
        body: payload,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidatePaymentRelated(qc),
  });
}

// ──────────────────────────────────────────────
// RECORD MULTI-PAYMENT (via edge function)
// ──────────────────────────────────────────────
export function useRecordMultiPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: any) => {
      const { data, error } = await supabase.functions.invoke('record-multi-payment', {
        body: payload,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidatePaymentRelated(qc),
  });
}

// ──────────────────────────────────────────────
// EDIT PAYMENT (date, notes, method — not amount)
// ──────────────────────────────────────────────
export function useEditPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      id: string;
      date_paid?: string;
      payment_method?: string;
      remarks?: string;
    }) => {
      const { id, ...updates } = payload;
      const { error } = await supabase
        .from('payments')
        .update(updates)
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      for (const key of ['payments', 'payments-with-accounts', 'weekly-collections']) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

// ──────────────────────────────────────────────
// EDIT PAYMENT AMOUNT (via edge function — full reallocation)
// ──────────────────────────────────────────────
export function useEditPaymentAmount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      payment_id: string;
      new_amount: number;
      reason?: string;
    }) => {
      const { data, error } = await supabase.functions.invoke('edit-payment-amount', {
        body: payload,
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => invalidatePaymentRelated(qc),
  });
}

// ──────────────────────────────────────────────
// RESTORE PAYMENT (un-void)
// ──────────────────────────────────────────────
export function useRestorePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { payment_id: string; selected_schedule_ids?: string[] }) => {
      const { data, error } = await supabase.functions.invoke('restore-payment', {
        body: payload,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidatePaymentRelated(qc),
  });
}

// ──────────────────────────────────────────────
// DELETE ACCOUNT (via edge function)
// ──────────────────────────────────────────────
export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (accountId: string) => {
      const { data, error } = await supabase.functions.invoke('delete-account', {
        body: { account_id: accountId },
      });
      if (error) {
        // Extract detailed error from FunctionsHttpError response body
        let detailedMsg = error.message || 'Failed to delete account';
        try {
          if ('context' in error && (error as any).context?.body) {
            const body = await new Response((error as any).context.body).json();
            if (body?.error) detailedMsg = body.error;
          }
        } catch {
          // Fallback to generic message
        }
        throw new Error(detailedMsg);
      }
      if (data?.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
      if (!data?.success) throw new Error('Delete operation did not complete successfully');
      return data;
    },
    onSuccess: () => invalidateAll(qc),
  });
}

// ──────────────────────────────────────────────
// FORFEIT ACCOUNT (via edge function)
// ──────────────────────────────────────────────
export function useForfeitAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (accountId: string) => {
      const { data, error } = await supabase.functions.invoke('auto-forfeit-settlement', {
        body: { account_id: accountId },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidateAll(qc),
  });
}

// ──────────────────────────────────────────────
// PENALTY CAP OVERRIDES
// ──────────────────────────────────────────────
export function usePenaltyCapOverride(accountId: string | undefined) {
  return useQuery({
    queryKey: ['penalty-cap-override', accountId],
    enabled: !!accountId,
    staleTime: STALE_LONG,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('penalty_cap_overrides')
        .select('*')
        .eq('account_id', accountId!)
        .eq('is_active', true)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}
