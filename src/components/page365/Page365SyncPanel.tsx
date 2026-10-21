import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Link2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { usePermissions } from '@/contexts/PermissionsContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatPHTDisplay } from '@/lib/date-utils';
import {
  checkResultMessage,
  fetchPage365LinkStatus,
  readErrorLabel,
  stageLabel,
  type Page365CheckResult,
} from '@/lib/page365-invoice-link';

/**
 * Page365 void sync on the order page (owner decisions 2026-10-21;
 * docs/PAGE365-IMPORT.md "Void sync").
 *
 * Shows what the Hub last read from the Page365 invoice and gives staff:
 *   - "Re-read Page365": reads the invoice now. Voided → the Hub cancels a live
 *     order; renewed → the Hub restores an order it cancelled from a void. The
 *     30-minute check does the same if nobody presses it.
 *   - "Add Page365 link": for orders imported before links were kept. The link
 *     must open THIS order's invoice; saving it changes nothing on the order.
 *
 * Renders nothing for an order not imported from Page365, a website order, or
 * while the migration is not applied (the status function is missing).
 * Permission: layaway forfeit_account, cash cancel_cash_order (the same keys as
 * Cancel Plan / Cancel Order); the edge function checks them again.
 */
async function readFnErrorMessage(error: unknown, fallback: string): Promise<{ message: string; code?: string }> {
  const err = error as { message?: string; context?: { body?: ReadableStream } };
  let message = err?.message || fallback;
  let code: string | undefined;
  try {
    if (err?.context?.body) {
      const body = await new Response(err.context.body).json();
      if (body?.error) message = String(body.error);
      if (body?.code) code = String(body.code);
    }
  } catch { /* keep the generic message */ }
  return { message, code };
}

export default function Page365SyncPanel({ kind, orderId }: { kind: 'cash' | 'layaway'; orderId: string | undefined }) {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const permitted = can(kind === 'layaway' ? 'forfeit_account' : 'cancel_cash_order');
  const [checking, setChecking] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const { data: order } = useQuery({
    queryKey: ['page365-sync-order', kind, orderId],
    enabled: !!orderId,
    staleTime: 60_000,
    queryFn: async () => {
      const q = kind === 'layaway'
        ? supabase.from('layaway_accounts').select('page365_no, source_channel').eq('id', orderId!).maybeSingle()
        : supabase.from('cash_orders').select('page365_no, source_channel').eq('id', orderId!).maybeSingle();
      const { data, error } = await q;
      if (error) return null;
      return (data ?? null) as { page365_no: number | null; source_channel: string | null } | null;
    },
  });
  const page365No = order?.page365_no ?? null;
  const isWeb = order?.source_channel === 'web';

  const { data: status, refetch } = useQuery({
    queryKey: ['page365-link-status', page365No],
    enabled: page365No != null && !isWeb,
    staleTime: 30_000,
    queryFn: () => fetchPage365LinkStatus(page365No!),
  });

  if (page365No == null || isWeb || !status) return null;

  const refreshAll = async () => {
    await refetch();
    qc.invalidateQueries();
  };

  const reRead = async () => {
    setChecking(true);
    try {
      const { data, error } = await supabase.functions.invoke('page365-invoice-check', {
        body: { action: 'check', kind, order_id: orderId },
      });
      if (error) {
        const { message, code } = await readFnErrorMessage(error, 'Could not read Page365');
        if (code === 'no_link') {
          setAddOpen(true);
          return;
        }
        toast.error(message);
        return;
      }
      const r = checkResultMessage((data ?? {}) as Page365CheckResult);
      if (r.tone === 'success') toast.success(r.text);
      else if (r.tone === 'error') toast.error(r.text);
      else if (r.tone === 'warning') toast.warning(r.text);
      else toast.info(r.text);
    } catch (e) {
      toast.error((e as Error)?.message ?? 'Could not read Page365');
    } finally {
      setChecking(false);
      await refreshAll();
    }
  };

  const saveLink = async () => {
    setSaving(true);
    setAddError(null);
    try {
      const { data, error } = await supabase.functions.invoke('page365-invoice-check', {
        body: { action: 'add_link', kind, order_id: orderId, url: url.trim() },
      });
      if (error) {
        const { message } = await readFnErrorMessage(error, 'Could not save the link');
        setAddError(message);
        return;
      }
      const payload = (data ?? {}) as { ok?: boolean; stage?: string; error?: string };
      if (!payload.ok) {
        setAddError(payload.error ?? 'Could not save the link');
        return;
      }
      toast.success(`Page365 link saved — the invoice shows ${stageLabel(payload.stage)}. Press Re-read Page365 to sync it.`);
      setAddOpen(false);
      setUrl('');
      await refetch();
    } catch (e) {
      setAddError((e as Error)?.message ?? 'Could not save the link');
    } finally {
      setSaving(false);
    }
  };

  const errorText = readErrorLabel(status.last_check_error);

  return (
    <div className="rounded-xl border border-border bg-card p-5" data-testid="page365-sync-panel">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-card-foreground">Page365 invoice {page365No}</h3>
        {status.cancelled_by_page365 && (
          <span className="inline-flex items-center rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
            Cancelled — voided in Page365
          </span>
        )}
      </div>

      {status.has_link ? (
        <div className="space-y-1 text-sm">
          <div className="flex flex-wrap justify-between gap-2">
            <span className="text-muted-foreground">Page365 status</span>
            <span className="text-card-foreground" data-testid="page365-stage">{stageLabel(status.last_stage)}</span>
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <span className="text-muted-foreground">Last checked</span>
            <span className="text-card-foreground tabular-nums">
              {status.last_checked_at ? formatPHTDisplay(status.last_checked_at) : 'Not yet'}
            </span>
          </div>
          {errorText && <p className="text-xs text-danger">{errorText}</p>}
          <p className="pt-1 text-[11px] text-muted-foreground">
            Checked every 30 minutes. Voided in Page365 cancels this order; renewed restores an order the Hub cancelled from a void.
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No Page365 link is saved for this order, so the Hub cannot follow its Page365 status. Add the full invoice link to start.
        </p>
      )}

      {permitted && (
        <div className="mt-3 flex flex-wrap gap-2">
          {status.has_link && (
            <Button size="sm" variant="outline" onClick={reRead} disabled={checking} data-testid="page365-reread">
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />
              {checking ? 'Reading Page365…' : 'Re-read Page365'}
            </Button>
          )}
          {(!status.has_link || errorText) && (
            <Button size="sm" variant="outline" onClick={() => { setAddError(null); setAddOpen(true); }} data-testid="page365-add-link">
              <Link2 className="mr-1.5 h-3.5 w-3.5" />
              {status.has_link ? 'Replace Page365 link' : 'Add Page365 link'}
            </Button>
          )}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={(o) => { setAddOpen(o); if (!o) { setUrl(''); setAddError(null); } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{status.has_link ? 'Replace Page365 link' : 'Add Page365 link'}</DialogTitle>
            <DialogDescription>
              Paste the full invoice link for Page365 invoice {page365No}, including the part after <span className="font-mono">?sig=</span>. The link must open this invoice. Saving it does not change the order.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="page365-link-url">Page365 invoice link</Label>
            <Input
              id="page365-link-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://chajewelsjapan.com/invoices/…?sig=…"
              autoComplete="off"
              spellCheck={false}
            />
            {addError && <p className="text-xs text-danger">{addError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={saveLink} disabled={saving || url.trim().length === 0}>
              {saving ? 'Checking link…' : 'Save link'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
