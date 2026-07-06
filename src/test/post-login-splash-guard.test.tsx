import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * Component-level assertion of the post-login splash gating in Login.tsx.
 * (The sandbox E2E session-restore check is inconclusive — a fake sb-*
 * token doesn't hydrate a session without network — so per the approved
 * contingency the freshLoginRef guard is asserted here instead.)
 *
 * Invariants under test:
 *  1. SESSION RESTORE (session present, no fresh sign-in): /login redirects
 *     to the dashboard and the splash NEVER mounts.
 *  2. FRESH SIGN-IN: the splash mounts, and when the session subsequently
 *     lands (the async SIGNED_IN auth event), the session-redirect effect
 *     does NOT bypass the splash mid-display.
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

function loginTree() {
  return (
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<div data-testid="dashboard-route" />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  sessionStorage.setItem('admin_splash_shown', 'true'); // skip pre-login splash
  authState.session = null;
  signInWithPassword.mockReset();
});

describe('post-login splash gating (freshLoginRef)', () => {
  it('session restore: redirects to dashboard and splash never mounts', async () => {
    authState.session = { access_token: 'restored' };
    render(loginTree());
    await waitFor(() => expect(screen.getByTestId('dashboard-route')).toBeInTheDocument());
    expect(screen.queryByRole('dialog', { name: SPLASH_NAME })).toBeNull();
  });

  it('fresh sign-in: splash mounts and the session effect does not bypass it', async () => {
    signInWithPassword.mockResolvedValue({ error: null });
    const view = render(loginTree());

    fireEvent.change(screen.getByPlaceholderText('you@chajewels.com'), { target: { value: 'staff@chajewels.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.getByRole('dialog', { name: SPLASH_NAME })).toBeInTheDocument());

    // The SIGNED_IN auth event lands after success — session flips non-null
    // and the session-redirect effect re-runs. freshLoginRef must keep the
    // user on the splash.
    authState.session = { access_token: 'fresh' };
    view.rerender(loginTree());

    expect(screen.getByRole('dialog', { name: SPLASH_NAME })).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-route')).toBeNull();
  });

  it('failed sign-in: no splash, no redirect, guard reset', async () => {
    signInWithPassword.mockResolvedValue({ error: { message: 'Invalid login credentials' } });
    render(loginTree());

    fireEvent.change(screen.getByPlaceholderText('you@chajewels.com'), { target: { value: 'staff@chajewels.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(signInWithPassword).toHaveBeenCalled());
    expect(screen.queryByRole('dialog', { name: SPLASH_NAME })).toBeNull();
    expect(screen.queryByTestId('dashboard-route')).toBeNull();
  });
});
