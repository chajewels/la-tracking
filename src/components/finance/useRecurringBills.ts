import { useQuery } from "@tanstack/react-query";
import { isMissingFunction } from "@/components/website/shipping-fees";
import { callRpc } from "@/components/finance/useBookedMonths";
import { todayTokyo } from "@/components/finance/expenses";
import { RECURRING_BILLS_KEY, type RecurringState, normaliseBills } from "@/components/finance/recurring";

/** The recurring-bill templates (Expenses Phase 3); { available: false } until the migration exists. */
export function useRecurringBills(enabled: boolean) {
  return useQuery<RecurringState>({
    queryKey: RECURRING_BILLS_KEY,
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      try {
        const out = await callRpc("get_recurring_bills");
        return { available: true, today: String(out.today ?? todayTokyo()), bills: normaliseBills(out.bills) };
      } catch (e) {
        if (isMissingFunction(e)) return { available: false };
        throw e;
      }
    },
  });
}

