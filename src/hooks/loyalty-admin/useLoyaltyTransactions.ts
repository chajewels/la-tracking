import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type LoyaltyTransactionType =
  | 'all'
  | 'earned'
  | 'bonus'
  | 'redeemed'
  | 'expired'
  | 'adjusted'
  | 'refunded'
  | 'revoked'
  | 'birthday_bonus'
  | 'enrolled'
  | 'tier_changed'
  | 'status_changed'
  | 'admin_edited';

export type LoyaltyTransactionViewKind = 'member' | 'transactions';

export const MEMBER_EVENT_TYPES = [
  'enrolled',
  'tier_changed',
  'status_changed',
  'admin_edited',
] as const;

export const TRANSACTION_EVENT_TYPES = [
  'earned',
  'bonus',
  'redeemed',
  'expired',
  'adjusted',
  'refunded',
  'revoked',
  'birthday_bonus',
] as const;

export interface LoyaltyTransactionRow {
  id: string;
  member_id: string;
  account_id: string | null;
  cash_order_id: string | null;
  payment_id: string | null;
  transaction_type: string;
  points_amount: number;
  spend_amount_jpy: number | null;
  rate_snapshot: number | null;
  invoice_number: string | null;
  tier_at_time: string | null;
  notes: string | null;
  created_at: string;
  customer_code: string | null;
  customer_full_name: string | null;
}

export interface LoyaltyTransactionFilters {
  viewKind: LoyaltyTransactionViewKind;
  transactionType: LoyaltyTransactionType;
  memberSearch: string;
  rangeStartIso: string | null;
  page: number;
  pageSize: number;
}

export interface LoyaltyTransactionResult {
  rows: LoyaltyTransactionRow[];
  totalCount: number;
  totalPages: number;
}

interface RawRow {
  id: string;
  member_id: string;
  account_id: string | null;
  cash_order_id: string | null;
  payment_id: string | null;
  transaction_type: string;
  points_amount: number | string;
  spend_amount_jpy: number | string | null;
  rate_snapshot: number | string | null;
  invoice_number: string | null;
  tier_at_time: string | null;
  notes: string | null;
  created_at: string;
  loyalty_members:
    | {
        customers:
          | { customer_code: string | null; full_name: string | null }
          | null;
      }
    | null;
}

export function useLoyaltyTransactions(filters: LoyaltyTransactionFilters) {
  return useQuery<LoyaltyTransactionResult>({
    queryKey: [
      'loyalty-transactions',
      filters.viewKind,
      filters.rangeStartIso,
      filters.transactionType,
      filters.memberSearch,
      filters.page,
      filters.pageSize,
    ],
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const start = filters.page * filters.pageSize;
      const end = start + filters.pageSize - 1;

      let q = supabase
        .from('loyalty_transactions')
        .select(
          'id, member_id, account_id, cash_order_id, payment_id, transaction_type, points_amount, spend_amount_jpy, rate_snapshot, invoice_number, tier_at_time, notes, created_at, loyalty_members:member_id(customers:customer_id(customer_code, full_name))',
          { count: 'exact' },
        )
        .order('created_at', { ascending: false });

      if (filters.transactionType !== 'all') {
        q = q.eq('transaction_type', filters.transactionType);
      } else if (filters.viewKind === 'member') {
        q = q.in('transaction_type', MEMBER_EVENT_TYPES as never);
      } else {
        q = q.in('transaction_type', TRANSACTION_EVENT_TYPES as never);
      }
      if (filters.rangeStartIso) {
        q = q.gte('created_at', filters.rangeStartIso);
      }

      const { data, count, error } = await q.range(start, end);
      if (error) throw error;

      let rows: LoyaltyTransactionRow[] = ((data || []) as unknown as RawRow[]).map(
        (r) => ({
          id: r.id,
          member_id: r.member_id,
          account_id: r.account_id,
          cash_order_id: r.cash_order_id,
          payment_id: r.payment_id,
          transaction_type: r.transaction_type,
          points_amount: Number(r.points_amount),
          spend_amount_jpy:
            r.spend_amount_jpy == null ? null : Number(r.spend_amount_jpy),
          rate_snapshot:
            r.rate_snapshot == null ? null : Number(r.rate_snapshot),
          invoice_number: r.invoice_number,
          tier_at_time: r.tier_at_time,
          notes: r.notes,
          created_at: r.created_at,
          customer_code: r.loyalty_members?.customers?.customer_code ?? null,
          customer_full_name: r.loyalty_members?.customers?.full_name ?? null,
        }),
      );

      // Member search filtered client-side: PostgREST cannot easily filter
      // on joined embedded resources. Acceptable for current loyalty volume.
      const term = filters.memberSearch.trim().toLowerCase();
      if (term) {
        rows = rows.filter((r) => {
          const code = (r.customer_code ?? '').toLowerCase();
          const name = (r.customer_full_name ?? '').toLowerCase();
          return code.includes(term) || name.includes(term);
        });
      }

      const totalCount = count ?? 0;
      const totalPages = Math.max(1, Math.ceil(totalCount / filters.pageSize));
      return { rows, totalCount, totalPages };
    },
  });
}
