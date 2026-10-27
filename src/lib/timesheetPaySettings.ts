/**
 * Pay settings history (owner 2026-10-27; docs/TIMESHEET-SPEC.md "Pay settings history";
 * migration 20270204100000_payslip_bond_payhistory.sql). Reads timesheet_pay_settings and calls
 * set_timesheet_pay_setting; the month resolution itself lives in timesheetEngine
 * (paySettingFor / payProfileForMonth).
 *
 * Until the migration is applied the table does not exist: fetchPaySettings answers
 * { available: false, settings: [] } and every month uses the profile's own basic / allowance.
 */
import { supabase } from '@/integrations/supabase/client';
import type { PaySetting } from '@/lib/timesheetEngine';

/** The first month the Hub covers once the migration is applied (owner 2026-10-27, decision L). */
export const TIMESHEET_FIRST_MONTH = '2026-04';

/**
 * The ONE cast for this table. CLAUDE.md's rule for a table missing from the generated types is
 * "cast at the call site"; delete it when Lovable's next deploy regenerates types.ts with it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const paySettingsTable = () => (supabase as any).from('timesheet_pay_settings');

export interface PaySettingsState {
  available: boolean;
  settings: PaySetting[];
}

/** Every row the caller may read (RLS: admin, finance, can_view_all, or their own). */
export async function fetchPaySettings(): Promise<PaySettingsState> {
  try {
    const { data, error } = await paySettingsTable()
      .select('user_id, effective_from, basic_salary, allowance, note')
      .order('effective_from', { ascending: true });
    if (error) return { available: false, settings: [] };
    const rows = (data ?? []) as Record<string, unknown>[];
    return {
      available: true,
      settings: rows.map(r => ({
        user_id: String(r.user_id),
        effective_from: String(r.effective_from ?? ''),
        basic_salary: r.basic_salary == null ? null : Number(r.basic_salary),
        allowance: r.allowance == null ? null : Number(r.allowance),
        note: (r.note as string | null) ?? null,
      })),
    };
  } catch {
    return { available: false, settings: [] };
  }
}

/** 'YYYY-MM' list, newest first: 12 months back from `current`, and never fewer than back to April 2026. */
export function timesheetMonthOptions(current: string): string[] {
  const out: string[] = [];
  const [y, m] = current.split('-').map(Number);
  for (let i = 0; ; i++) {
    const idx = y * 12 + (m - 1) - i;
    const key = `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
    if (i >= 12 && key < TIMESHEET_FIRST_MONTH) break;
    out.push(key);
    if (i > 240) break;
  }
  return out;
}

/** The settings rows of one staff member, newest first. */
export function payHistoryFor(userId: string, settings: PaySetting[]): PaySetting[] {
  return settings.filter(s => s.user_id === userId)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

function longMonth(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  return `${MONTHS[(m || 1) - 1]} ${y}`;
}

/** Plain-English refusal for set_timesheet_pay_setting; `month` is the effective month ('YYYY-MM'). */
export function paySettingRefusal(code: string | undefined, month: string): string {
  switch (code) {
    case 'payslips_issued': return `A payslip for ${longMonth(month)} or later is already issued — void it first.`;
    case 'permission_denied': return 'Only admin can change pay settings.';
    case 'staff_not_found': return 'This staff member has no timesheet profile.';
    case 'not_csr': return 'Only CSR profiles have a basic salary and allowance.';
    case 'invalid_month': return 'The effective month must be from April 2026 up to 12 months ahead.';
    case 'invalid_amount': return 'Enter the basic salary and allowance in pesos (up to 2 decimals).';
    case 'invalid_note': return 'The note is over 200 characters.';
    default: return 'The pay settings could not be saved. Try again.';
  }
}

export async function setPaySetting(args: {
  userId: string; effectiveFrom: string; basicSalary: number | null; allowance: number | null; note: string | null;
}): Promise<{ ok: true } | { ok: false; code: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase.rpc('set_timesheet_pay_setting' as any, {
    p_user_id: args.userId, p_effective_from: args.effectiveFrom, p_basic_salary: args.basicSalary,
    p_allowance: args.allowance, p_note: args.note,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  if (error) return { ok: false, code: 'error' };
  const out = (data ?? {}) as { ok?: boolean; error?: string };
  return out.ok ? { ok: true } : { ok: false, code: out.error ?? 'error' };
}
