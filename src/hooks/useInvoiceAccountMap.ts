import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type InvoiceTarget = { kind: 'layaway' | 'cash_order'; id: string };

/**
 * Resolve invoice numbers to their owning account, for linking.
 * Both layaway_accounts.invoice_number and cash_orders.invoice_number are
 * UNIQUE and indexed, so each invoice maps to at most one row per table.
 * Layaway takes precedence, matching the existing lookup order in
 * ServiceJobDialog.resolveInvoice and TradeInDialog.lookupInvoice.
 * Invoices with no matching account resolve to undefined and render as
 * plain text — a real condition in live data (e.g. service job 19246).
 */
export function useInvoiceAccountMap(invoiceNumbers: string[]) {
  const unique = Array.from(new Set(invoiceNumbers.filter((n) => /^[0-9]+$/.test(n)))).sort();
  return useQuery<Record<string, InvoiceTarget>>({
    queryKey: ['invoice-account-map', unique],
    enabled: unique.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const [laRes, coRes] = await Promise.all([
        supabase.from('layaway_accounts').select('id, invoice_number').in('invoice_number', unique),
        supabase.from('cash_orders').select('id, invoice_number').in('invoice_number', unique),
      ]);
      if (laRes.error) throw laRes.error;
      if (coRes.error) throw coRes.error;
      const map: Record<string, InvoiceTarget> = {};
      for (const co of coRes.data ?? []) {
        if (co.invoice_number) map[co.invoice_number] = { kind: 'cash_order', id: co.id };
      }
      for (const la of laRes.data ?? []) {
        if (la.invoice_number) map[la.invoice_number] = { kind: 'layaway', id: la.id };
      }
      return map;
    },
  });
}

export function invoiceHref(t: InvoiceTarget) {
  return t.kind === 'layaway' ? `/accounts/${t.id}` : `/cash-orders/${t.id}`;
}
