import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { LOYALTY_SETTINGS_AUDIT_ID } from './useLoyaltySettings';

export interface BetaMemberRow {
  id: string;
  customer_id: string;
  added_by_user_id: string | null;
  notes: string | null;
  created_at: string;
  customers: {
    full_name: string | null;
    customer_code: string | null;
    email: string | null;
  } | null;
}

export interface BetaMemberView extends BetaMemberRow {
  added_by_name: string;
}

export interface CustomerSearchHit {
  id: string;
  full_name: string;
  customer_code: string | null;
  email: string | null;
}

export function useBetaMembers(enabled: boolean = true) {
  return useQuery<BetaMemberView[]>({
    queryKey: ['loyalty-beta-members'],
    enabled,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('loyalty_beta_members')
        .select(
          'id, customer_id, added_by_user_id, notes, created_at, customers:customer_id(full_name, customer_code, email)',
        )
        .order('created_at', { ascending: false });
      if (error) throw error;
      const rows = ((data || []) as unknown) as BetaMemberRow[];

      const addedByIds = Array.from(
        new Set(rows.map((r) => r.added_by_user_id).filter(Boolean)),
      ) as string[];

      const profilesMap: Record<string, string> = {};
      if (addedByIds.length > 0) {
        const { data: profilesData } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', addedByIds);
        for (const p of (profilesData || []) as Array<{ id: string; full_name: string | null }>) {
          if (p.id) profilesMap[p.id] = p.full_name || '—';
        }
      }

      return rows.map((r) => ({
        ...r,
        added_by_name: r.added_by_user_id ? profilesMap[r.added_by_user_id] || '—' : '—',
      }));
    },
  });
}

export function useCustomerSearchForBeta(query: string, excludeIds: Set<string>) {
  return useQuery<CustomerSearchHit[]>({
    queryKey: ['loyalty-beta-customer-search', query],
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const trimmed = query.trim();
      const pattern = `%${trimmed}%`;
      const { data, error } = await supabase
        .from('customers')
        .select('id, full_name, customer_code, email')
        .or(
          `full_name.ilike.${pattern},customer_code.ilike.${pattern},email.ilike.${pattern}`,
        )
        .order('full_name', { ascending: true })
        .limit(10);
      if (error) throw error;
      const hits = ((data || []) as unknown) as CustomerSearchHit[];
      return hits.filter((h) => !excludeIds.has(h.id));
    },
  });
}

export function useAddBetaMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      customerId,
      addedByUserId,
      notes,
    }: {
      customerId: string;
      addedByUserId: string | null;
      notes?: string | null;
    }) => {
      const { error } = await supabase.from('loyalty_beta_members').insert({
        customer_id: customerId,
        added_by_user_id: addedByUserId,
        notes: notes ?? null,
      });
      if (error) throw error;

      if (addedByUserId) {
        await supabase.from('audit_logs').insert({
          entity_type: 'loyalty_beta',
          entity_id: customerId,
          action: 'beta_added',
          performed_by_user_id: addedByUserId,
          new_value_json: { customer_id: customerId, notes: notes ?? null },
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loyalty-beta-members'] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-stats'] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-audit-log'] });
    },
  });
}

export function useRemoveBetaMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (betaMemberId: string) => {
      const { data: existing } = await supabase
        .from('loyalty_beta_members')
        .select('customer_id, notes')
        .eq('id', betaMemberId)
        .maybeSingle();

      const { error } = await supabase
        .from('loyalty_beta_members')
        .delete()
        .eq('id', betaMemberId);
      if (error) throw error;

      const { data: { user } } = await supabase.auth.getUser();
      if (user && existing) {
        await supabase.from('audit_logs').insert({
          entity_type: 'loyalty_beta',
          entity_id: (existing as any).customer_id,
          action: 'beta_removed',
          performed_by_user_id: user.id,
          old_value_json: existing,
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loyalty-beta-members'] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-stats'] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-audit-log'] });
    },
  });
}

export function useLoyaltyEnabledFlag() {
  return useQuery({
    queryKey: ['settings', 'loyalty_enabled'],
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'loyalty_enabled')
        .maybeSingle();
      const raw = data?.value;
      if (raw == null) return false;
      try {
        const parsed = JSON.parse(String(raw));
        return parsed === true || parsed === 'true';
      } catch {
        return String(raw).toLowerCase() === 'true';
      }
    },
  });
}

export function useSetLoyaltyEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      const { data: prevRow } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'loyalty_enabled')
        .maybeSingle();
      let prevParsed: boolean = false;
      if (prevRow?.value != null) {
        try {
          const p = JSON.parse(String(prevRow.value));
          prevParsed = p === true || p === 'true';
        } catch {
          prevParsed = String(prevRow.value).toLowerCase() === 'true';
        }
      }

      const { error } = await supabase
        .from('system_settings')
        .upsert(
          { key: 'loyalty_enabled', value: JSON.stringify(enabled) },
          { onConflict: 'key' },
        );
      if (error) throw error;

      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase.from('audit_logs').insert({
          entity_type: 'loyalty_settings',
          entity_id: LOYALTY_SETTINGS_AUDIT_ID,
          action: enabled ? 'loyalty_enabled_on' : 'loyalty_enabled_off',
          performed_by_user_id: user.id,
          old_value_json: { key: 'loyalty_enabled', value: prevParsed },
          new_value_json: { key: 'loyalty_enabled', value: enabled },
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings', 'loyalty_enabled'] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-settings'] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-audit-log'] });
    },
  });
}
