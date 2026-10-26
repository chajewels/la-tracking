import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, Download, FileDown, FileText, Loader2, Paperclip, Pencil, UserCog, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { isMissingFunction } from '@/components/website/shipping-fees';
import {
  TEMPLATE_LABEL, computeMonth as computeTimesheetMonth, monthLabelFromKey,
  type TemplateType, type TimesheetEntry, type TimesheetProfile,
} from '@/lib/timesheetEngine';
import {
  computeMonth as computeCommissionMonth, type CommissionSplit, type SaleRow,
} from '@/lib/commissionEngine';
import {
  COMPANY_NAME, PAYSLIP_BOOK_KEY, PAYSLIP_PROOF_BUCKET, STATUS_LABEL,
  type Payslip, type PayslipBookState, type PayslipFigures, type PayrollDetails, type RowStatus,
  actualRate, buildCommissionFigures, buildFigures, buildTimesheetFigures, canIssueForMonth, commissionLines,
  currentPayslip, defaultYenSent, detailsComplete, downloadPayslipXlsx, figuresChanged, finalizePayload,
  findAgentResult, formatDate, formatPeso, formatYen, normaliseBook, payslipRefusal, payslipTitle, proofContentType, proofFileName,
  proofPath, proofProblem, timesheetLines, todayTokyo, validateDetails, validatePayment,
} from '@/lib/payslips';
import type { ProofFile } from '@/lib/payslipPdf';
import {
  MARKET_RATE_QUERY_KEY, MARKET_RATE_STALE_MS, fetchJpyPhpMarketRate, formatMarketRate,
} from '@/lib/marketRate';

/**
 * Timesheet → Payslips (owner-confirmed plan 2026-10-26; docs/PAYSLIPS.md). Admin + can_view_all only
 * (the Cost Master gate); every action is re-checked server-side by can_manage_payslips and audited
 * (migration 20270201100000_staff_payslips.sql). The live figures are the draft; Finalize freezes them.
 *
 * Until that migration is applied the RPCs do not exist (PGRST202): the tab says
 * "Waiting for the database update" instead of erroring.
 */

async function callRpc(name: string, args?: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase.rpc(name as any, args as any);
  if (error) throw error;
  const out = (data ?? {}) as Record<string, unknown>;
  if (typeof out.error === 'string') throw Object.assign(new Error(out.error), { code: out.error });
  return out;
}

const refusal = (e: unknown) => payslipRefusal((e as { code?: string })?.code);

const DETAILS_MISSING = 'Add address and date of birth first';

interface AgentLink { name: string; user_id: string | null }

interface StaffRow {
  profile: TimesheetProfile;
  name: string;
  figures: PayslipFigures | null;
  payslip: Payslip | null;
  status: RowStatus;
  details: PayrollDetails | null;
}

function statusVariant(s: RowStatus): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (s === 'paid') return 'default';
  if (s === 'finalized') return 'secondary';
  return 'outline';
}

async function fetchMonthSales(monthKey: string): Promise<SaleRow[]> {
  // sales_log can exceed PostgREST's 1,000-row server cap (.limit(10000) does not override it):
  // page with .range() as Commissions.tsx does, here only for the pay month.
  const [y, m] = monthKey.split('-').map(Number);
  const start = `${monthKey}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const pageSize = 1000;
  let from = 0;
  let all: unknown[] = [];
  while (true) {
    const { data, error } = await supabase
      .from('sales_log')
      .select('id, sale_date, item_code, invoice_number, item_amount, client_name, closer, processor, coordinator, support, verifier, status, channel, source, opened_in_chat, closed_in_chat, eligible, notes')
      .gte('sale_date', start).lt('sale_date', next)
      .order('sale_date', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all as SaleRow[];
}

export default function PayslipsTab({
  profiles, entriesByUser, nameByUser, monthKey, onMonthChange, monthOptions,
}: {
  profiles: TimesheetProfile[];
  entriesByUser: Map<string, TimesheetEntry[]>;
  nameByUser: Map<string, string>;
  monthKey: string;
  onMonthChange: (k: string) => void;
  monthOptions: string[];
}) {
  const qc = useQueryClient();
  const [viewing, setViewing] = useState<string | null>(null); // user_id
  const [confirmFinalize, setConfirmFinalize] = useState<StaffRow | null>(null);
  const [paying, setPaying] = useState<Payslip | null>(null);
  const [voiding, setVoiding] = useState<Payslip | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [editingDetails, setEditingDetails] = useState<string | null>(null); // user_id
  const [pdfBusy, setPdfBusy] = useState(false);

  const book = useQuery<PayslipBookState>({
    queryKey: [...PAYSLIP_BOOK_KEY, monthKey],
    queryFn: async () => {
      try {
        const out = await callRpc('get_payslip_book', { p_pay_month: `${monthKey}-01` });
        return { available: true, book: normaliseBook(out) };
      } catch (e) {
        if (isMissingFunction(e)) return { available: false };
        throw e;
      }
    },
    staleTime: 30_000,
  });

  const commission = useQuery({
    queryKey: ['payslip-commission', monthKey],
    queryFn: async () => {
      const [rows, agentsRes, splitsRes] = await Promise.all([
        fetchMonthSales(monthKey),
        supabase.from('commission_agents').select('name, user_id'),
        supabase.from('commission_splits').select('month, closer_pct, processor_pct, coordinator_pct, support_pct, verifier_pct, top_sales_pct, top_sales_2_pct, merge_groups, pool_per_item_php').order('month', { ascending: true }),
      ]);
      if (agentsRes.error) throw agentsRes.error;
      if (splitsRes.error) throw splitsRes.error;
      const comp = computeCommissionMonth(monthKey, rows, (splitsRes.data as CommissionSplit[]) ?? []);
      return { comp, agents: (agentsRes.data as AgentLink[]) ?? [] };
    },
    staleTime: 60_000,
  });

  const data = book.data?.available ? book.data.book : null;

  const rows: StaffRow[] = useMemo(() => {
    const active = profiles.filter(p => p.active);
    return active.map((p): StaffRow => {
      const name = nameByUser.get(p.user_id) ?? p.user_id;
      let figures: PayslipFigures | null = null;
      if (commission.data) {
        const m = computeTimesheetMonth(monthKey, entriesByUser.get(p.user_id) ?? [], p);
        const ts = buildTimesheetFigures(p.template_type, m, p);
        const agentName = commission.data.agents.find(a => a.user_id === p.user_id)?.name ?? null;
        const agent = findAgentResult(commission.data.comp, agentName);
        figures = buildFigures(ts, buildCommissionFigures(commission.data.comp, agent));
      }
      const payslip = data ? currentPayslip(data.payslips, p.user_id) : null;
      const details = data?.details.find(d => d.user_id === p.user_id) ?? null;
      return { profile: p, name, figures, payslip, status: payslip?.status ?? 'not_issued', details };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, [profiles, nameByUser, entriesByUser, monthKey, commission.data, data]);

  const refresh = () => qc.invalidateQueries({ queryKey: PAYSLIP_BOOK_KEY });

  const finalize = useMutation({
    mutationFn: (r: StaffRow) => callRpc('finalize_payslip', {
      p_user_id: r.profile.user_id, p_pay_month: `${monthKey}-01`, p_payload: finalizePayload(r.figures as PayslipFigures),
    }),
    onSuccess: () => { toast.success('Payslip finalized'); setConfirmFinalize(null); },
    onError: (e) => toast.error(refusal(e)),
    onSettled: refresh,
  });

  const voidMut = useMutation({
    mutationFn: (v: { id: string; reason: string }) => callRpc('void_payslip', { p_id: v.id, p_reason: v.reason }),
    onSuccess: () => { toast.success('Payslip voided'); setVoiding(null); setVoidReason(''); },
    onError: (e) => toast.error(refusal(e)),
    onSettled: refresh,
  });

  const openProof = async (path: string) => {
    const { data: signed, error } = await supabase.storage.from(PAYSLIP_PROOF_BUCKET).createSignedUrl(path, 600);
    if (error || !signed?.signedUrl) { toast.error('Could not open the proof of payment'); return; }
    window.open(signed.signedUrl, '_blank', 'noopener,noreferrer');
  };

  const downloadProof = async (path: string) => {
    const name = proofFileName(path);
    const { data: signed, error } = await supabase.storage.from(PAYSLIP_PROOF_BUCKET).createSignedUrl(path, 600, { download: name });
    if (error || !signed?.signedUrl) { toast.error('Could not download the proof of payment'); return; }
    const a = document.createElement('a');
    a.href = signed.signedUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const loadProof = async (path: string): Promise<ProofFile | null> => {
    const { data: signed, error } = await supabase.storage.from(PAYSLIP_PROOF_BUCKET).createSignedUrl(path, 600);
    if (error || !signed?.signedUrl) return null;
    const res = await fetch(signed.signedUrl);
    if (!res.ok) return null;
    const fileName = proofFileName(path);
    const header = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const contentType = header === 'application/pdf' || header.startsWith('image/') ? header : '';
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType, fileName };
  };

  const downloadPdf = async (p: Payslip) => {
    setPdfBusy(true);
    try {
      // pdf-lib loads only when a PDF is asked for (it is not in the Timesheet page bundle).
      const { downloadPayslipPdf } = await import('@/lib/payslipPdf');
      const { proofNote } = await downloadPayslipPdf(p, () => (p.proof_path ? loadProof(p.proof_path) : Promise.resolve(null)));
      if (proofNote) toast.warning(proofNote);
    } catch {
      toast.error('The PDF could not be made. Try again.');
    } finally {
      setPdfBusy(false);
    }
  };

  const viewingRow = viewing ? rows.find(r => r.profile.user_id === viewing) ?? null : null;
  const editingRow = editingDetails ? rows.find(r => r.profile.user_id === editingDetails) ?? null : null;
  const finalizeBlock = (r: StaffRow): string | null => {
    if (!canIssueForMonth(monthKey)) return 'Payslips start from June 2026.';
    if (!detailsComplete(r.details)) return DETAILS_MISSING;
    if (!r.figures) return commission.isError ? 'Commission figures could not be loaded.' : 'Loading the figures…';
    return null;
  };

  return (
    <div className="space-y-4" data-testid="payslips-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Select value={monthKey} onValueChange={onMonthChange}>
          <SelectTrigger className="h-9 w-48" aria-label="Pay month"><SelectValue /></SelectTrigger>
          <SelectContent>
            {monthOptions.map(k => <SelectItem key={k} value={k}>{monthLabelFromKey(k)}</SelectItem>)}
          </SelectContent>
        </Select>
        {data && (
          <Button variant="outline" size="sm" onClick={() => setDetailsOpen(true)} data-testid="payslips-details-open">
            <UserCog className="mr-1.5 h-4 w-4" /> Staff details
          </Button>
        )}
      </div>

      {book.isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      )}
      {book.data?.available === false && (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="payslips-waiting">
          Waiting for the database update. Payslips appear here once the payslips migration has been applied.
        </p>
      )}
      {book.isError && (
        <p className="text-sm text-destructive">Could not read the payslips. Try again in a moment.</p>
      )}
      {commission.isError && data && (
        <p className="text-sm text-destructive">Could not load the commission figures, so payslips cannot be finalized right now.</p>
      )}

      {data && (
        rows.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-12 text-center text-sm text-muted-foreground">
            No active timesheet profiles.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full min-w-[640px] text-sm" data-testid="payslips-table">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Staff</th>
                  <th className="px-3 py-2 text-left font-medium">Type</th>
                  <th className="px-3 py-2 text-right font-medium">Timesheet net</th>
                  <th className="px-3 py-2 text-right font-medium">Commission</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const shown = r.payslip && r.payslip.status !== 'void' ? r.payslip : null;
                  const ts = shown ? shown.timesheet_net_php : r.figures?.timesheet_net_php;
                  const cm = shown ? shown.commission_php : r.figures?.commission_php;
                  const total = shown ? shown.total_php : r.figures?.total_php;
                  const changed = shown && r.figures ? figuresChanged(shown.total_php, r.figures.total_php) : false;
                  return (
                    <tr key={r.profile.user_id} className="border-t border-border">
                      <td className="px-3 py-2">{r.name}</td>
                      <td className="px-3 py-2 text-muted-foreground">{TEMPLATE_LABEL[r.profile.template_type]}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{ts == null ? '—' : formatPeso(ts)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{cm == null ? '—' : formatPeso(cm)}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums text-primary">
                        {total == null ? '—' : formatPeso(total)}
                        {changed && <AlertTriangle className="ml-1 inline h-3.5 w-3.5 text-warning" aria-label="Figures changed" />}
                      </td>
                      <td className="px-3 py-2"><Badge variant={statusVariant(r.status)}>{STATUS_LABEL[r.status]}</Badge></td>
                      <td className="px-3 py-2 text-right">
                        <Button size="sm" variant="ghost" onClick={() => setEditingDetails(r.profile.user_id)}>
                          <Pencil className="mr-1 h-4 w-4" /> Edit details
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setViewing(r.profile.user_id)}>
                          <FileText className="mr-1 h-4 w-4" /> View
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Payslip view */}
      <Dialog open={!!viewingRow} onOpenChange={(o) => { if (!o) setViewing(null); }}>
        <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
          {viewingRow && data && (
            <PayslipView
              row={viewingRow}
              monthKey={monthKey}
              finalizeBlock={finalizeBlock(viewingRow)}
              onFinalize={() => setConfirmFinalize(viewingRow)}
              onPay={(p) => setPaying(p)}
              onVoid={(p) => { setVoiding(p); setVoidReason(''); }}
              onProof={openProof}
              onDownloadProof={downloadProof}
              onDownloadPdf={downloadPdf}
              pdfBusy={pdfBusy}
              onEditDetails={() => setEditingDetails(viewingRow.profile.user_id)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Finalize confirmation */}
      <AlertDialog open={!!confirmFinalize} onOpenChange={(o) => { if (!o) setConfirmFinalize(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Finalize payslip?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmFinalize?.name}, {longLabel(monthKey)}: total {confirmFinalize?.figures ? formatPeso(confirmFinalize.figures.total_php) : '—'}.
              The figures and staff details freeze. To change them later, void the payslip and issue a new one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={finalize.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={finalize.isPending}
              onClick={(e) => { e.preventDefault(); if (confirmFinalize) finalize.mutate(confirmFinalize); }}
            >
              {finalize.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Finalize
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {paying && (
        <PaymentDialog
          payslip={paying}
          onClose={() => setPaying(null)}
          onSaved={() => { setPaying(null); refresh(); }}
        />
      )}

      {/* Void */}
      <Dialog open={!!voiding} onOpenChange={(o) => { if (!o) setVoiding(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Void payslip</DialogTitle>
            <DialogDescription>
              {voiding?.staff_name}, {voiding ? longLabel(voiding.pay_month) : ''}. The payslip stays on record as void
              and a new one can be issued for the month.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="payslip-void-reason">Reason</Label>
            <Textarea id="payslip-void-reason" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} maxLength={500} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVoiding(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={voidReason.trim().length < 3 || voidMut.isPending}
              onClick={() => voiding && voidMut.mutate({ id: voiding.id, reason: voidReason.trim() })}
            >
              {voidMut.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Void payslip
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {detailsOpen && data && (
        <StaffDetailsDialog rows={rows} onClose={() => setDetailsOpen(false)} onSaved={refresh} />
      )}

      {/* One person's details (row action, or from a payslip blocked on missing details) */}
      <Dialog open={!!editingRow} onOpenChange={(o) => { if (!o) setEditingDetails(null); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit details</DialogTitle>
            <DialogDescription>
              Address and date of birth print on the payslip. A finalized payslip keeps the details it was issued with.
            </DialogDescription>
          </DialogHeader>
          {editingRow && (
            <StaffDetailsRow
              key={editingRow.profile.user_id}
              row={editingRow}
              onSaved={() => { refresh(); setEditingDetails(null); }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function longLabel(monthKey: string): string {
  return payslipTitle(monthKey).replace('Payslip — ', '');
}

// ── Payslip document ────────────────────────────────────────────────────────

function Section({ title, lines }: { title: string; lines: { label: string; value: string }[] }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <dl className="divide-y divide-border rounded-md border border-border">
        {lines.map(l => (
          <div key={l.label} className="flex items-baseline justify-between gap-3 px-3 py-1.5 text-sm">
            <dt className="text-muted-foreground">{l.label}</dt>
            <dd className="text-right tabular-nums">{l.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function PayslipView({
  row, monthKey, finalizeBlock, onFinalize, onPay, onVoid, onProof, onDownloadProof, onDownloadPdf, pdfBusy, onEditDetails,
}: {
  row: StaffRow;
  monthKey: string;
  finalizeBlock: string | null;
  onFinalize: () => void;
  onPay: (p: Payslip) => void;
  onVoid: (p: Payslip) => void;
  onProof: (path: string) => void;
  onDownloadProof: (path: string) => void;
  onDownloadPdf: (p: Payslip) => void;
  pdfBusy: boolean;
  onEditDetails: () => void;
}) {
  const p = row.payslip;
  const issued = p && p.status !== 'void' ? p : null;
  const template: TemplateType = issued ? issued.template_type : row.profile.template_type;
  const tsSource = issued ? issued.timesheet : (row.figures?.timesheet as unknown as Record<string, unknown> | undefined);
  const cmSource = issued ? issued.commission : (row.figures?.commission as unknown as Record<string, unknown> | undefined);
  const total = issued ? issued.total_php : row.figures?.total_php;
  const changed = issued && row.figures ? figuresChanged(issued.total_php, row.figures.total_php) : false;

  return (
    <div className="space-y-4" data-testid="payslip-view">
      <DialogHeader>
        <p className="text-sm font-medium text-muted-foreground">{COMPANY_NAME}</p>
        <DialogTitle className="font-display text-xl">{payslipTitle(monthKey)}</DialogTitle>
        <DialogDescription>
          {issued ? `${STATUS_LABEL[issued.status]} — figures frozen ${formatDate(issued.finalized_at)}` : 'Draft — live figures, nothing is stored until you finalize.'}
        </DialogDescription>
      </DialogHeader>

      {p?.status === 'void' && (
        <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
          The last payslip for this month was voided{p.void_reason ? `: ${p.void_reason}` : ''}. The figures below are the live draft for a new one.
        </p>
      )}
      {changed && (
        <p className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-2 text-xs" data-testid="payslip-changed">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          Figures changed after this payslip was finalized — void and re-issue to update.
        </p>
      )}

      <Section title="Staff" lines={[
        { label: 'Name', value: issued ? issued.staff_name : row.name },
        { label: 'Address', value: (issued ? issued.address : row.details?.address) || '—' },
        { label: 'Date of birth', value: formatDate(issued ? issued.date_of_birth : row.details?.date_of_birth) },
        { label: 'Job title', value: (issued ? issued.job_title : row.profile.job_title) || '—' },
      ]} />

      {tsSource && cmSource ? (
        <>
          <Section title={`Timesheet — ${TEMPLATE_LABEL[template]}`} lines={timesheetLines(template, tsSource)} />
          <Section title="Commission" lines={commissionLines(cmSource)} />
          <div className="flex items-baseline justify-between rounded-md bg-primary/5 px-3 py-2 font-semibold">
            <span>Total</span>
            <span className="tabular-nums text-primary">{total == null ? '—' : formatPeso(total)}</span>
          </div>
        </>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading the figures…</p>
      )}

      {issued?.status === 'paid' && issued.jpy_sent != null && issued.php_received != null && (
        <div className="space-y-1 rounded-md border border-border p-3 text-sm" data-testid="payslip-payment">
          <p>
            {longLabel(monthKey)} salary {formatYen(issued.jpy_sent)} → {formatPeso(issued.php_received)}
          </p>
          <p className="text-xs text-muted-foreground">
            Rate used ₱{issued.php_per_jpy} per ¥1 · Paid on {formatDate(issued.paid_on)}
          </p>
          {figuresChanged(issued.total_php, issued.php_received) && (
            <p className="text-xs">Difference vs payslip total: {formatPeso(issued.php_received - issued.total_php)}</p>
          )}
          {issued.proof_path && (
            <Button size="sm" variant="link" className="h-auto p-0" onClick={() => onProof(issued.proof_path as string)}>
              <Paperclip className="mr-1 h-3.5 w-3.5" /> Open proof of payment
            </Button>
          )}
          {issued.proof_path && (
            <Button size="sm" variant="outline" className="ml-2" onClick={() => onDownloadProof(issued.proof_path as string)}>
              <Download className="mr-1 h-3.5 w-3.5" /> Download proof
            </Button>
          )}
        </div>
      )}

      <DialogFooter className="flex-wrap gap-2 sm:justify-end">
        {!issued && (
          <div className="flex flex-col items-end gap-1">
            <Button onClick={onFinalize} disabled={!!finalizeBlock} data-testid="payslip-finalize">Finalize payslip</Button>
            {finalizeBlock && (
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span data-testid="payslip-finalize-block">{finalizeBlock}</span>
                {finalizeBlock === DETAILS_MISSING && (
                  <Button size="sm" variant="outline" onClick={onEditDetails} data-testid="payslip-edit-details">
                    <Pencil className="mr-1 h-3.5 w-3.5" /> Edit details
                  </Button>
                )}
              </span>
            )}
          </div>
        )}
        {issued && (
          <>
            <Button variant="outline" onClick={() => downloadPayslipXlsx(issued)}>
              <Download className="mr-1 h-4 w-4" /> Download Excel
            </Button>
            <Button variant="outline" onClick={() => onDownloadPdf(issued)} disabled={pdfBusy} data-testid="payslip-download-pdf">
              {pdfBusy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FileDown className="mr-1 h-4 w-4" />} Download PDF
            </Button>
            <Button variant="outline" onClick={() => onVoid(issued)}>
              <Ban className="mr-1 h-4 w-4" /> Void
            </Button>
          </>
        )}
        {issued?.status === 'finalized' && (
          <Button onClick={() => onPay(issued)}><Wallet className="mr-1 h-4 w-4" /> Record payment</Button>
        )}
      </DialogFooter>
    </div>
  );
}

// ── Record payment ──────────────────────────────────────────────────────────

function PaymentDialog({
  payslip, onClose, onSaved,
}: {
  payslip: Payslip;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Yen pre-fill from TODAY'S MARKET RATE (owner 2026-10-26). Never system_settings.php_jpy_rate here.
  const market = useQuery({
    queryKey: MARKET_RATE_QUERY_KEY,
    queryFn: () => fetchJpyPhpMarketRate(),
    staleTime: MARKET_RATE_STALE_MS,
    retry: false,
  });
  const [jpySent, setJpySent] = useState('');
  const [jpyTyped, setJpyTyped] = useState(false);
  useEffect(() => {
    const r = market.data?.php_per_jpy;
    if (r && !jpyTyped) setJpySent(String(defaultYenSent(payslip.total_php, r) ?? ''));
  }, [market.data, jpyTyped, payslip.total_php]);
  const [phpReceived, setPhpReceived] = useState(() => String(payslip.total_php));
  const [paidOn, setPaidOn] = useState(() => todayTokyo());
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const formError = validatePayment({ jpySent, phpReceived, paidOn }, payslip.pay_month);
  const fileError = proofProblem(file);
  const rateUsed = actualRate(Number(phpReceived), Number(jpySent));

  const save = async () => {
    if (formError || fileError || !file) return;
    setSaving(true);
    try {
      const path = proofPath(payslip.id, file.name);
      const { error: upErr } = await supabase.storage.from(PAYSLIP_PROOF_BUCKET)
        .upload(path, file, { cacheControl: '3600', upsert: false, contentType: proofContentType(file) || undefined });
      if (upErr) { toast.error('The proof of payment did not upload. Try again.'); return; }
      try {
        await callRpc('record_payslip_payment', {
          p_id: payslip.id, p_jpy_sent: Number(jpySent), p_php_received: Number(phpReceived),
          p_paid_on: paidOn, p_proof_path: path,
        });
      } catch (e) {
        toast.error(`The payment was not recorded. ${refusal(e)} Try again.`);
        return;
      }
      toast.success('Payment recorded');
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
          <DialogDescription>
            {payslip.staff_name}, {longLabel(payslip.pay_month)}. Payslip total {formatPeso(payslip.total_php)}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="payslip-jpy">Yen sent (¥)</Label>
            <Input id="payslip-jpy" inputMode="numeric" value={jpySent}
              onChange={(e) => { setJpyTyped(true); setJpySent(e.target.value.replace(/[^\d]/g, '')); }} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="payslip-php">Pesos received (₱)</Label>
            <Input id="payslip-php" inputMode="decimal" value={phpReceived} onChange={(e) => setPhpReceived(e.target.value.replace(/[^\d.]/g, ''))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="payslip-paid-on">Paid on</Label>
            <Input id="payslip-paid-on" type="date" value={paidOn} max={todayTokyo()} onChange={(e) => setPaidOn(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="payslip-proof">Proof of payment</Label>
            <Input id="payslip-proof" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          {market.isLoading && <p data-testid="market-rate">Getting today's market rate…</p>}
          {market.data && (
            <p data-testid="market-rate">
              Market rate today: ¥1 = ₱{formatMarketRate(market.data.php_per_jpy)} ({market.data.source}{market.data.as_of ? `, ${market.data.as_of}` : ''})
            </p>
          )}
          {!market.isLoading && !market.data && (
            <p data-testid="market-rate">Market rate unavailable — enter the yen sent from the proof.</p>
          )}
          {rateUsed != null && <p>Rate used: ₱{rateUsed} per ¥1</p>}
          {Number(phpReceived) > 0 && Math.abs(Number(phpReceived) - payslip.total_php) >= 0.005 && (
            <p>Difference vs payslip total: {formatPeso(Number(phpReceived) - payslip.total_php)}</p>
          )}
          {(formError || (file && fileError)) && <p className="text-destructive">{formError ?? fileError}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={!!formError || !!fileError || saving}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Save payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Staff details ───────────────────────────────────────────────────────────

function StaffDetailsDialog({ rows, onClose, onSaved }: { rows: StaffRow[]; onClose: () => void; onSaved: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Staff details</DialogTitle>
          <DialogDescription>
            Address and date of birth print on each payslip. A finalized payslip keeps the details it was issued with.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {rows.map(r => <StaffDetailsRow key={r.profile.user_id} row={r} onSaved={onSaved} />)}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StaffDetailsRow({ row, onSaved }: { row: StaffRow; onSaved: () => void }) {
  const [address, setAddress] = useState(row.details?.address ?? '');
  const [dob, setDob] = useState(row.details?.date_of_birth ?? '');
  const error = validateDetails(address, dob);
  const dirty = address.trim() !== (row.details?.address ?? '') || dob !== (row.details?.date_of_birth ?? '');

  const save = useMutation({
    mutationFn: () => callRpc('save_staff_payroll_details', {
      p_user_id: row.profile.user_id, p_address: address.trim(), p_date_of_birth: dob || null,
    }),
    onSuccess: () => { toast.success(`Saved details for ${row.name}`); onSaved(); },
    onError: (e) => toast.error(refusal(e)),
  });

  const id = row.profile.user_id;
  return (
    <div className="space-y-2 rounded-md border border-border p-3" data-testid="payslip-details-row">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{row.name}</p>
        {!detailsComplete(row.details) && <Badge variant="outline">Missing</Badge>}
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_11rem]">
        <div className="space-y-1">
          <Label htmlFor={`addr-${id}`} className="text-xs">Address</Label>
          <Textarea id={`addr-${id}`} rows={2} value={address} maxLength={500} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`dob-${id}`} className="text-xs">Date of birth</Label>
          <Input id={`dob-${id}`} type="date" value={dob} min="1900-01-01" max={todayTokyo()} onChange={(e) => setDob(e.target.value)} />
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        {error && <span className="text-xs text-destructive">{error}</span>}
        <Button size="sm" disabled={!dirty || !!error || save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Save
        </Button>
      </div>
    </div>
  );
}
