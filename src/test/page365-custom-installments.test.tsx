/**
 * Page365 review → layaway with CUSTOM installments (owner request 2026-09-26):
 * the same Equal / Custom choice NewAccount offers. Drives the real page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';

const invoke = vi.fn();

vi.mock('@/integrations/supabase/client', () => {
  // Every table read resolves to an empty list; the test seeds the cache instead.
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const m of ['select', 'eq', 'order', 'range', 'in', 'or', 'limit', 'ilike', 'neq', 'is']) chain[m] = self;
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  chain.single = () => Promise.resolve({ data: null, error: null });
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
  return {
    supabase: {
      from: () => chain,
      rpc: () => Promise.resolve({ data: null, error: null }),
      functions: { invoke: (...args: unknown[]) => invoke(...args) },
      auth: { getUser: () => Promise.resolve({ data: { user: null } }) },
    },
  };
});
vi.mock('@/components/layout/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/PermissionsContext', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));

import Page365Review from '@/pages/Page365Review';

const at = '2026-09-26T03:00:00Z';
const draftRow = {
  id: 'd1', page365_no: 900001, page365_slug: 'fixture', expires_at: '2099-01-01T00:00:00Z', consumed_at: null,
  payload: {
    page365_no: 900001, page365_slug: 'fixture', currency: 'JPY',
    customer: { name: 'Test Customer', phone: '555-247-9913', address: null, structural_address: null },
    items: [{
      name: 'ZT9001 Test ring K18', kind: 'product', quantity: 1, unit_price_jpy: 63000, line_total_jpy: 63000,
      sku: null, note: null, photo_url: null, source_photo_url: null, photo_note: null, stock_match: null,
    }],
    shipping_jpy: 0, subtotal_jpy: 63000, discount_jpy: 0, total_jpy: 63000,
    fx: { php_jpy_rate: 0.39, source: 'system_settings.php_jpy_rate', read_at: at },
    page365_stage: 'pending', page365_created_at: at, page365_expires_on: null, fetched_at: at, photo_failures: [],
  },
};
const customerRow = {
  id: 'c1', full_name: 'Real Name', facebook_name: 'Test Customer', mobile_number: '5552479913',
  email: null, messenger_link: null, location: null, customer_code: 'CJ-2026-00008',
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(['page365-draft', 'd1'], draftRow);
  qc.setQueryData(['page365-customer-directory'], [customerRow]);
  qc.setQueryData(['plan-configurations'], []);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/page365/review/d1']}>
        <Routes>
          <Route path="/page365/review/:draftId" element={<Page365Review />} />
          <Route path="*" element={<div>navigated</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function toLayawayWithDeposit(dp: string) {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Layaway plan' }));
  fireEvent.change(screen.getByLabelText(/Downpayment/), { target: { value: dp } });
  // Suggested on Facebook name + phone (the 19794 fix) — pick her.
  fireEvent.click(await screen.findByRole('button', { name: 'Use this' }));
}

const amountBox = (n: number) => screen.getByLabelText(`Installment ${n} amount`) as HTMLInputElement;
const createButton = () => screen.getByRole('button', { name: 'Create layaway plan' });

describe('Page365 review — custom installments', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ data: { account: { id: 'acc-1' }, page365_stock: null }, error: null });
  });

  it('Equal (default) sends no custom_installments', async () => {
    await toLayawayWithDeposit('13000');
    expect(screen.queryByLabelText('Installment 1 amount')).toBeNull();
    fireEvent.click(createButton());
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    const [fn, { body }] = invoke.mock.calls[0];
    expect(fn).toBe('create-layaway-account');
    expect(body.downpayment_amount).toBe(13000);
    expect(body).not.toHaveProperty('custom_installments');
  });

  it('Custom pre-fills the equal split, blocks a mismatch, auto-adjusts and sends the amounts', async () => {
    await toLayawayWithDeposit('13000');
    fireEvent.click(screen.getByRole('button', { name: 'Custom installments' }));

    // 63,000 − 13,000 = 50,000 over 3 months, remainder on the last (the server's split).
    await waitFor(() => expect(amountBox(1).value).toBe('16666'));
    expect(amountBox(2).value).toBe('16666');
    expect(amountBox(3).value).toBe('16668');

    fireEvent.change(amountBox(1), { target: { value: '20000' } });
    expect(await screen.findByText(/Mismatch of/)).toBeTruthy();
    expect(createButton()).toHaveProperty('disabled', true);
    expect(screen.getByText(/custom installments that add up to the remaining balance/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Auto-adjust last month/ }));
    expect(amountBox(3).value).toBe('13334');
    expect(screen.queryByText(/Mismatch of/)).toBeNull();

    fireEvent.click(createButton());
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    const [fn, { body }] = invoke.mock.calls[0];
    expect(fn).toBe('create-layaway-account');
    expect(body.payment_plan_months).toBe(3);
    expect(body.custom_installments).toEqual([20000, 16666, 13334]);
  });

  it('a zero month blocks the import', async () => {
    await toLayawayWithDeposit('13000');
    fireEvent.click(screen.getByRole('button', { name: 'Custom installments' }));
    await waitFor(() => expect(amountBox(1).value).toBe('16666'));
    fireEvent.change(amountBox(2), { target: { value: '0' } });
    fireEvent.change(amountBox(3), { target: { value: '33334' } });
    expect(screen.queryByText(/Mismatch of/)).toBeNull();
    expect(createButton()).toHaveProperty('disabled', true);
    expect(screen.getByText(/an installment amount above zero for every month/)).toBeTruthy();
  });

  it('changing the plan refills the boxes with the new equal split', async () => {
    await toLayawayWithDeposit('13000');
    fireEvent.click(screen.getByRole('button', { name: 'Custom installments' }));
    await waitFor(() => expect(amountBox(1).value).toBe('16666'));
    fireEvent.change(amountBox(1), { target: { value: '20000' } });

    const planGroup = screen.getByText('Plan').parentElement as HTMLElement;
    fireEvent.click(within(planGroup).getByRole('button', { name: /^6M/ }));
    // 50,000 / 6 = 8,333 × 5, last 8,335.
    await waitFor(() => expect(amountBox(6).value).toBe('8335'));
    expect(amountBox(1).value).toBe('8333');
  });
});
