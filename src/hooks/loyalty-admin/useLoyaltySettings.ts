import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * audit_logs.entity_id is UUID NOT NULL. Loyalty settings have no
 * natural per-row UUID — system_settings is keyed by text. This
 * fixed sentinel is used for every entity_type='loyalty_settings'
 * audit entry so the Audit Log tab can filter cleanly.
 *
 * Approved 2026-04-29 alongside the Phase 2 plan. If you ever want
 * per-key audit threading, replace this with one sentinel per key.
 */
export const LOYALTY_SETTINGS_AUDIT_ID =
  '00000000-0000-0000-0000-0000000000a1';

export type LoyaltySheetFrequency = 'manual' | 'hourly' | 'daily';

export interface LoyaltySettings {
  loyalty_enabled: boolean;
  loyalty_email_welcome: boolean;
  loyalty_email_earned: boolean;
  loyalty_email_bonus: boolean;
  loyalty_email_tier_upgrade: boolean;
  loyalty_email_tier_downgrade: boolean;
  loyalty_email_pre_expire: boolean;
  loyalty_email_expire_deduct: boolean;
  loyalty_email_redeem: boolean;
  loyalty_sheet_id: string;
  loyalty_sheet_service_account: string;
  loyalty_sheet_sync_frequency: LoyaltySheetFrequency;
}

export type LoyaltySettingKey = keyof LoyaltySettings;

const BOOLEAN_KEYS: ReadonlySet<LoyaltySettingKey> = new Set([
  'loyalty_enabled',
  'loyalty_email_welcome',
  'loyalty_email_earned',
  'loyalty_email_bonus',
  'loyalty_email_tier_upgrade',
  'loyalty_email_tier_downgrade',
  'loyalty_email_pre_expire',
  'loyalty_email_expire_deduct',
  'loyalty_email_redeem',
]);

const STRING_KEYS: ReadonlySet<LoyaltySettingKey> = new Set([
  'loyalty_sheet_id',
  'loyalty_sheet_service_account',
  'loyalty_sheet_sync_frequency',
]);

function parseValue(key: LoyaltySettingKey, raw: unknown): unknown {
  if (raw == null) {
    return BOOLEAN_KEYS.has(key) ? false : '';
  }
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }
  if (BOOLEAN_KEYS.has(key)) {
    return parsed === true || parsed === 'true';
  }
  if (STRING_KEYS.has(key)) {
    return typeof parsed === 'string' ? parsed : String(parsed ?? '');
  }
  return parsed;
}

const DEFAULTS: LoyaltySettings = {
  loyalty_enabled: false,
  loyalty_email_welcome: true,
  loyalty_email_earned: true,
  loyalty_email_bonus: true,
  loyalty_email_tier_upgrade: true,
  loyalty_email_tier_downgrade: true,
  loyalty_email_pre_expire: true,
  loyalty_email_expire_deduct: true,
  loyalty_email_redeem: true,
  loyalty_sheet_id: '',
  loyalty_sheet_service_account: '',
  loyalty_sheet_sync_frequency: 'manual',
};

export function useLoyaltySettings(enabled: boolean = true) {
  return useQuery<LoyaltySettings>({
    queryKey: ['loyalty-admin-settings'],
    enabled,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const allKeys = Object.keys(DEFAULTS) as LoyaltySettingKey[];
      const { data, error } = await supabase
        .from('system_settings')
        .select('key, value')
        .in('key', allKeys);
      if (error) throw error;

      const result: LoyaltySettings = { ...DEFAULTS };
      for (const row of (data || []) as Array<{ key: string; value: unknown }>) {
        const k = row.key as LoyaltySettingKey;
        if (!(k in DEFAULTS)) continue;
        (result as any)[k] = parseValue(k, row.value);
      }
      return result;
    },
  });
}

export interface UpdateSettingInput<K extends LoyaltySettingKey> {
  key: K;
  newValue: LoyaltySettings[K];
  oldValue: LoyaltySettings[K];
}

export function useUpdateLoyaltySetting() {
  const qc = useQueryClient();
  return useMutation<void, Error, UpdateSettingInput<LoyaltySettingKey>>({
    mutationFn: async (input) => {
      const { key, newValue, oldValue } = input;

      const { error: upsertErr } = await (supabase as any)
        .from('system_settings')
        .upsert(
          { key, value: JSON.stringify(newValue) },
          { onConflict: 'key' },
        );
      if (upsertErr) throw upsertErr;

      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase.from('audit_logs').insert({
          entity_type: 'loyalty_settings',
          entity_id: LOYALTY_SETTINGS_AUDIT_ID,
          action: 'setting_updated',
          performed_by_user_id: user.id,
          old_value_json: { key, value: oldValue },
          new_value_json: { key, value: newValue },
        });
      }
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['loyalty-admin-settings'] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-audit-log'] });
      if (variables.key === 'loyalty_enabled') {
        qc.invalidateQueries({ queryKey: ['settings', 'loyalty_enabled'] });
        qc.invalidateQueries({ queryKey: ['loyalty-access'] });
      }
    },
  });
}
