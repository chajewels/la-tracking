import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * Component-level assertions of the post-login splash gating in Login.tsx
 * (the sandbox cannot hydrate a real Supabase session, so the guard is
 * asserted here rather than E2E — approved contingency).
 *
 * Invariants under test:
 *  1. SESSION RESTORE (session present, no fresh sign-in): /login redirects
 *     to the dashboard and the splash NEVER mounts.
 *  2. FRESH SIGN-IN (no ?next): the splash mounts, and when the session
 *     subsequently lands (the async SIGNED_IN auth event), the
 *     session-redirect effect does NOT bypass the splash mid-display.
 *  3. FAILED SIGN-IN: no splash, no redirect, guard reset.
 *  4. OAUTH CONSENT (?next set): successful sign-in navigates to the
 *     validated next path and the splash NEVER mounts.
 */

const authState: { session: { access_token: string } | null } = { session: null };
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ session: authState.session, loading: false, profile: null, roles: [] }),
}));
vi.mock('@/components/seo/PageMeta', () => ({ default: () => null }));

const signInWithPassword = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { signInWithPassword: (...args: unknown[]) => signInWithPassword(...args) } },
}));

import Login from '@/pages/Login';

const SPLASH_NAME = /welcome to cha jewels hub/i;
const CONSENT_PATH = '/.lovable/oauth/consent';

function loginTree(initialPath = '/login') {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<div data-testid="dashboard-route" />} />
        <Route path={CONSENT_PATH} element={<div data-testid="consent-route" />} />
      </Routes>
    </MemoryRouter>
  );
}

async function signIn() {
  fireEvent.change(screen.getByPlaceholderText('you@chajewels.com'), { target: { value: 'staff@chajewels.com' } });
  fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
}

beforeEach(() => {
  sessionStorage.setItem('admin_splash_shown', 'true'); // skip pre-login splash
  authState.session = null;
  signInWithPassword.mockReset();
});

describe('post-login splash gating (freshLoginRef + nextPath)', () => {
  it('session restore: redirects to dashboard and splash never mounts', async () => {
    authState.session = { access_token: 'restored' };
    render(loginTree());
    await waitFor(() => expect(screen.getByTestId('dashboard-route')).toBeInTheDocument());
    expect(screen.queryByRole('dialog', { name: SPLASH_NAME })).toBeNull();
  });

  it('fresh sign-in: splash mounts and the session effect does not bypass it', async () => {
    signInWithPassword.mockResolvedValue({ error: null });
    const view = render(loginTree());
    await signIn();
    await waitFor(() => expect(screen.getByRole('dialog', { name: SPLASH_NAME })).toBeInTheDocument());

    // The SIGNED_IN auth event lands after success — session flips non-null
    // and the session-redirect effect re-runs. The guard must keep the
    // user on the splash.
    authState.session = { access_token: 'fresh' };
    view.rerender(loginTree());

    expect(screen.getByRole('dialog', { name: SPLASH_NAME })).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-route')).toBeNull();
  });

  it('failed sign-in: no splash, no redirect, guard reset', async () => {
    signInWithPassword.mockResolvedValue({ error: { message: 'Invalid login credentials' } });
    render(loginTree());
    await signIn();
    await waitFor(() => expect(signInWithPassword).toHaveBeenCalled());
    expect(screen.queryByRole('dialog', { name: SPLASH_NAME })).toBeNull();
    expect(screen.queryByTestId('dashboard-route')).toBeNull();
  });

  it('OAuth consent (?next): navigates to next path, splash never mounts', async () => {
    signInWithPassword.mockResolvedValue({ error: null });
    render(loginTree(`/login?next=${CONSENT_PATH}`));
    await signIn();
    await waitFor(() => expect(screen.getByTestId('consent-route')).toBeInTheDocument());
    expect(screen.queryByRole('dialog', { name: SPLASH_NAME })).toBeNull();
    expect(screen.queryByTestId('dashboard-route')).toBeNull();
  });
});
