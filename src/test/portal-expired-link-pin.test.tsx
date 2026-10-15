import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Expired portal link on the PIN screen (Lovable issue, fixed 2026-10-15).
 * Renders the real CustomerPortal with a link token, enters a PIN, and checks
 * what verify-portal-pin's answer leads to: a dead link must reach the
 * link-expired screen (with Sign in), a wrong PIN must stay on the PIN screen.
 */
vi.mock('@/integrations/supabase/client', () => {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const k of ['select', 'eq', 'order', 'limit', 'gte', 'lte', 'in', 'is', 'neq', 'or']) chain[k] = self;
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.single = async () => ({ data: null, error: null });
  chain.then = (r: (v: unknown) => unknown) => r({ data: [], error: null });
  return {
    supabase: {
      auth: {
        getSession: async () => ({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
      from: () => chain,
      rpc: async () => ({ data: null, error: null }),
      functions: { invoke: async () => ({ data: null, error: null }) },
    },
  };
});

const { default: CustomerPortal } = await import('@/pages/CustomerPortal');
const { pt } = await import('@/i18n/portal');

function mockPinAnswer(status: number, body: Record<string, unknown>) {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes('verify-portal-pin')) {
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

async function enterPin() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/portal?token=deadbeefdeadbeefdeadbeefdeadbeef']}>
        <CustomerPortal />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const input = await screen.findByRole('textbox', {}, { timeout: 8000 }).catch(() => null)
    ?? (await waitFor(() => {
      const el = document.querySelector('input');
      if (!el) throw new Error('no PIN input yet');
      return el;
    }, { timeout: 8000 }));
  fireEvent.change(input as HTMLInputElement, { target: { value: '1234' } });
  fireEvent.click(screen.getByRole('button', { name: pt('states.pinAccess') }));
}

describe('expired link on the PIN screen', () => {
  beforeEach(() => { sessionStorage.clear(); });

  it('a dead link leaves the PIN screen for the link-expired screen with Sign in', async () => {
    mockPinAnswer(401, { error: 'Token expired' });
    await enterPin();
    expect(await screen.findByText(pt('states.linkExpiredTitle'), {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.getByRole('button', { name: pt('states.signIn') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: pt('states.pinAccess') })).toBeNull();
  }, 20000);

  it('a revoked link shows the link-invalid screen, also with Sign in', async () => {
    mockPinAnswer(401, { error: 'Token has been revoked' });
    await enterPin();
    expect(await screen.findByText(pt('states.linkInvalidTitle'), {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.getByRole('button', { name: pt('states.signIn') })).toBeTruthy();
  }, 20000);

  it('a wrong PIN stays on the PIN screen with its message', async () => {
    mockPinAnswer(401, { error: 'Incorrect PIN. 2 attempts remaining.', attempts_remaining: 2 });
    await enterPin();
    expect(await screen.findByText('Incorrect PIN. 2 attempts remaining.', {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.getByRole('button', { name: pt('states.pinAccess') })).toBeTruthy();
    expect(screen.queryByText(pt('states.linkExpiredTitle'))).toBeNull();
  }, 20000);
});
