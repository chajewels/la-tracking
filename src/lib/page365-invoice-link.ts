import { supabase } from '@/integrations/supabase/client';

/**
 * Page365 void sync — Hub side (owner decisions 2026-10-21; docs/PAGE365-IMPORT.md
 * "Void sync"). The status function and the edge function ship in migration
 * 20261228100000 / page365-invoice-check and are not in
 * src/integrations/supabase/types.ts until Lovable regenerates it on its next
 * deploy. types.ts is never hand-edited (CLAUDE.md, GENERATED FILES), so the one
 * untyped access lives here instead of as a cast at every call site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const untyped = supabase as unknown as { rpc: (fn: string, args: Record<string, unknown>) => any };

export interface Page365LinkStatus {
  has_link: boolean;
  page365_no: number;
  last_stage?: string | null;
  last_checked_at?: string | null;
  last_check_error?: string | null;
  cancelled_by_page365?: boolean;
  cancelled_at?: string | null;
  restored_at?: string | null;
}

export interface Page365CheckResult {
  ok?: boolean;
  action?: string;
  why?: string;
  code?: string;
  error?: string;
  stage?: string;
  status?: string;
  restored_status?: string;
  kind?: 'layaway' | 'cash';
}

export async function fetchPage365LinkStatus(page365No: number): Promise<Page365LinkStatus | null> {
  const { data, error } = await untyped.rpc('page365_invoice_link_status', { p_page365_no: page365No });
  // A missing function (migration not applied yet) is not this page's problem.
  if (error) return null;
  return (data ?? null) as Page365LinkStatus | null;
}

/** Plain-English label for a Page365 invoice stage. */
export function stageLabel(stage: string | null | undefined): string {
  if (!stage) return 'Not read yet';
  if (stage === 'voided') return 'Voided (cancelled in Page365)';
  if (stage === 'unpaid') return 'Unpaid';
  if (stage === 'paid') return 'Paid';
  return stage.charAt(0).toUpperCase() + stage.slice(1).replace(/_/g, ' ');
}

/** Plain-English label for a stored read error (never shows a raw link). */
export function readErrorLabel(error: string | null | undefined): string | null {
  if (!error) return null;
  if (/^http_40[13]/.test(error)) return 'Page365 refused the saved link — add the link again.';
  if (/^http_404/.test(error)) return 'Page365 could not find the invoice — add the link again.';
  if (/^invoice_mismatch/.test(error)) return 'The saved link opens a different invoice — add the correct link.';
  if (/^unreachable/.test(error)) return 'Page365 could not be reached on the last check.';
  if (/^apply:/.test(error)) return 'The last check could not update the order — see the bell for details.';
  return 'The last check failed.';
}

export type ResultTone = 'success' | 'info' | 'warning' | 'error';

/** What staff see after pressing Re-read Page365. */
export function checkResultMessage(r: Page365CheckResult): { tone: ResultTone; text: string } {
  const stage = stageLabel(r.stage);
  switch (r.action) {
    case 'cancelled':
      return { tone: 'success', text: 'Voided in Page365 — the Hub cancelled this order.' };
    case 'restored':
      return { tone: 'success', text: `Renewed in Page365 — the Hub restored this order${r.restored_status ? ` (back to ${r.restored_status.replace(/_/g, ' ')})` : ''}.` };
    case 'submission_pending':
      return { tone: 'warning', text: 'A payment submission is still waiting. Confirm or reject it, then press Re-read Page365 again.' };
    case 'needs_staff':
      return r.why === 'store_credit_issued'
        ? { tone: 'warning', text: 'Renewed in Page365, but store credit was issued when it was cancelled. Handle it by hand.' }
        : { tone: 'warning', text: 'Voided in Page365, but this order has money received. Use Cancel Order to cancel it.' };
    case 'no_action':
      return r.why === 'already_closed'
        ? { tone: 'info', text: `Page365 shows ${stage}. This order is already closed in the Hub — nothing changed.` }
        : { tone: 'info', text: `Page365 shows ${stage}. Nothing to change.` };
    case 'read_failed':
      return { tone: 'error', text: readErrorLabel(r.error) ?? 'Page365 could not be read.' };
    default:
      return { tone: 'error', text: r.error || 'The Page365 check did not finish.' };
  }
}
