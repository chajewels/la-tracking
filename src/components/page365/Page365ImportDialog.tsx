import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link2, ExternalLink } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';

interface Page365ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 409 body from page365-fetch-order when the invoice is already in the Hub. */
interface AlreadyImported {
  source: 'cash_order' | 'layaway_account';
  id: string;
}

/**
 * The edge function returns its refusal as a JSON body, which supabase-js wraps
 * in a FunctionsHttpError — `error.message` alone is the useless generic. Read
 * the body so the CSR sees the named field ("Item \"X\" has no price") rather
 * than "Edge Function returned a non-2xx status code".
 */
async function readFnError(
  error: unknown,
): Promise<{ message: string; already?: AlreadyImported }> {
  const err = error as { message?: string; context?: { body?: ReadableStream } };
  let message = err?.message || 'Could not fetch that Page365 invoice';
  let already: AlreadyImported | undefined;
  try {
    if (err?.context?.body) {
      const body = await new Response(err.context.body).json();
      if (body?.error) message = body.error;
      if (body?.already_imported) already = body.already_imported as AlreadyImported;
    }
  } catch { /* keep the generic message */ }
  return { message, already };
}

export default function Page365ImportDialog({ open, onOpenChange }: Page365ImportDialogProps) {
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [already, setAlready] = useState<AlreadyImported | null>(null);

  const close = () => {
    onOpenChange(false);
    setUrl('');
    setError(null);
    setAlready(null);
    setLoading(false);
  };

  const fetchDraft = async () => {
    setLoading(true);
    setError(null);
    setAlready(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke('page365-fetch-order', {
        body: { url: url.trim() },
      });
      if (fnError) {
        const { message, already: dup } = await readFnError(fnError);
        setError(message);
        if (dup) setAlready(dup);
        return;
      }
      // A 200 body can still carry an error field.
      const payload = data as { draft_id?: string; error?: string; already_imported?: AlreadyImported };
      if (payload?.already_imported) {
        setAlready(payload.already_imported);
        setError(payload.error ?? 'That invoice is already in the Hub.');
        return;
      }
      if (payload?.error || !payload?.draft_id) {
        setError(payload?.error ?? 'The Page365 invoice could not be read.');
        return;
      }
      onOpenChange(false);
      navigate(`/page365/review/${payload.draft_id}`);
      setUrl('');
    } catch (e) {
      setError((e as Error)?.message ?? 'Could not fetch that Page365 invoice');
    } finally {
      setLoading(false);
    }
  };

  const openExisting = () => {
    if (!already) return;
    close();
    navigate(
      already.source === 'cash_order'
        ? `/cash-orders/${already.id}`
        : `/accounts/${already.id}`,
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-w-lg border-border bg-card">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display text-card-foreground">
            <Link2 className="h-5 w-5 text-primary" />
            Import from Page365
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Paste the full invoice link. Nothing is created until you review and confirm it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="p365-url" className="text-xs">Page365 invoice link</Label>
          <Input
            id="p365-url"
            value={url}
            onChange={(e) => { setUrl(e.target.value); setError(null); setAlready(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && url.trim() && !loading) fetchDraft(); }}
            placeholder="https://chajewelsjapan.com/invoices/…?sig=…"
            className="bg-background border-border"
            autoFocus
          />
          <p className="text-[11px] text-muted-foreground">
            Copy the whole link including its <code>?sig=</code> — without it Page365 will not
            open the invoice. The signature is used once to fetch and is never stored.
          </p>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3">
            <p className="text-sm text-destructive">{error}</p>
            {already && (
              <Button
                variant="outline"
                size="sm"
                className="mt-2 border-primary/30 text-primary hover:bg-primary/10"
                onClick={openExisting}
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                Open the {already.source === 'cash_order' ? 'cash order' : 'layaway account'}
              </Button>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={close} disabled={loading}>Cancel</Button>
          <Button
            onClick={fetchDraft}
            disabled={loading || !url.trim()}
            className="gold-gradient text-primary-foreground"
          >
            {loading ? 'Fetching…' : 'Fetch invoice'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
