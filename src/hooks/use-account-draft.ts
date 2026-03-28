import { useState, useEffect, useCallback, useRef } from 'react';

const DRAFT_KEY = 'cha-jewels-new-account-draft';
const DRAFT_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface AccountDraft {
  invoiceNumber: string;
  customerId: string;
  currency: 'PHP' | 'JPY';
  totalAmount: string;
  orderDate: string;
  paymentPlan: 3 | 6;
  downpaymentInput: string;
  installmentMode: 'equal' | 'custom';
  customAmounts: string[];
  enableSplitPayment: boolean;
  lumpSumInput: string;
  savedAt: number;
}

function loadDraft(): AccountDraft | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const draft: AccountDraft = JSON.parse(raw);
    if (Date.now() - draft.savedAt > DRAFT_TTL_MS) {
      sessionStorage.removeItem(DRAFT_KEY);
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

function saveDraft(draft: Omit<AccountDraft, 'savedAt'>) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, savedAt: Date.now() }));
  } catch {
    // Storage full or unavailable
  }
}

export function clearAccountDraft() {
  sessionStorage.removeItem(DRAFT_KEY);
}

export function useAccountDraft() {
  const [restored, setRestored] = useState(false);
  const initialDraft = useRef(loadDraft());

  const getDraft = useCallback(() => initialDraft.current, []);

  const persistDraft = useCallback((fields: Omit<AccountDraft, 'savedAt'>) => {
    saveDraft(fields);
  }, []);

  const markRestored = useCallback(() => {
    setRestored(true);
    setTimeout(() => setRestored(false), 3000);
  }, []);

  return {
    initialDraft: initialDraft.current,
    getDraft,
    persistDraft,
    clearDraft: clearAccountDraft,
    restored,
    markRestored,
  };
}
