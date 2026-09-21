import { describe, it, expect, vi } from 'vitest';

// request-to-job is pure, but it reads its labels from service-request-types,
// which constructs the Supabase client at import. Same stub convention as
// post-login-splash-guard.test.tsx.
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => ({}) } }));

import {
  buildServiceJobPrefill,
  jobTypeForKind,
} from '@/components/services/request-to-job';
import type { ServiceRequestRow } from '@/components/services/service-request-types';

function request(over: Partial<ServiceRequestRow> = {}): ServiceRequestRow {
  return {
    id: 'req-1',
    customer_id: 'cust-1',
    cash_order_id: null,
    layaway_account_id: null,
    service_job_id: null,
    item_title: 'Eternity band',
    kind: 'resize',
    details: null,
    ring_size: null,
    status: 'requested',
    staff_note: null,
    customer_note: null,
    created_at: '2026-09-21T00:00:00Z',
    updated_at: null,
    ...over,
  };
}

describe('jobTypeForKind', () => {
  it('maps a resize to Ring Resize only when a ring size came with it', () => {
    expect(jobTypeForKind('resize', '7.5')).toBe('Ring Resize');
    // No size means nothing says the piece is a ring — Bracelet Resize is the
    // other half of that coin, so the CSR chooses.
    expect(jobTypeForKind('resize', null)).toBe('');
  });

  it('maps the remaining kinds', () => {
    expect(jobTypeForKind('cleaning', null)).toBe('Polishing');
    expect(jobTypeForKind('repair', null)).toBe('Repair');
    expect(jobTypeForKind('appraisal', null)).toBe('Appraisal');
    expect(jobTypeForKind('other', null)).toBe('');
    expect(jobTypeForKind(null, null)).toBe('');
  });
});

describe('buildServiceJobPrefill', () => {
  it('a resize prefill never puts a number in the description', () => {
    const prefill = buildServiceJobPrefill(request({
      kind: 'resize',
      ring_size: '7.5',
      details: 'Please make it a 7.5 — it spins on my finger.',
    }));

    // The guard, structurally: there is no description to carry a number.
    expect(prefill).not.toHaveProperty('serviceDescription');

    // Nothing else the prefill sets may smuggle the size in either. `notes` is
    // the one field allowed to hold it, so it is excluded from this sweep.
    const carried = Object.entries(prefill)
      .filter(([key]) => key !== 'notes')
      .map(([, value]) => String(value ?? ''));
    for (const value of carried) {
      expect(value).not.toMatch(/7\.5/);
    }

    // And the size did survive — in notes, where a human reads it.
    expect(prefill.serviceType).toBe('Ring Resize');
    expect(prefill.notes).toContain('7.5');
    expect(prefill.notes).toContain('Please make it a 7.5');
  });

  it('carries the invoice of whichever record the request points at', () => {
    const plan = buildServiceJobPrefill(request({
      layaway_account_id: 'acct-1',
      layaway_accounts: { id: 'acct-1', invoice_number: '19105' },
    }));
    expect(plan.invoiceNumber).toBe('19105');

    const order = buildServiceJobPrefill(request({
      cash_order_id: 'ord-1',
      cash_orders: { id: 'ord-1', invoice_number: '19278' },
    }));
    expect(order.invoiceNumber).toBe('19278');

    // A request about a piece with no order behind it leaves it to the CSR.
    expect(buildServiceJobPrefill(request()).invoiceNumber).toBeUndefined();
  });

  it('hints at the choice when the kind maps to no type', () => {
    expect(buildServiceJobPrefill(request({ kind: 'resize', ring_size: null })).hint)
      .toMatch(/no ring size/i);
    expect(buildServiceJobPrefill(request({ kind: 'other' })).hint)
      .toMatch(/choose one/i);
    // A kind that maps cleanly needs no hint.
    expect(buildServiceJobPrefill(request({ kind: 'repair' })).hint).toBeUndefined();
  });
});
