import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const state = vi.hoisted(() => ({
  order: { page365_no: 19848, source_channel: 'page365' } as Record<string, unknown> | null,
  status: null as Record<string, unknown> | null,
  invoke: vi.fn(),
  canAll: true,
}));

vi.mock('@/integrations/supabase/client', () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: state.order, error: null }),
  };
  return {
    supabase: {
      from: () => chain,
      rpc: async () => ({ data: state.status, error: null }),
      functions: { invoke: (...args: unknown[]) => state.invoke(...args) },
    },
  };
});
vi.mock('@/contexts/PermissionsContext', () => ({ usePermissions: () => ({ can: () => state.canAll }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

import Page365SyncPanel from '@/components/page365/Page365SyncPanel';
import { toast } from 'sonner';

function renderPanel(kind: 'layaway' | 'cash' = 'layaway') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Page365SyncPanel kind={kind} orderId="order-1" />
    </QueryClientProvider>,
  );
}

describe('Page365SyncPanel', () => {
  beforeEach(() => {
    state.order = { page365_no: 19848, source_channel: 'page365' };
    state.status = null;
    state.invoke.mockReset();
    state.canAll = true;
  });

  it('renders nothing for a website order', async () => {
    state.order = { page365_no: 19848, source_channel: 'web' };
    state.status = { has_link: true, page365_no: 19848 };
    const { container } = renderPanel();
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when the order was not imported from Page365', async () => {
    state.order = { page365_no: null, source_channel: null };
    const { container } = renderPanel();
    await new Promise((r) => setTimeout(r, 20));
    expect(container.innerHTML).toBe('');
  });

  it('shows the last read and re-reads on press', async () => {
    state.status = { has_link: true, page365_no: 19848, last_stage: 'unpaid', last_checked_at: '2026-10-21T01:00:00Z' };
    state.invoke.mockResolvedValue({ data: { ok: true, action: 'cancelled', stage: 'voided' }, error: null });
    renderPanel();
    expect(await screen.findByText('Page365 invoice 19848')).toBeTruthy();
    expect(screen.getByTestId('page365-stage').textContent).toBe('Unpaid');
    expect(screen.queryByTestId('page365-add-link')).toBeNull();
    fireEvent.click(screen.getByTestId('page365-reread'));
    await waitFor(() => expect(state.invoke).toHaveBeenCalledWith('page365-invoice-check', {
      body: { action: 'check', kind: 'layaway', order_id: 'order-1' },
    }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Voided in Page365 — the Hub cancelled this order.'));
  });

  it('offers Add Page365 link when none is saved, and sends it', async () => {
    state.status = { has_link: false, page365_no: 19848 };
    state.invoke.mockResolvedValue({ data: { ok: true, page365_no: 19848, stage: 'unpaid' }, error: null });
    renderPanel('cash');
    fireEvent.click(await screen.findByTestId('page365-add-link'));
    fireEvent.change(screen.getByLabelText('Page365 invoice link'), { target: { value: ' https://chajewelsjapan.com/invoices/abc?sig=x1 ' } });
    fireEvent.click(screen.getByText('Save link'));
    await waitFor(() => expect(state.invoke).toHaveBeenCalledWith('page365-invoice-check', {
      body: { action: 'add_link', kind: 'cash', order_id: 'order-1', url: 'https://chajewelsjapan.com/invoices/abc?sig=x1' },
    }));
  });

  it('hides the buttons from staff without the cancel permission', async () => {
    state.canAll = false;
    state.status = { has_link: true, page365_no: 19848, last_stage: 'unpaid' };
    renderPanel();
    expect(await screen.findByText('Page365 invoice 19848')).toBeTruthy();
    expect(screen.queryByTestId('page365-reread')).toBeNull();
  });
});
