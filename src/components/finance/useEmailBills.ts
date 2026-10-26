import { useQuery } from "@tanstack/react-query";
import { isMissingFunction } from "@/components/website/shipping-fees";
import { callRpc } from "@/components/finance/useBookedMonths";
import { EMAIL_BILLS_KEY, type EmailBillsState, normaliseEmailBills } from "@/components/finance/email-bills";

/** The emailed-bills list (Expenses Phase 4); { available: false } until the migration exists. */
export function useEmailBills(enabled: boolean) {
  return useQuery<EmailBillsState>({
    queryKey: EMAIL_BILLS_KEY,
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      try {
        return normaliseEmailBills(await callRpc("get_email_bills", { p_days: 30 }));
      } catch (e) {
        if (isMissingFunction(e)) return { available: false };
        throw e;
      }
    },
  });
}

