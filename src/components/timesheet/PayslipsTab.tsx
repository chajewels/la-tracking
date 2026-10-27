import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, Coins, Download, FileDown, FileText, Loader2, Paperclip, Pencil, UserCog, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
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
  TEMPLATE_LABEL, computeMonth as computeTimesheetMonth, monthLabelFromKey, payProfileForMonth, profilesForMonth,
  type PaySetting, type TemplateType, type TimesheetEntry, type TimesheetProfile,
} from '@/lib/timesheetEngine';
import {
  computeMonth as computeCommissionMonth, type CommissionSplit, type SaleRow,
} from '@/lib/commissionEngine';
import {
  COMPANY_NAME, NO_FEATURES, PAYSLIP_BOOK_KEY, PAYSLIP_PROOF_BUCKET, STATUS_LABEL,
  type BondPreview, type CashAdvance, type Payslip, type PayslipBookState, type PayslipFeatures, type PayslipFigures,
  type PayrollDetails, type RowStatus,
  actualRate, advanceDateMin, advanceProofFileName, advanceProofPath, advanceProofPaths, advanceProofSlotFree, amountDue, bondPreview, breakdownLines,
  buildCommissionFigures, buildFigures, buildTimesheetFigures, canIssueForMonth, commissionLines,
  currentPayslip, defaultYenSent, detailsComplete, differenceLabel, downloadPayslipXlsx, draftBreakdown, figuresChanged,
  finalizePayload, findAgentResult, formatDate, formatDateDD, formatPeso, formatYen, longMonthLabel, normaliseBook,
  payslipProofPaths, payslipRefusal, payslipTitle, proofContentType, proofFileName, proofPath, proofProblem, storedBreakdown, timesheetLines,
  todayTokyo, validateAdvance, validateDetails, validateEmployeeDetails, validatePayment,
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
const DETAILS_MISSING_WITH_ID = 'Add employee ID, address and date of birth first';
const NO_PAY_SETTINGS: PaySetting[] = [];
const NO_BOND: BondPreview = { kind: 'none', held: 0, released: 0, releasedFrom: null, firstMonth: null };

interface AgentLink { name: string; user_id: string | null }

interface StaffRow {
  profile: TimesheetProfile;
  name: string;
  /** Inactive profile shown because it has entries in this month (owner 2026-10-27, decision M). */
  inactive: boolean;
  figures: PayslipFigures | null;
  payslip: Payslip | null;
  status: RowStatus;
  details: PayrollDetails | null;
  /** This staff member's cash advances for the month (all statuses, newest first). */
  advances: CashAdvance[];
}

/** The cash bond the draft would get, mirroring finalize_payslip (none before the migration). */
function draftBond(r: StaffRow, monthKey: string, features: PayslipFeatures, isFinalPay: boolean): BondPreview {
  if (!features.cash_bond || !r.figures) return NO_BOND;
  const advancesPhp = r.advances.filter(a => a.status === 'active').reduce((s, a) => s + a.amount_php, 0);
  return bondPreview({
    monthKey, totalPhp: r.figures.total_php, advancesPhp, hireDate: r.details?.hire_date,
    firstMonthIssued: r.details?.first_month_issued, pending: r.details?.cash_bond_pending, isFinalPay,
  });
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
  profiles, entriesByUser, nameByUser, monthKey, onMonthChange, monthOptions, paySettings = NO_PAY_SETTINGS,
}: {
  profiles: TimesheetProfile[];
  entriesByUser: Map<string, TimesheetEntry[]>;
  nameByUser: Map<string, string>;
  monthKey: string;
  onMonthChange: (k: string) => void;
  monthOptions: string[];
  /** timesheet_pay_settings rows (empty before migration 20270204100000 — profile values apply). */
  paySettings?: PaySetting[];
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
  const [advancesFor, setAdvancesFor] = useState<string | null>(null); // user_id
  const [finalPay, setFinalPay] = useState(false);

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
  const features = data?.features ?? NO_FEATURES;
  // Pay settings in force: the page's rows, else the book's (same table; either is empty before the migration).
  const settings = useMemo(
    () => (paySettings.length > 0 ? paySettings : (data?.pay_settings ?? [])), [paySettings, data],
  );

  const rows: StaffRow[] = useMemo(() => {
    // Active staff, plus inactive staff with entries in this month (decision M).
    const shown = profilesForMonth(profiles, entriesByUser, monthKey);
    return shown.map((base): StaffRow => {
      const p = payProfileForMonth(base, monthKey, settings);
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
      const advances = data?.cash_advances.filter(a => a.user_id === p.user_id) ?? [];
      return {
        profile: p, name, inactive: !base.active, figures, payslip, status: payslip?.status ?? 'not_issued', details, advances,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, [profiles, nameByUser, entriesByUser, monthKey, commission.data, data, settings]);

  const refresh = () => qc.invalidateQueries({ queryKey: PAYSLIP_BOOK_KEY });

  const finalize = useMutation({
    mutationFn: (v: { row: StaffRow; finalPay: boolean }) => callRpc('finalize_payslip', {
      p_user_id: v.row.profile.user_id, p_pay_month: `${monthKey}-01`, p_payload: finalizePayload(v.row.figures as PayslipFigures),
      // The 4-argument finalize exists only once the cash-bond migration is applied.
      ...(features.cash_bond ? { p_is_final_pay: v.finalPay } : {}),
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

  const loadProof = async (path: string, name?: string): Promise<ProofFile | null> => {
    const { data: signed, error } = await supabase.storage.from(PAYSLIP_PROOF_BUCKET).createSignedUrl(path, 600);
    if (error || !signed?.signedUrl) return null;
    const res = await fetch(signed.signedUrl);
    if (!res.ok) return null;
    const fileName = name ?? proofFileName(path);
    const header = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const contentType = header === 'application/pdf' || header.startsWith('image/') ? header : '';
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType, fileName };
  };

  const downloadPdf = async (p: Payslip) => {
    setPdfBusy(true);
    try {
      // pdf-lib loads only when a PDF is asked for (it is not in the Timesheet page bundle).
      const { downloadPayslipPdf } = await import('@/lib/payslipPdf');
      const finalizerName = p.finalized_by ? nameByUser.get(p.finalized_by) ?? null : null;
      const { proofNote } = await downloadPayslipPdf(
        p, () => (p.proof_path ? loadProof(p.proof_path) : Promise.resolve(null)), finalizerName,
        (path) => loadProof(path, advanceProofFileName(path)),
        () => (p.proof_path_2 ? loadProof(p.proof_path_2) : Promise.resolve(null)),
      );
      if (proofNote) toast.warning(proofNote);
    } catch {
      toast.error('The PDF could not be made. Try again.');
    } finally {
      setPdfBusy(false);
    }
  };

  // The 2nd proof-of-payment file, added after the payment was recorded (migration 20270205100000).
  const [proofBusy, setProofBusy] = useState(false);
  const addSecondProof = async (p: Payslip, f: File | null) => {
    if (!f) return;
    const problem = proofProblem(f);
    if (problem) { toast.error(problem); return; }
    setProofBusy(true);
    try {
      const path = proofPath(p.id, f.name);
      const { error: upErr } = await supabase.storage.from(PAYSLIP_PROOF_BUCKET)
        .upload(path, f, { cacheControl: '3600', upsert: false, contentType: proofContentType(f) || undefined });
      if (upErr) { toast.error('The 2nd proof did not upload. Try again.'); return; }
      try {
        await callRpc('attach_payslip_proof', { p_id: p.id, p_path: path });
        toast.success('2nd proof of payment added');
      } catch (e) {
        toast.error(`The 2nd proof was not added. ${refusal(e)}`);
      }
      refresh();
    } finally {
      setProofBusy(false);
    }
  };

  const viewingRow = viewing ? rows.find(r => r.profile.user_id === viewing) ?? null : null;
  const editingRow = editingDetails ? rows.find(r => r.profile.user_id === editingDetails) ?? null : null;
  const advancesRow = advancesFor ? rows.find(r => r.profile.user_id === advancesFor) ?? null : null;
  const detailsMissing = features.employee_id ? DETAILS_MISSING_WITH_ID : DETAILS_MISSING;
  const finalizeBlock = (r: StaffRow): string | null => {
    if (!canIssueForMonth(monthKey, features.from_april)) {
      return features.from_april ? 'Payslips start from April 2026.' : 'Payslips start from June 2026.';
    }
    if (!detailsComplete(r.details, features.employee_id)) return detailsMissing;
    if (!r.figures) return commission.isError ? 'Commission figures could not be loaded.' : 'Loading the figures…';
    const bond = draftBond(r, monthKey, features, false);
    if (bond.kind === 'blocked' && bond.firstMonth) {
      return `Finalize the ${longMonthLabel(bond.firstMonth)} payslip first — it holds the cash bond.`;
    }
    const adv = r.advances.filter(a => a.status === 'active').reduce((s, a) => s + a.amount_php, 0);
    if (adv > r.figures.total_php) return 'The cash advances are more than this month\'s earnings.';
    return null;
  };
  const confirmBond = confirmFinalize ? draftBond(confirmFinalize, monthKey, features, finalPay) : NO_BOND;
  const confirmBreakdown = confirmFinalize?.figures && (features.cash_advances || features.cash_bond)
    ? draftBreakdown(confirmFinalize.figures.total_php, confirmFinalize.advances, confirmBond) : null;

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
                      <td className="px-3 py-2">
                        {r.name}
                        {r.inactive && <span className="ml-1 text-xs text-muted-foreground">(inactive)</span>}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{TEMPLATE_LABEL[r.profile.template_type]}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{ts == null ? '—' : formatPeso(ts)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{cm == null ? '—' : formatPeso(cm)}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums text-primary">
                        {total == null ? '—' : formatPeso(total)}
                        {changed && <AlertTriangle className="ml-1 inline h-3.5 w-3.5 text-warning" aria-label="Figures changed" />}
                      </td>
                      <td className="px-3 py-2"><Badge variant={statusVariant(r.status)}>{STATUS_LABEL[r.status]}</Badge></td>
                      <td className="px-3 py-2 text-right">
                        {features.cash_advances && (
                          <Button size="sm" variant="ghost" onClick={() => setAdvancesFor(r.profile.user_id)}
                            data-testid="payslip-advances-open">
                            <Coins className="mr-1 h-4 w-4" /> Cash advances
                            {r.advances.some(a => a.status === 'active') && (
                              <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[10px]">
                                {r.advances.filter(a => a.status === 'active').length}
                              </Badge>
                            )}
                          </Button>
                        )}
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
              features={features}
              detailsMissing={detailsMissing}
              finalizeBlock={finalizeBlock(viewingRow)}
              onFinalize={() => { setFinalPay(false); setConfirmFinalize(viewingRow); }}
              onPay={(p) => setPaying(p)}
              onVoid={(p) => { setVoiding(p); setVoidReason(''); }}
              onProof={openProof}
              onDownloadProof={downloadProof}
              onDownloadPdf={downloadPdf}
              pdfBusy={pdfBusy}
              onAddSecondProof={addSecondProof}
              proofBusy={proofBusy}
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
              {confirmFinalize?.name}, {longLabel(monthKey)}: total {confirmFinalize?.figures ? formatPeso(confirmFinalize.figures.total_php) : '—'}
              {confirmBreakdown ? `, amount due ${formatPeso(confirmBreakdown.due)}` : ''}.
              The figures and staff details freeze. To change them later, void the payslip and issue a new one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {features.cash_bond && (
            <label className="flex items-start gap-2 rounded-md border border-border p-2 text-sm">
              <Checkbox checked={finalPay} onCheckedChange={v => setFinalPay(v === true)} data-testid="payslip-final-pay"
                aria-label="Final pay (staff leaving)" />
              <span>
                Final pay (staff leaving)
                <span className="block text-xs text-muted-foreground">Releases any cash bond on this payslip; no bond is held.</span>
                {confirmBond.kind === 'held' && (
                  <span className="block text-xs" data-testid="payslip-final-bond">Cash bond held: {formatPeso(confirmBond.held)}</span>
                )}
                {confirmBond.kind === 'released' && (
                  <span className="block text-xs" data-testid="payslip-final-bond">Cash bond released: {formatPeso(confirmBond.released)}</span>
                )}
              </span>
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={finalize.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={finalize.isPending}
              onClick={(e) => { e.preventDefault(); if (confirmFinalize) finalize.mutate({ row: confirmFinalize, finalPay }); }}
            >
              {finalize.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Finalize
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {paying && (
        <PaymentDialog
          payslip={paying}
          secondProof={features.second_proof}
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
        <StaffDetailsDialog rows={rows} features={features} onClose={() => setDetailsOpen(false)} onSaved={refresh} />
      )}

      {advancesRow && data && (
        <CashAdvancesDialog
          row={advancesRow}
          monthKey={monthKey}
          locked={!!advancesRow.payslip && advancesRow.payslip.status !== 'void'}
          secondProof={features.second_proof}
          onOpenProof={openProof}
          onClose={() => setAdvancesFor(null)}
          onChanged={refresh}
        />
      )}

      {/* One person's details (row action, or from a payslip blocked on missing details) */}
      <Dialog open={!!editingRow} onOpenChange={(o) => { if (!o) setEditingDetails(null); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit details</DialogTitle>
            <DialogDescription>
              {features.employee_id ? 'Employee ID, address and date of birth' : 'Address and date of birth'} print on the payslip.
              A finalized payslip keeps the details it was issued with.
            </DialogDescription>
          </DialogHeader>
          {editingRow && (
            <StaffDetailsRow
              key={editingRow.profile.user_id}
              row={editingRow}
              features={features}
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
  row, monthKey, features, detailsMissing, finalizeBlock, onFinalize, onPay, onVoid, onProof, onDownloadProof, onDownloadPdf,
  pdfBusy, onAddSecondProof, proofBusy, onEditDetails,
}: {
  row: StaffRow;
  monthKey: string;
  features: PayslipFeatures;
  detailsMissing: string;
  finalizeBlock: string | null;
  onFinalize: () => void;
  onPay: (p: Payslip) => void;
  onVoid: (p: Payslip) => void;
  onProof: (path: string) => void;
  onDownloadProof: (path: string) => void;
  onDownloadPdf: (p: Payslip) => void;
  pdfBusy: boolean;
  onAddSecondProof: (p: Payslip, f: File | null) => void;
  proofBusy: boolean;
  onEditDetails: () => void;
}) {
  const p = row.payslip;
  const issued = p && p.status !== 'void' ? p : null;
  const template: TemplateType = issued ? issued.template_type : row.profile.template_type;
  const tsSource = issued ? issued.timesheet : (row.figures?.timesheet as unknown as Record<string, unknown> | undefined);
  const cmSource = issued ? issued.commission : (row.figures?.commission as unknown as Record<string, unknown> | undefined);
  const total = issued ? issued.total_php : row.figures?.total_php;
  const changed = issued && row.figures ? figuresChanged(issued.total_php, row.figures.total_php) : false;
  // Advances, net pay, cash bond and amount due: from the snapshot when issued (payslips issued before the
  // migration have none), from live data for a draft once the database has the feature.
  const draftBondPreview = !issued ? draftBond(row, monthKey, features, false) : NO_BOND;
  const breakdown = issued
    ? storedBreakdown(issued)
    : (row.figures && (features.cash_advances || features.cash_bond)
      ? draftBreakdown(row.figures.total_php, row.advances, draftBondPreview) : null);
  const employeeId = issued ? issued.employee_id : row.details?.employee_id;
  const due = issued ? amountDue(issued) : null;

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
        ...((issued ? issued.employee_id : features.employee_id)
          ? [{ label: 'Employee ID', value: employeeId || '—' }] : []),
        { label: 'Address', value: (issued ? issued.address : row.details?.address) || '—' },
        { label: 'Date of birth', value: formatDate(issued ? issued.date_of_birth : row.details?.date_of_birth) },
        { label: 'Job title', value: (issued ? issued.job_title : row.profile.job_title) || '—' },
      ]} />

      {tsSource && cmSource ? (
        <>
          <Section title={`Timesheet — ${TEMPLATE_LABEL[template]}`} lines={timesheetLines(template, tsSource)} />
          <Section title="Commission" lines={commissionLines(cmSource)} />
          {breakdown ? (
            <>
              {(() => {
                const lines = breakdownLines(breakdown, issued?.status === 'paid');
                const last = lines[lines.length - 1];
                return (
                  <>
                    <Section title="Deductions and cash bond" lines={lines.slice(0, -1)} />
                    <div className="flex items-baseline justify-between rounded-md bg-primary/5 px-3 py-2 font-semibold"
                      data-testid="payslip-amount-due">
                      <span>{last.label}</span>
                      <span className="tabular-nums text-primary">{last.value}</span>
                    </div>
                  </>
                );
              })()}
              {!issued && draftBondPreview.kind === 'held' && (
                <p className="text-xs text-muted-foreground" data-testid="payslip-bond-note">First pay month — 50% held as cash bond</p>
              )}
            </>
          ) : (
            <div className="flex items-baseline justify-between rounded-md bg-primary/5 px-3 py-2 font-semibold">
              <span>Total</span>
              <span className="tabular-nums text-primary">{total == null ? '—' : formatPeso(total)}</span>
            </div>
          )}
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
          {due != null && figuresChanged(due, issued.php_received) && (
            <p className="text-xs">{differenceLabel(issued)}: {formatPeso(issued.php_received - due)}</p>
          )}
          {payslipProofPaths(issued).map((path, i, all) => {
            const part = all.length > 1 ? ` (${i + 1} of ${all.length})` : '';
            return (
              <div key={path} className="flex flex-wrap items-center gap-2" data-testid="payslip-proof">
                <Button size="sm" variant="link" className="h-auto p-0" onClick={() => onProof(path)}>
                  <Paperclip className="mr-1 h-3.5 w-3.5" /> Open proof of payment{part}
                </Button>
                <Button size="sm" variant="outline" onClick={() => onDownloadProof(path)}>
                  <Download className="mr-1 h-3.5 w-3.5" /> Download proof{part}
                </Button>
              </div>
            );
          })}
          {features.second_proof && issued.proof_path && !issued.proof_path_2 && (
            <label className={`inline-flex items-center text-xs text-primary underline-offset-2 ${proofBusy ? 'opacity-50' : 'cursor-pointer hover:underline'}`}
              data-testid="payslip-add-second-proof">
              {proofBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Paperclip className="mr-1 h-3.5 w-3.5" />}
              Add 2nd proof
              <input type="file" className="sr-only" aria-label="Add 2nd proof of payment" disabled={proofBusy}
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
                onChange={(e) => { onAddSecondProof(issued, e.target.files?.[0] ?? null); e.target.value = ''; }} />
            </label>
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
                {finalizeBlock === detailsMissing && (
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
  payslip, secondProof, onClose, onSaved,
}: {
  payslip: Payslip;
  /** The database takes a 2nd proof file (migration 20270205100000). */
  secondProof: boolean;
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
  // What the staff member receives: amount due (after advances and cash bond), else net pay, else total.
  const due = amountDue(payslip);
  const [jpySent, setJpySent] = useState('');
  const [jpyTyped, setJpyTyped] = useState(false);
  useEffect(() => {
    const r = market.data?.php_per_jpy;
    if (r && !jpyTyped) setJpySent(String(defaultYenSent(due, r) ?? ''));
  }, [market.data, jpyTyped, due]);
  const [phpReceived, setPhpReceived] = useState(() => String(due));
  const [paidOn, setPaidOn] = useState(() => todayTokyo());
  const [file, setFile] = useState<File | null>(null);
  const [file2, setFile2] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const formError = validatePayment({ jpySent, phpReceived, paidOn }, payslip.pay_month);
  const fileError = proofProblem(file) ?? (file2 ? proofProblem(file2) : null);
  const rateUsed = actualRate(Number(phpReceived), Number(jpySent));

  const save = async () => {
    if (formError || fileError || !file) return;
    setSaving(true);
    try {
      const path = proofPath(payslip.id, file.name);
      const { error: upErr } = await supabase.storage.from(PAYSLIP_PROOF_BUCKET)
        .upload(path, file, { cacheControl: '3600', upsert: false, contentType: proofContentType(file) || undefined });
      if (upErr) { toast.error('The proof of payment did not upload. Try again.'); return; }
      let path2: string | null = null;
      if (secondProof && file2) {
        // +1 ms keeps the two paths different even for two files with the same name.
        path2 = proofPath(payslip.id, file2.name, Date.now() + 1);
        const { error: upErr2 } = await supabase.storage.from(PAYSLIP_PROOF_BUCKET)
          .upload(path2, file2, { cacheControl: '3600', upsert: false, contentType: proofContentType(file2) || undefined });
        if (upErr2) { toast.error('The 2nd proof file did not upload. Try again.'); return; }
      }
      try {
        await callRpc('record_payslip_payment', {
          p_id: payslip.id, p_jpy_sent: Number(jpySent), p_php_received: Number(phpReceived),
          p_paid_on: paidOn, p_proof_path: path,
          ...(secondProof ? { p_proof_path_2: path2 } : {}),
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
            {payslip.staff_name}, {longLabel(payslip.pay_month)}. {payslip.amount_due_php != null
              ? `Amount due ${formatPeso(due)}` : `Payslip total ${formatPeso(payslip.total_php)}`}.
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
          {secondProof && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="payslip-proof-2">Proof of payment (2nd file, optional)</Label>
              <Input id="payslip-proof-2" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
                onChange={(e) => setFile2(e.target.files?.[0] ?? null)} />
            </div>
          )}
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
          {Number(phpReceived) > 0 && Math.abs(Number(phpReceived) - due) >= 0.005 && (
            <p>{differenceLabel(payslip)}: {formatPeso(Number(phpReceived) - due)}</p>
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

function StaffDetailsDialog({ rows, features, onClose, onSaved }: {
  rows: StaffRow[]; features: PayslipFeatures; onClose: () => void; onSaved: () => void;
}) {
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
          {rows.map(r => <StaffDetailsRow key={r.profile.user_id} row={r} features={features} onSaved={onSaved} />)}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StaffDetailsRow({ row, features, onSaved }: { row: StaffRow; features: PayslipFeatures; onSaved: () => void }) {
  const [address, setAddress] = useState(row.details?.address ?? '');
  const [dob, setDob] = useState(row.details?.date_of_birth ?? '');
  const [employeeId, setEmployeeId] = useState(row.details?.employee_id ?? '');
  const [hireDate, setHireDate] = useState(row.details?.hire_date ?? '');
  const withId = features.employee_id;
  const error = validateDetails(address, dob) ?? (withId ? validateEmployeeDetails(employeeId, hireDate) : null);
  const dirty = address.trim() !== (row.details?.address ?? '') || dob !== (row.details?.date_of_birth ?? '')
    || (withId && (employeeId.trim() !== (row.details?.employee_id ?? '') || hireDate !== (row.details?.hire_date ?? '')));

  const save = useMutation({
    // The 5-argument save (employee ID + hire date) exists only once the database has the feature.
    mutationFn: () => callRpc('save_staff_payroll_details', {
      p_user_id: row.profile.user_id, p_address: address.trim(), p_date_of_birth: dob || null,
      ...(withId ? { p_employee_id: employeeId.trim(), p_hire_date: hireDate || null } : {}),
    }),
    onSuccess: () => { toast.success(`Saved details for ${row.name}`); onSaved(); },
    onError: (e) => toast.error(refusal(e)),
  });

  const id = row.profile.user_id;
  return (
    <div className="space-y-2 rounded-md border border-border p-3" data-testid="payslip-details-row">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{row.name}</p>
        {!detailsComplete(row.details, withId) && <Badge variant="outline">Missing</Badge>}
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
      {withId && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`emp-${id}`} className="text-xs">Employee ID (required to finalize)</Label>
            <Input id={`emp-${id}`} value={employeeId} maxLength={30} onChange={(e) => setEmployeeId(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`hire-${id}`} className="text-xs">Hire date (optional)</Label>
            <Input id={`hire-${id}`} type="date" value={hireDate} min="2020-01-01" onChange={(e) => setHireDate(e.target.value)} />
          </div>
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        {error && <span className="text-xs text-destructive">{error}</span>}
        <Button size="sm" disabled={!dirty || !!error || save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Save
        </Button>
      </div>
    </div>
  );
}

// ── Cash advances (owner 2026-10-27; migration 20270204100000) ─────────────

function CashAdvancesDialog({
  row, monthKey, locked, secondProof, onOpenProof, onClose, onChanged,
}: {
  row: StaffRow;
  monthKey: string;
  /** A non-void payslip exists for the month: advances are read-only. */
  locked: boolean;
  /** Each advance takes a 2nd proof file (migration 20270205100000). */
  secondProof: boolean;
  onOpenProof: (path: string) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const today = todayTokyo();
  const [advanceDate, setAdvanceDate] = useState(today);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [file2, setFile2] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');

  const formError = validateAdvance({ advanceDate, amount, note }, today);
  const fileError = (file ? proofProblem(file) : null) ?? (file2 ? proofProblem(file2) : null);
  const activeTotal = row.advances.filter(a => a.status === 'active').reduce((s, a) => s + a.amount_php, 0);

  /** Upload, then attach; false (with a toast) when either step fails — the advance itself stays. */
  const attach = async (advanceId: string, f: File, now: number = Date.now()): Promise<boolean> => {
    const path = advanceProofPath(advanceId, f.name, now);
    const { error: upErr } = await supabase.storage.from(PAYSLIP_PROOF_BUCKET)
      .upload(path, f, { cacheControl: '3600', upsert: false, contentType: proofContentType(f) || undefined });
    if (!upErr) {
      try {
        await callRpc('attach_cash_advance_proof', { p_id: advanceId, p_path: path });
        return true;
      } catch { /* falls through to the message below */ }
    }
    toast.error('The advance is saved, but its proof did not upload. Use Attach proof to try again.');
    return false;
  };

  const add = async () => {
    if (formError || fileError) return;
    setSaving(true);
    try {
      let id: string;
      try {
        const out = await callRpc('add_cash_advance', {
          p_user_id: row.profile.user_id, p_pay_month: `${monthKey}-01`, p_advance_date: advanceDate,
          p_amount_php: Number(amount), p_note: note.trim(),
        });
        id = String((out.advance as { id?: string } | undefined)?.id ?? '');
      } catch (e) {
        toast.error(refusal(e));
        return;
      }
      const files = [file, secondProof ? file2 : null].filter((f): f is File => !!f);
      if (files.length && id) {
        let ok = true;
        // One at a time: the 1st fills slot 1, the 2nd slot 2 (+i ms keeps same-named files apart).
        for (const [i, f] of files.entries()) ok = (await attach(id, f, Date.now() + i)) && ok;
        if (ok) toast.success(files.length > 1 ? 'Cash advance added with its 2 proofs' : 'Cash advance added with its proof');
      } else {
        toast.success('Cash advance added');
      }
      setAmount(''); setNote(''); setFile(null); setFile2(null); setAdvanceDate(today);
      onChanged();
    } finally {
      setSaving(false);
    }
  };

  const attachLater = async (advanceId: string, f: File | null) => {
    if (!f) return;
    const problem = proofProblem(f);
    if (problem) { toast.error(problem); return; }
    setSaving(true);
    try {
      if (await attach(advanceId, f)) toast.success('Proof attached');
      onChanged();
    } finally {
      setSaving(false);
    }
  };

  const voidAdvance = async () => {
    if (!voidingId || voidReason.trim().length < 3) return;
    setSaving(true);
    try {
      await callRpc('void_cash_advance', { p_id: voidingId, p_reason: voidReason.trim() });
      toast.success('Cash advance voided');
      setVoidingId(null); setVoidReason('');
      onChanged();
    } catch (e) {
      toast.error(refusal(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !saving) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" data-testid="cash-advances-dialog">
        <DialogHeader>
          <DialogTitle>Cash advances — {row.name}, {longLabel(monthKey)}</DialogTitle>
          <DialogDescription>
            Each active advance is deducted on this month's payslip (total earnings − cash advances = net pay).
            A mistake is voided with a reason, never deleted.
          </DialogDescription>
        </DialogHeader>

        {locked && (
          <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground" data-testid="cash-advances-locked">
            This month's payslip is finalized — void it to change advances
          </p>
        )}

        {row.advances.length === 0 ? (
          <p className="text-sm text-muted-foreground">No cash advances this month.</p>
        ) : (
          <div className="space-y-2">
            {row.advances.map(a => (
              <div key={a.id} className="space-y-1 rounded-md border border-border p-2 text-sm" data-testid="cash-advance-row">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="tabular-nums">{formatDateDD(a.advance_date)}</span>
                  <span className={a.status === 'void' ? 'tabular-nums text-muted-foreground line-through' : 'tabular-nums font-medium'}>
                    {formatPeso(a.amount_php)}
                  </span>
                </div>
                <p className="text-muted-foreground">{a.note}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={a.status === 'void' ? 'outline' : 'secondary'}>{a.status === 'void' ? 'Void' : 'Active'}</Badge>
                  {a.status === 'void' && a.void_reason && <span className="text-xs text-muted-foreground">{a.void_reason}</span>}
                  {advanceProofPaths(a).map((path, i, all) => (
                    <Button key={path} size="sm" variant="link" className="h-auto p-0" onClick={() => onOpenProof(path)}>
                      <Paperclip className="mr-1 h-3.5 w-3.5" /> Open proof{all.length > 1 ? ` ${i + 1}` : ''}
                    </Button>
                  ))}
                  {!locked && a.status === 'active' && advanceProofSlotFree(a, secondProof) && (
                    <label className="cursor-pointer text-xs text-primary underline-offset-2 hover:underline">
                      {a.proof_path ? 'Attach 2nd proof' : 'Attach proof'}
                      <input type="file" className="sr-only"
                        aria-label={a.proof_path ? `Attach 2nd proof for ${a.note}` : `Attach proof for ${a.note}`}
                        accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
                        onChange={(e) => attachLater(a.id, e.target.files?.[0] ?? null)} />
                    </label>
                  )}
                  {!locked && a.status === 'active' && (
                    <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={() => { setVoidingId(a.id); setVoidReason(''); }}>
                      <Ban className="mr-1 h-3.5 w-3.5" /> Void
                    </Button>
                  )}
                </div>
                {voidingId === a.id && (
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-[12rem] flex-1 space-y-1">
                      <Label htmlFor={`void-${a.id}`} className="text-xs">Reason</Label>
                      <Input id={`void-${a.id}`} value={voidReason} maxLength={500} onChange={(e) => setVoidReason(e.target.value)} />
                    </div>
                    <Button size="sm" variant="destructive" disabled={voidReason.trim().length < 3 || saving} onClick={voidAdvance}>
                      Void advance
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setVoidingId(null)}>Cancel</Button>
                  </div>
                )}
              </div>
            ))}
            <p className="text-right text-sm font-medium" data-testid="cash-advances-total">
              Total active advances {formatPeso(activeTotal)}
            </p>
          </div>
        )}

        {!locked && (
          <div className="space-y-2 rounded-md border border-border p-3">
            <p className="text-sm font-medium">Add advance</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="advance-date" className="text-xs">Date</Label>
                <Input id="advance-date" type="date" value={advanceDate} min={advanceDateMin(today)} max={today}
                  onChange={(e) => setAdvanceDate(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="advance-amount" className="text-xs">Amount (₱)</Label>
                <Input id="advance-amount" inputMode="decimal" value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="advance-note" className="text-xs">Note</Label>
              <Input id="advance-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="advance-proof" className="text-xs">Proof (optional — photo or PDF, up to 10 MB)</Label>
              <Input id="advance-proof" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
            {secondProof && (
              <div className="space-y-1">
                <Label htmlFor="advance-proof-2" className="text-xs">2nd proof (optional)</Label>
                <Input id="advance-proof-2" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
                  onChange={(e) => setFile2(e.target.files?.[0] ?? null)} />
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              {(amount || note) && (formError || fileError) && (
                <span className="text-xs text-destructive">{formError ?? fileError}</span>
              )}
              <Button size="sm" onClick={add} disabled={!!formError || !!fileError || saving} data-testid="cash-advance-add">
                {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Add advance
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
