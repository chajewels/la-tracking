import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// message_lines: three rows in one pool; audit_logs insert resolves.
const rows = [
  { id: 'a', message_type: 'payment_received', part: 'opening', body: 'Thank you for your payment.', active: true, sort: 1, updated_at: '' },
  { id: 'b', message_type: 'payment_received', part: 'opening', body: 'Maraming salamat po sa bayad mo.', active: true, sort: 2, updated_at: '' },
  { id: 'c', message_type: 'payment_received', part: 'opening', body: 'Old line.', active: false, sort: 3, updated_at: '' },
];
const updates: unknown[] = [];
const inserts: unknown[] = [];
vi.mock('@/integrations/supabase/client', () => {
  const table = (name: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ['select', 'order', 'eq']) chain[m] = self;
    chain.update = (v: unknown) => { updates.push({ table: name, v }); return chain; };
    chain.insert = (v: unknown) => { inserts.push({ table: name, v }); return chain; };
    chain.single = () => Promise.resolve({ data: { id: 'new' }, error: null });
    chain.then = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: name === 'message_lines' ? rows : [], error: null }).then(res);
    return chain;
  };
  return { supabase: { from: table } };
});
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'admin-1' } }) }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

import MessageLinesTab from '@/components/settings/MessageLinesTab';

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MessageLinesTab /></QueryClientProvider>);
}

describe('MessageLinesTab', () => {
  it('lists every pool, locks line 1 and shows the active count', async () => {
    mount();
    await screen.findByText('Maraming salamat po sa bayad mo.');
    expect(screen.getAllByText('Locked').length).toBe(1);
    const pool = document.querySelector('[data-pool="payment_received:opening"]')!;
    expect(pool.textContent).toContain('2 active');
    // every editor pool is rendered, even empty ones
    expect(document.querySelectorAll('[data-pool]').length).toBe(38);
    expect(screen.getAllByText('No lines yet — the built-in wording is used.').length).toBe(37);
  });

  it('refuses a bad line with the reason and saves a good one with an audit row', async () => {
    mount();
    await screen.findByText('Maraming salamat po sa bayad mo.');
    const pool = document.querySelector('[data-pool="reminder_upcoming:opening"]')!;
    fireEvent.click(pool.querySelector('button')!); // Add line
    const box = await screen.findByLabelText('Line');
    fireEvent.change(box, { target: { value: 'Hi {name}, INV #{invoice}' } });
    expect(screen.getByRole('alert').textContent).toMatch(/\{due_date\} is required/);
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'Hi {name}, INV #{invoice} is due {due_date}.' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Maria Santos, INV #19500 is due Oct 05, 2026/)).toBeTruthy();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(inserts.length).toBe(2));
    expect(inserts[0]).toMatchObject({ table: 'message_lines', v: { message_type: 'reminder_upcoming', part: 'opening', active: true, sort: 1 } });
    expect(inserts[1]).toMatchObject({ table: 'audit_logs' });
  });

  it('switching a line off writes the row and an audit row', async () => {
    mount();
    await screen.findByText('Maraming salamat po sa bayad mo.');
    fireEvent.click(screen.getAllByLabelText('Switch line off')[0]);
    await waitFor(() => expect(updates.some((u) => (u as { v: { active: boolean } }).v.active === false)).toBe(true));
    await waitFor(() => expect(inserts.some((i) => (i as { table: string }).table === 'audit_logs')).toBe(true));
  });
});
