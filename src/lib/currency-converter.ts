import { Currency } from './types';

/**
 * Currency conversion configuration.
 * PHP → JPY conversion: JPY = PHP ÷ rate
 * Default rate: 0.42
 * 
 * IMPORTANT: Conversion happens ONLY at the display layer.
 * Database values remain in their original currency.
 */

// Store rate in localStorage so admins can modify it
const RATE_KEY = 'cha_jewels_php_jpy_rate';
const DEFAULT_RATE = 0.42;

export function getConversionRate(): number {
  try {
    const stored = localStorage.getItem(RATE_KEY);
    if (stored) {
      const rate = parseFloat(stored);
      if (!isNaN(rate) && rate > 0) return rate;
    }
  } catch {}
  return DEFAULT_RATE;
}

export function setConversionRate(rate: number): void {
  localStorage.setItem(RATE_KEY, rate.toString());
}

/**
 * Convert PHP amount to JPY equivalent.
 * Formula: JPY = PHP ÷ rate
 * Result rounded to whole yen.
 */
export function phpToJpy(phpAmount: number): number {
  const rate = getConversionRate();
  return Math.round(phpAmount / rate);
}

/**
 * Convert any amount to JPY for consolidated view.
 * JPY amounts pass through unchanged.
 * PHP amounts are converted using the configured rate.
 */
export function toJpy(amount: number, currency: Currency): number {
  if (currency === 'JPY') return amount;
  return phpToJpy(amount);
}

/**
 * Get the display currency for a given filter mode.
 * ALL mode always displays in JPY (consolidated).
 * Single currency modes display in their native currency.
 */
export function getDisplayCurrencyForFilter(filter: 'ALL' | Currency): Currency {
  return filter === 'ALL' ? 'JPY' : filter;
}

/**
 * Convert a stat total that may include mixed currencies.
 * When in ALL mode, converts PHP→JPY and sums everything as JPY.
 */
export function convertForAllMode(phpTotal: number, jpyTotal: number): number {
  return Math.round(phpToJpy(phpTotal) + jpyTotal);
}
