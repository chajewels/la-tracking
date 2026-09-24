import { getConversionRate } from '@/lib/currency-converter';

/** The "Use ¥Y" hint for the loyalty product amount: (total − shipping) in
 *  JPY — the same nudge Manage Invoice shows. A display hint only (the rate is
 *  this browser's); the CSR confirms the figure before it is saved. */
export function loyaltyHintJpy(total: number, shipping: number, currency: string): number | null {
  const base = total - shipping;
  if (!(base > 0)) return null;
  return currency === 'PHP' ? Math.round(base / getConversionRate()) : Math.round(base);
}
