import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));

import { checkResultMessage, readErrorLabel, stageLabel } from '@/lib/page365-invoice-link';

describe('Page365 void sync — staff wording', () => {
  it('labels the stages Page365 reports', () => {
    expect(stageLabel('voided')).toBe('Voided (cancelled in Page365)');
    expect(stageLabel('unpaid')).toBe('Unpaid');
    expect(stageLabel(null)).toBe('Not read yet');
    expect(stageLabel('partially_paid')).toBe('Partially paid');
  });

  it('never shows a raw read error', () => {
    expect(readErrorLabel(null)).toBeNull();
    expect(readErrorLabel('http_401')).toMatch(/refused the saved link/);
    expect(readErrorLabel('http_404')).toMatch(/could not find/);
    expect(readErrorLabel('invoice_mismatch: link opened invoice 5')).toMatch(/different invoice/);
    expect(readErrorLabel('unreachable: TimeoutError')).toMatch(/could not be reached/);
    expect(readErrorLabel('apply: boom')).toMatch(/could not update the order/);
    expect(readErrorLabel('something else')).toBe('The last check failed.');
  });

  it('says what the Hub did after a re-read', () => {
    expect(checkResultMessage({ action: 'cancelled' })).toEqual({
      tone: 'success', text: 'Voided in Page365 — the Hub cancelled this order.',
    });
    expect(checkResultMessage({ action: 'restored', restored_status: 'extension_active' }).text)
      .toBe('Renewed in Page365 — the Hub restored this order (back to extension active).');
    expect(checkResultMessage({ action: 'submission_pending' }).tone).toBe('warning');
    expect(checkResultMessage({ action: 'needs_staff', why: 'cash_money_received' }).text).toMatch(/Use Cancel Order/);
    expect(checkResultMessage({ action: 'needs_staff', why: 'store_credit_issued' }).text).toMatch(/store credit/);
    expect(checkResultMessage({ action: 'no_action', why: 'already_closed', stage: 'voided' }).text)
      .toMatch(/already closed/);
    expect(checkResultMessage({ action: 'read_failed', error: 'http_401' }).tone).toBe('error');
    expect(checkResultMessage({}).tone).toBe('error');
  });
});
