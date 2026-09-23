import { useState, useEffect, useCallback, useRef } from 'react';

interface PaymentDraft {
  amount: string;
  paymentDate: string;
  paymentMethod: string;
  notes: string;
  savedAt: number;
}

const DRAFT_TTL_MS = 30 * 60 * 1000; // 30 minutes

const DRAFT_KEY_PREFIX = 'payment_draft_';

function getDraftKey(accountId: string) {
  return `${DRAFT_KEY_PREFIX}${accountId}`;
}

/**
 * Remove EVERY payment draft, for every account (F02, #295).
 *
 * Drafts are per-account (`payment_draft_<accountId>`), so there is no single
 * key to delete — on sign-out the whole family has to go, or the next person
 * on the device opens an account and finds the previous user's half-typed
 * amount, method and notes restored for them.
 *
 * Exported so AuthContext can call it without knowing the key shape; the
 * storage layout stays this hook's business. Keys are collected before
 * removing, because sessionStorage re-indexes on delete and iterating
 * forwards while mutating skips entries.
 */
export function clearAllPaymentDrafts() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(DRAFT_KEY_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => sessionStorage.removeItem(k));
  } catch {
    // Storage unavailable (private mode, blocked site data) — nothing to clear.
  }
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
