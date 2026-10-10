/**
 * Website → Settings → Cash on delivery (代金引換, owner plan 2026-10-10;
 * docs/COD.md). Words and the pure checks for CodSettingsCard. The writer is
 * set_cod_settings (admin role, audited, guard trigger); this file never
 * decides anything the SQL does not decide again.
 */
export type CodMode = 'off' | 'on';

export interface CodBracketRow {
  max_jpy: number;
  fee_jpy: number;
}

export interface CodSettingsState {
  found: boolean;
  mode: CodMode;
  fee_table: CodBracketRow[] | null;
  fee_table_valid: boolean;
  limit_jpy: number | null;
  updated_at: string | null;
  updated_by_user_id: string | null;
  updated_by_name: string | null;
  can_change: boolean;
  open_cod_orders: number;
  open_cod_drafts: number;
}

export const COD_KEY = ['cod-settings'] as const;

export const COD_MODE_LABEL: Record<CodMode, string> = { off: 'Off', on: 'On' };

export function codEffect(mode: CodMode): string {
  return mode === 'on'
    ? 'Customers with a yen, full-payment order delivered in Japan see "Cash on delivery (代金引換)" at checkout, within the limit. The fee is added as its own line.'
    : 'Cash on delivery is not offered at checkout. Orders already on cash on delivery are not changed.';
}

const REFUSAL: Record<string, string> = {
  permission_denied: 'Only an admin can change cash on delivery.',
  user_identity_required: 'Sign in again and retry.',
  invalid_mode: 'The mode must be Off or On.',
  invalid_fee_table: 'The fee table must have 1–10 rows, whole yen, each "up to" amount larger than the one before, fees between ¥0 and ¥100,000.',
  stale: 'Someone else changed this a moment ago. The card has been refreshed — check and try again.',
  setting_missing: 'The database update for cash on delivery has not been applied yet.',
};

export function codRefusal(code: string): string {
  return REFUSAL[code] ?? code;
}

/**
 * The fee table as typed in the card → rows, or the problem in plain words.
 * Mirrors public.cod_fee_table_valid so the admin sees the problem before the
 * server refuses it.
 */
export function parseCodTable(rows: { max: string; fee: string }[]): { rows: CodBracketRow[] } | { problem: string } {
  if (rows.length < 1 || rows.length > 10) return { problem: 'Keep between 1 and 10 rows.' };
  const out: CodBracketRow[] = [];
  let prev = 0;
  for (const [i, r] of rows.entries()) {
    const max = Number(String(r.max).replace(/[,¥\s]/g, ''));
    const fee = Number(String(r.fee).replace(/[,¥\s]/g, ''));
    if (!Number.isInteger(max) || !Number.isInteger(fee)) return { problem: `Row ${i + 1}: whole yen only.` };
    if (max <= prev) return { problem: `Row ${i + 1}: each "up to" amount must be larger than the row above.` };
    if (max > 10_000_000) return { problem: `Row ${i + 1}: "up to" is too large.` };
    if (fee < 0 || fee > 100_000) return { problem: `Row ${i + 1}: the fee must be between ¥0 and ¥100,000.` };
    out.push({ max_jpy: max, fee_jpy: fee });
    prev = max;
  }
  return { rows: out };
}
