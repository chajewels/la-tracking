import { useState } from 'react';
import { Loader2, FileSpreadsheet } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';

// ── Rebuild Cash Receipts (Bug #251 one-off repair sweep) ──────────────────
interface RebuildResult {
  invoice_number: string;
  kind: string;
  capacity?: number;
  would_write?: number;
  written?: number;
  overflow?: number;
  cells_updated?: number;
  skipped?: string;
  error?: string;
}

export default function RebuildCashReceiptsCard() {
  const [running, setRunning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [mode, setMode] = useState<'dry_run' | 'apply' | null>(null);
  const [processed, setProcessed] = useState(0);
  const [total, setTotal] = useState(0);
  const [results, setResults] = useState<RebuildResult[]>([]);

  const runSweep = async (dryRun: boolean) => {
    setRunning(true);
    setMode(dryRun ? 'dry_run' : 'apply');
    setResults([]);
    setProcessed(0);
    setTotal(0);
    const acc: RebuildResult[] = [];
    let cursor: string | null = null;
    let iterations = 0;
    try {
      // Hard cap of 20 iterations so a bug can never infinite-loop.
      while (iterations < 20) {
        iterations++;
        const { data, error } = await supabase.functions.invoke('rebuild-cash-receipts', {
          body: { dry_run: dryRun, batch_size: 20, cursor },
        });
        if (error) throw error;
        acc.push(...((data?.results ?? []) as RebuildResult[]));
        setResults([...acc]);
        setTotal(data?.total ?? 0);
        setProcessed(acc.length);
        cursor = data?.next_cursor ?? null;
        if (cursor === null) break;
      }
      if (cursor !== null) {
        toast.warning('Stopped at the 20-batch safety cap — run again to continue.');
      } else {
        const overflowCount = acc.filter(r => (r.overflow ?? 0) > 0).length;
        const errCount = acc.filter(r => r.error).length;
        toast.success(
          `${dryRun ? 'Dry run' : 'Repair'} complete: ${acc.length} processed` +
          (overflowCount > 0 ? ` · ${overflowCount} over capacity` : '') +
          (errCount > 0 ? ` · ${errCount} errors` : ''),
        );
      }
    } catch (err: any) {
      toast.error(err.message || 'Rebuild failed');
    } finally {
      setRunning(false);
    }
  };

  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="h-3.5 w-3.5 text-primary" />
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-card-foreground">Rebuild Cash Receipts</h3>
            <p className="text-[11px] text-muted-foreground mt-0.5 max-w-md">
              Rewrite every invoice sheet's Cash Receipt tab from database records (Bug #251 repair). Idempotent — safe to re-run.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline" size="sm"
            className="h-8 text-xs bg-zinc-800 border-zinc-700 hover:bg-zinc-700"
            disabled={running}
            onClick={() => runSweep(true)}
          >
            {running && mode === 'dry_run' ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
            Dry run
          </Button>
          <Button size="sm" className="h-8 text-xs" disabled={running} onClick={() => setConfirmOpen(true)}>
            {running && mode === 'apply' ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
            Apply repair
          </Button>
        </div>
      </div>

      {(running || results.length > 0) && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              Processed {processed}{total > 0 ? ` of ${total}` : ''}
              {mode === 'dry_run' ? ' (dry run)' : ''}
            </span>
            <span>{pct}%</span>
          </div>
          <Progress value={pct} className="h-1.5" />
        </div>
      )}

      {results.length > 0 && (
        <div className="rounded-lg border border-zinc-800 overflow-hidden max-h-80 overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-[10px]">Invoice</TableHead>
                <TableHead className="text-[10px]">Kind</TableHead>
                <TableHead className="text-[10px] text-right">Capacity</TableHead>
                <TableHead className="text-[10px] text-right">{mode === 'dry_run' ? 'Would write' : 'Written'}</TableHead>
                <TableHead className="text-[10px] text-right">Overflow</TableHead>
                <TableHead className="text-[10px]">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((r, i) => {
                const overflow = r.overflow ?? 0;
                return (
                  <TableRow
                    key={`${r.kind}:${r.invoice_number}:${i}`}
                    className={overflow > 0 ? 'bg-amber-500/5' : r.error ? 'bg-destructive/5' : ''}
                  >
                    <TableCell className="text-[11px] tabular-nums">{r.invoice_number}</TableCell>
                    <TableCell className="text-[11px]">{r.kind}</TableCell>
                    <TableCell className="text-[11px] text-right tabular-nums">{r.capacity ?? '—'}</TableCell>
                    <TableCell className="text-[11px] text-right tabular-nums">{r.written ?? r.would_write ?? '—'}</TableCell>
                    <TableCell className={`text-[11px] text-right tabular-nums ${overflow > 0 ? 'text-amber-500 font-medium' : ''}`}>
                      {r.skipped || r.error ? '—' : overflow}
                    </TableCell>
                    <TableCell className="text-[11px]">
                      {r.error
                        ? <span className="text-destructive">{r.error}</span>
                        : r.skipped
                          ? <span className="text-muted-foreground">{r.skipped}</span>
                          : overflow > 0
                            ? <span className="text-amber-500">over capacity — regenerate</span>
                            : <span className="text-success">ok</span>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply Cash Receipt repair?</AlertDialogTitle>
            <AlertDialogDescription>
              This rewrites the Cash Receipt tab of every invoice sheet from database records. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmOpen(false); runSweep(false); }}>
              Apply repair
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
