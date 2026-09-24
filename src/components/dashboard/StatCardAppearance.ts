import { createContext } from 'react';

/**
 * Hub visual refresh (Phase 1): an OPT-IN "ledger" appearance. A page wraps
 * its cards in <StatCardAppearance.Provider value="ledger"> to get large
 * Deco-serif numerals, a gold top edge, a delta chip and a pointer spotlight
 * (fine pointers only). Without the provider every card renders the
 * original markup unchanged (locked by statcard-legacy-markup.test.tsx), so
 * Finance, Payment Vault and Loyalty are unaffected. Same props, same
 * values, same count-up — presentation only.
 */
export const StatCardAppearance = createContext<'default' | 'ledger'>('default');
