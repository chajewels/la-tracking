// Canonical payment-method registry.
// Replaces the 4+ independent hardcoded option lists across the app.
// See docs/SYSTEM-STATUS.md "Payment method registry (shipped …)" for
// rationale, and CLAUDE.md routing rules for how to extend this.

export type MethodCurrency = 'PHP' | 'JPY' | 'any';

export interface PaymentMethodSpec {
  value: string;
  label: string;
  currency: MethodCurrency;
}

export const PAYMENT_METHODS: PaymentMethodSpec[] = [
  // PHP group
  { value: 'bdo',         label: 'BDO',          currency: 'PHP' },
  { value: 'bpi',         label: 'BPI',          currency: 'PHP' },
  { value: 'metrobank',   label: 'Metrobank',    currency: 'PHP' },
  { value: 'gcash',       label: 'GCash',        currency: 'PHP' },
  { value: 'cash_pickup', label: 'Cash Pick Up', currency: 'PHP' },

  // JPY group
  { value: 'cash',             label: 'Cash Payment',     currency: 'JPY' },
  { value: 'cod',              label: 'Cash on Delivery', currency: 'JPY' },
  { value: 'rakuten',          label: 'Rakuten',          currency: 'JPY' },
  { value: 'sumitomo',         label: 'Sumitomo',         currency: 'JPY' },
  { value: 'paypay',           label: 'PayPay',           currency: 'JPY' },
  { value: 'jp_bank',          label: 'JP Bank',          currency: 'JPY' },
  { value: 'credit_card',      label: 'Credit Card',      currency: 'JPY' },
  { value: 'genkin_kaketome',  label: 'Genkin Kaketome',  currency: 'JPY' },

  // Neutral
  { value: 'bank_transfer', label: 'Bank Transfer', currency: 'any' },
  { value: 'other',         label: 'Other',         currency: 'any' },
];

// Legacy / alternate spellings → canonical value. Keys are lowercased.
export const METHOD_ALIASES: Record<string, string> = {
  bdo: 'bdo',
  bpi: 'bpi',
  metrobank: 'metrobank',
  gcash: 'gcash',
  cash_pickup: 'cash_pickup',
  'cash pickup': 'cash_pickup',
  'cash pick up': 'cash_pickup',
  'cash-pickup': 'cash_pickup',
  rakuten: 'rakuten',
  'rakuten bank': 'rakuten',
  sumitomo: 'sumitomo',
  'sumitomo bank': 'sumitomo',
  paypay: 'paypay',
  jp_bank: 'jp_bank',
  credit_card: 'credit_card',
  cash: 'cash',
  'cash payment': 'cash',
  'cash-payment': 'cash',
  'cash on delivery': 'cod',
  'cash-on-delivery': 'cod',
  cod: 'cod',
  genkin_kaketome: 'genkin_kaketome',
  bank_transfer: 'bank_transfer',
  other: 'other',
};

const VALUE_INDEX: Record<string, PaymentMethodSpec> = PAYMENT_METHODS.reduce(
  (acc, m) => {
    acc[m.value] = m;
    return acc;
  },
  {} as Record<string, PaymentMethodSpec>,
);

export function normalizeMethod(raw: string): string {
  if (raw == null) return raw as unknown as string;
  const key = String(raw).trim().toLowerCase();
  return METHOD_ALIASES[key] ?? raw;
}

export function methodCurrency(value: string): MethodCurrency {
  const canon = normalizeMethod(value);
  return VALUE_INDEX[canon]?.currency ?? 'any';
}

export function methodMismatch(method: string, accountCurrency: 'PHP' | 'JPY'): boolean {
  const c = methodCurrency(method);
  return (c === 'PHP' || c === 'JPY') && c !== accountCurrency;
}

export function methodLabel(value: string): string {
  const canon = normalizeMethod(value);
  return VALUE_INDEX[canon]?.label ?? String(value ?? '');
}
