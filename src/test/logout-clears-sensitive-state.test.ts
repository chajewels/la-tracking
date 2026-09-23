import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAccountDraft } from '@/hooks/use-account-draft';
import { clearAllPaymentDrafts } from '@/hooks/use-payment-draft';

/**
 * F02 / #295 — what a sign-out has to take with it.
 *
 * App.tsx builds the QueryClient at module scope, so it survives sign-out, and
 * nothing in src/ ever emptied it. Drafts live in sessionStorage and are not
 * auth state, so nothing removed those either. On a shared device the next
 * person to sign in inherited both.
 *
 * This exercises the same teardown AuthContext runs on SIGNED_OUT — cancel
 * in-flight queries, clear the cache, drop both draft families — against a
 * real QueryClient and real storage, and pins the other half of the contract:
 * unrelated preferences must survive.
 */

const ACCOUNT_DRAFT_KEY = 'cha-jewels-new-account-draft';

/** Mirrors AuthContext's clearSensitiveState. */
async function clearSensitiveState(queryClient: QueryClient) {
  try {
    await queryClient.cancelQueries();
  } catch {
    /* never block sign-out */
  }
  queryClient.clear();
  clearAccountDraft();
  clearAllPaymentDrafts();
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('sign-out clears sensitive state', () => {
  it('empties the query cache, so the next user cannot read the last one’s rows', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['customers'], [{ id: 'c1', full_name: 'Private Person' }]);
    qc.setQueryData(['accounts', 'acct-1'], { remaining_balance: 12345 });
    expect(qc.getQueryCache().getAll()).toHaveLength(2);

    await clearSensitiveState(qc);

    expect(qc.getQueryCache().getAll()).toHaveLength(0);
    expect(qc.getQueryData(['customers'])).toBeUndefined();
    expect(qc.getQueryData(['accounts', 'acct-1'])).toBeUndefined();
  });

  it('cancels in-flight queries, so a late response cannot repopulate the cache', async () => {
    const qc = new QueryClient();
    const cancelSpy = vi.spyOn(qc, 'cancelQueries');

    // A query that has not settled when sign-out happens. Without the cancel,
    // its resolution writes the previous user's rows back in AFTER clear().
    let release!: (v: unknown) => void;
    const pending = new Promise((r) => { release = r; });
    void qc.fetchQuery({
      queryKey: ['slow-report'],
      queryFn: () => pending,
      retry: false,
    }).catch(() => { /* cancelled */ });

    await clearSensitiveState(qc);
    expect(cancelSpy).toHaveBeenCalled();

    release([{ secret: 'row' }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(qc.getQueryData(['slow-report'])).toBeUndefined();
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });

  it('removes the account draft and EVERY payment draft', async () => {
    sessionStorage.setItem(ACCOUNT_DRAFT_KEY, JSON.stringify({ customerId: 'c1', savedAt: Date.now() }));
    sessionStorage.setItem('payment_draft_acct-1', JSON.stringify({ amount: '5000', savedAt: Date.now() }));
    sessionStorage.setItem('payment_draft_acct-2', JSON.stringify({ amount: '250.75', savedAt: Date.now() }));
    sessionStorage.setItem('payment_draft_acct-3', JSON.stringify({ amount: '1', savedAt: Date.now() }));

    await clearSensitiveState(new QueryClient());

    expect(sessionStorage.getItem(ACCOUNT_DRAFT_KEY)).toBeNull();
    expect(sessionStorage.getItem('payment_draft_acct-1')).toBeNull();
    expect(sessionStorage.getItem('payment_draft_acct-2')).toBeNull();
    expect(sessionStorage.getItem('payment_draft_acct-3')).toBeNull();
  });

  it('clears every payment draft even though removal re-indexes sessionStorage', () => {
    // Iterating forwards with sessionStorage.key(i) while removing skips
    // entries, which would leave drafts behind. Ten keys makes that visible.
    for (let i = 0; i < 10; i++) {
      sessionStorage.setItem(`payment_draft_acct-${i}`, JSON.stringify({ amount: `${i}`, savedAt: Date.now() }));
    }
    expect(sessionStorage.length).toBe(10);

    clearAllPaymentDrafts();

    expect(sessionStorage.length).toBe(0);
  });

  it('leaves unrelated preferences alone', async () => {
    const keep: Record<string, string> = {
      'cha-jewels-density': 'compact',
      'notification-sound-enabled': 'true',
      'cha-jewels-fx-rate': '0.42',
      'announcement-dismissed-2026-09': '1',
      'loyalty-tier-cache': 'Crown VIP',
    };
    Object.entries(keep).forEach(([k, v]) => localStorage.setItem(k, v));
    sessionStorage.setItem(ACCOUNT_DRAFT_KEY, 'x');
    sessionStorage.setItem('payment_draft_acct-1', 'y');
    // A non-draft sessionStorage key must also survive.
    sessionStorage.setItem('sidebar-scroll-position', '240');

    await clearSensitiveState(new QueryClient());

    Object.entries(keep).forEach(([k, v]) => expect(localStorage.getItem(k)).toBe(v));
    expect(localStorage.length).toBe(Object.keys(keep).length);
    expect(sessionStorage.getItem('sidebar-scroll-position')).toBe('240');
    expect(sessionStorage.getItem(ACCOUNT_DRAFT_KEY)).toBeNull();
    expect(sessionStorage.getItem('payment_draft_acct-1')).toBeNull();
  });

  it('does not throw when there is nothing to clear', async () => {
    await expect(clearSensitiveState(new QueryClient())).resolves.toBeUndefined();
  });
});
