import { useState, useEffect, useCallback, useRef } from 'react';

interface PaymentDraft {
  amount: string;
  paymentDate: string;
  paymentMethod: string;
  notes: string;
  savedAt: number;
}

const DRAFT_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getDraftKey(accountId: string) {
  return `payment_draft_${accountId}`;
}

export function usePaymentDraft(accountId: string) {
  const [restoredDraft, setRestoredDraft] = useState(false);
  const draftKey = getDraftKey(accountId);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const loadDraft = useCallback((): PaymentDraft | null => {
    try {
      const raw = sessionStorage.getItem(draftKey);
      if (!raw) return null;
      const draft: PaymentDraft = JSON.parse(raw);
      if (Date.now() - draft.savedAt > DRAFT_TTL_MS) {
        sessionStorage.removeItem(draftKey);
        return null;
      }
      return draft;
    } catch {
      return null;
    }
  }, [draftKey]);

  const saveDraft = useCallback(
    (data: Omit<PaymentDraft, 'savedAt'>) => {
      // Debounce saves to avoid excessive writes
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        try {
          sessionStorage.setItem(draftKey, JSON.stringify({ ...data, savedAt: Date.now() }));
        } catch { /* quota exceeded — ignore */ }
      }, 300);
    },
    [draftKey],
  );

  const clearDraft = useCallback(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    sessionStorage.removeItem(draftKey);
    setRestoredDraft(false);
  }, [draftKey]);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  return { loadDraft, saveDraft, clearDraft, restoredDraft, setRestoredDraft };
}
