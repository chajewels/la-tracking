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

// ──────────────────────────────────────────────
// CUSTOMERS
// ──────────────────────────────────────────────
export function useCustomers() {
  return useQuery({
    queryKey: ['customers'],
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
    queryFn: async () => {
      // Get customer
      const { data: customer, error: custErr } = await supabase
        .from('customers')
        .select('*')
        .eq('id', customerId!)
        .single();
      if (custErr) throw custErr;

      // Get all accounts for this customer
      const { data: accts, error: acctErr } = await supabase
        .from('layaway_accounts')
        .select('*')
        .eq('customer_id', customerId!)
        .order('created_at', { ascending: false });
      if (acctErr) throw acctErr;

      const accountIds = (accts || []).map(a => a.id);

      // Fetch schedules, penalties, and payments for all accounts in parallel
      const [schedRes, penRes, payRes] = await Promise.all([
        accountIds.length > 0
          ? supabase.from('layaway_schedule').select('*').in('account_id', accountIds).order('installment_number', { ascending: true })
          : Promise.resolve({ data: [] as DbSchedule[], error: null }),
        accountIds.length > 0
          ? supabase.from('penalty_fees').select('*').in('account_id', accountIds)
          : Promise.resolve({ data: [] as DbPenalty[], error: null }),
        accountIds.length > 0
          ? supabase.from('payments').select('*').in('account_id', accountIds).order('date_paid', { ascending: true })
          : Promise.resolve({ data: [] as any[], error: null }),
      ]);

      const schedules = (schedRes.data || []) as DbSchedule[];
      const penalties = (penRes.data || []) as DbPenalty[];
      const allPayments = (payRes.data || []) as any[];

      const accounts = (accts || []).map(acct => ({
        account: acct,
        schedule: schedules.filter(s => s.account_id === acct.id),
        penalties: penalties.filter(p => p.account_id === acct.id),
        payments: allPayments.filter(p => p.account_id === acct.id),
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
// PAYMENTS
// ──────────────────────────────────────────────
export function usePayments(accountId?: string) {
  return useQuery({
    queryKey: accountId ? ['payments', accountId] : ['payments'],
    queryFn: async () => {
      let query = supabase
        .from('payments')
        .select('*')
        .order('date_paid', { ascending: false });
      if (accountId) query = query.eq('account_id', accountId);
      const { data, error } = await query;
      if (error) throw error;
      return data as DbPayment[];
    },
  });
}

export function useRecentPaymentsWithAccount() {
  return useQuery({
    queryKey: ['payments-with-accounts'],
    queryFn: async () => {
      const { data: payments, error: pErr } = await supabase
        .from('payments')
        .select('*')
        .order('date_paid', { ascending: false })
        .limit(10);
      if (pErr) throw pErr;

      // Fetch related accounts + customers
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
export function useDashboardSummary(currencyMode: 'PHP' | 'JPY' | 'ALL') {
  return useQuery({
    queryKey: ['dashboard-summary', currencyMode],
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
        due_today_count: number;
        due_3_days_count: number;
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
    }) => {
      const { data, error } = await supabase.functions.invoke('create-layaway-account', {
        body: payload,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
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
      if (!variables.preview_only) {
        qc.invalidateQueries({ queryKey: ['accounts'] });
        qc.invalidateQueries({ queryKey: ['payments'] });
        qc.invalidateQueries({ queryKey: ['schedule'] });
        qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
        qc.invalidateQueries({ queryKey: ['payments-with-accounts'] });
      }
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['schedule'] });
      qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
      qc.invalidateQueries({ queryKey: ['payments-with-accounts'] });
    },
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
      remarks?: string;
      payment_method?: string;
      reference_number?: string;
    }) => {
      const { id, ...updates } = payload;
      const { data, error } = await supabase
        .from('payments')
        .update(updates)
        .eq('id', id)
        .is('voided_at', null)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['payments-with-accounts'] });
    },
  });
}

// ──────────────────────────────────────────────
// RESTORE VOIDED PAYMENT (via edge function)
// ──────────────────────────────────────────────
export function useRestorePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { payment_id: string }) => {
      const { data, error } = await supabase.functions.invoke('restore-payment', {
        body: payload,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['schedule'] });
      qc.invalidateQueries({ queryKey: ['dashboard-summary'] });
      qc.invalidateQueries({ queryKey: ['payments-with-accounts'] });
    },
  });
}
