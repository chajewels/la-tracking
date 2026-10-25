import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { isMissingFunction } from "@/components/website/shipping-fees";
import { monthKeyTokyo } from "@/components/finance/expenses";
import { BOOKED_MONTHS_KEY, type BookedMonth, type BookingSource, normaliseBookedMonths } from "@/components/finance/mark-paid";

/** The payroll / commission bookings a "Mark as paid" panel shows (Expenses Phase 2). */

export async function callRpc(name: string, args?: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase.rpc(name as any, args as any);
  if (error) throw error;
  const out = (data ?? {}) as Record<string, unknown>;
  if (typeof out.error === "string") throw Object.assign(new Error(out.error), { code: out.error });
  return out;
}

export type BookedState = { available: true; months: BookedMonth[]; rate: number | null } | { available: false };

export function useBookedMonths(source: BookingSource, enabled: boolean) {
  return useQuery<BookedState>({
    queryKey: [...BOOKED_MONTHS_KEY, source],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      try {
        const out = await callRpc("get_booked_months", { p_source: source });
        let rate: number | null = null;
        try {
          const book = await callRpc("get_expense_book", { p_month: `${monthKeyTokyo()}-01` });
          rate = book.php_jpy_rate == null ? null : Number(book.php_jpy_rate);
        } catch { /* the yen preview is optional */ }
        return { available: true, months: normaliseBookedMonths(out.months), rate };
      } catch (e) {
        if (isMissingFunction(e)) return { available: false };
        throw e;
      }
    },
  });
}
