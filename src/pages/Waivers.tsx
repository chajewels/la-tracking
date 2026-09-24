import { useState } from 'react';
import { CheckCircle, XCircle, Clock, Eye, ChevronDown, ChevronUp, Undo2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MUTATION_INVALIDATION_KEYS } from '@/lib/business-rules';
import TypedConfirmField from '@/components/forms/TypedConfirmField';
import DataTable, { type DataTableColumn } from '@/components/data-table/DataTable';
import StatusPill from '@/components/shared/StatusPill';
import { PENALTY_STATUS_TONE, WAIVER_STATUS_LABEL, WAIVER_STATUS_TONE } from '@/components/shared/status-tone';
import IllustratedState, { LedgerIllustration } from '@/components/shared/LedgerIllustration';
import DecoDialogHeader, { decoTitleClass } from '@/components/shared/DecoDialogHeader';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

interface WaiverRow {
  id: string;
  account_id: string;
  schedule_id: string;
  penalty_fee_id: string;
  penalty_amount: number;
  reason: string;
  status: string;
  created_at: string;
  requested_by_user_id: string;
  approved_by_user_id: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  layaway_accounts: {
    id: string;
    invoice_number: string;
    currency: string;
    customer_id: string;
    customers: { full_name: string };
  };
  penalty_fees: {
    id: string;
    penalty_stage: string;
    penalty_cycle: number;
    penalty_amount: number;
    penalty_date: string;
    status: string;
  };
}

const statusConfig = {
  pending: { icon: Clock, label: 'Pending', className: 'bg-warning/10 text-warning border-warning/20' },
  approved: { icon: CheckCircle, label: 'Approved', className: 'bg-success/10 text-success border-success/20' },
  rejected: { icon: XCircle, label: 'Rejected', className: 'bg-destructive/10 text-destructive border-destructive/20' },
  auto_unwaived: { icon: Undo2, label: WAIVER_STATUS_LABEL.auto_unwaived, className: 'bg-muted text-muted-foreground border-border' },
} as const;

type FilterStatus = 'pending' | 'all';

// Group waivers by account for batch view
interface WaiverGroup {
  accountId: string;
  invoiceNumber: string;
  customerName: string;
  currency: Currency;
  waivers: WaiverRow[];
  totalAmount: number;
}

function groupWaivers(waivers: WaiverRow[]): WaiverGroup[] {
  const map = new Map<string, WaiverGroup>();
  for (const w of waivers) {
    const acc = w.layaway_accounts;
    const key = w.account_id;
    if (!map.has(key)) {
      map.set(key, {
        accountId: key,
        invoiceNumber: acc?.invoice_number || '—',
        customerName: acc?.customers?.full_name || '—',
        currency: (acc?.currency || 'PHP') as Currency,
        waivers: [],
        totalAmount: 0,
      });
    }
    const group = map.get(key)!;
    group.waivers.push(w);
    group.totalAmount += Number(w.penalty_amount);
  }
  return [...map.values()].sort((a, b) => b.totalAmount - a.totalAmount);
}

export default function Waivers({ embedded = false, search = '' }: { embedded?: boolean; search?: string } = {}) {
  const { user } = useAuth();
  const { can } = usePermissions();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<FilterStatus>('pending');
  const [actionDialog, setActionDialog] = useState<{ group: WaiverGroup; action: 'approve' | 'reject' } | null>(null);
  const [approveArmed, setApproveArmed] = useState(false);
  const [selectedWaiverIds, setSelectedWaiverIds] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [unwaiveTarget, setUnwaiveTarget] = useState<{ waiver: WaiverRow; group: WaiverGroup } | null>(null);
  const [unwaiving, setUnwaiving] = useState(false);

  const handleUnwaive = async () => {
    if (!unwaiveTarget) return;
    const { waiver } = unwaiveTarget;
    setUnwaiving(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { data: fnData, error: fnErr } = await supabase.functions.invoke('unwaive-waiver', {
        body: { waiver_id: waiver.id },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (fnErr || fnData?.error) {
        throw new Error(fnData?.error || fnErr?.message || 'Unwaive failed');
      }

      toast.success('Penalty unwaived — waiver returned to pending, account balance updated');
      for (const key of MUTATION_INVALIDATION_KEYS) qc.invalidateQueries({ queryKey: [key] });
      qc.invalidateQueries({ queryKey: ['waivers-page'] });
      setUnwaiveTarget(null);
    } catch (err: any) {
      toast.error(err.message || 'Unwaive failed');
    } finally {
      setUnwaiving(false);
    }
  };

  const { data: waivers, isLoading } = useQuery({
    queryKey: ['waivers-page', filter],
    queryFn: async () => {
      let query = supabase
        .from('penalty_waiver_requests')
        .select('*, layaway_accounts(id, invoice_number, currency, customer_id, customers(full_name)), penalty_fees(id, penalty_stage, penalty_cycle, penalty_amount, penalty_date, status)')
        .order('created_at', { ascending: false });

      if (filter === 'pending') {
        query = query.eq('status', 'pending');
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as unknown as WaiverRow[];
    },
  });

  const allGroups = groupWaivers(waivers || []);
  // Search filter — match against customer name, invoice number, or any
  // waiver's reason. Empty search returns the full list.
  const groups = (() => {
    const q = search.trim().toLowerCase();
    if (!q) return allGroups;
    return allGroups.filter((g) => {
      if (g.customerName.toLowerCase().includes(q)) return true;
      if (String(g.invoiceNumber).toLowerCase().includes(q)) return true;
      return g.waivers.some((w) => (w.reason || '').toLowerCase().includes(q));
    });
  })();

  const toggleGroup = (accountId: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      next.has(accountId) ? next.delete(accountId) : next.add(accountId);
      return next;
    });
  };

  const openActionDialog = (group: WaiverGroup, action: 'approve' | 'reject') => {
    const pendingWaivers = group.waivers.filter(w => w.status === 'pending');
    // Only select waivers whose penalty is still unpaid (not already waived)
    const eligible = pendingWaivers.filter(w => w.penalty_fees?.status === 'unpaid');
    setSelectedWaiverIds(new Set(eligible.map(w => w.id)));
    setActionDialog({ group, action });
    setNotes('');
    setApproveArmed(false);
  };

  const toggleWaiverSelection = (id: string) => {
    setSelectedWaiverIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (!actionDialog) return;
    const eligible = actionDialog.group.waivers.filter(w => w.status === 'pending' && w.penalty_fees?.status === 'unpaid');
    setSelectedWaiverIds(new Set(eligible.map(w => w.id)));
  };

  const deselectAll = () => setSelectedWaiverIds(new Set());

  const selectedTotal = actionDialog
    ? actionDialog.group.waivers
        .filter(w => selectedWaiverIds.has(w.id))
        .reduce((s, w) => s + Number(w.penalty_amount), 0)
    : 0;

  const handleAction = async () => {
    if (!actionDialog || !user || selectedWaiverIds.size === 0) return;
    const { group, action } = actionDialog;
    setSubmitting(true);

    try {
      const selectedWaivers = group.waivers.filter(w => selectedWaiverIds.has(w.id));

      if (action === 'approve') {
        // Delegate all approval logic to the server-side edge function.
        // This ensures penalty_fees, layaway_schedule, and layaway_accounts
        // are always updated atomically regardless of which UI path is used.
        const { data: { session } } = await supabase.auth.getSession();
        const { data: fnData, error: fnErr } = await supabase.functions.invoke('approve-waiver', {
          body: {
            waiver_request_ids: selectedWaivers.map(w => w.id),
            notes: notes.trim() || undefined,
          },
          headers: { Authorization: `Bearer ${session?.access_token}` },
        });
        if (fnErr || fnData?.error) throw new Error(fnData?.error || fnErr?.message || 'Approval failed');

        toast.success(`${selectedWaivers.length} penalty waiver(s) approved — balances recalculated`);
      } else {
        // Reject selected waivers
        for (const waiver of selectedWaivers) {
          const { error: waiverErr } = await supabase
            .from('penalty_waiver_requests')
            .update({
              status: 'rejected' as any,
              rejected_at: new Date().toISOString(),
              approved_by_user_id: user.id,
            })
            .eq('id', waiver.id);
          if (waiverErr) throw waiverErr;
        }

        await supabase.from('audit_logs').insert({
          entity_type: 'penalty_waiver',
          entity_id: group.accountId,
          action: 'batch_waiver_rejected',
          performed_by_user_id: user.id,
          new_value_json: {
            waiver_ids: selectedWaivers.map(w => w.id),
            count: selectedWaivers.length,
            notes: notes.trim() || null,
          },
        });

        toast.success(`${selectedWaivers.length} waiver(s) rejected — no financial changes`);
      }

      for (const key of MUTATION_INVALIDATION_KEYS) {
        qc.invalidateQueries({ queryKey: [key] });
      }
      qc.invalidateQueries({ queryKey: ['waivers-page'] });

      setActionDialog(null);
      setNotes('');
      setSelectedWaiverIds(new Set());
    } catch (err: any) {
      toast.error(err.message || 'Action failed');
    } finally {
      setSubmitting(false);
    }
  };

  // Hub visual refresh (Phase 2B): desktop = ledger table of account groups
  // (click a row to open its penalties, several at once — as before); phones
  // = cards with a stacked penalty list. Same buttons, same gates.
  const isMobile = useIsMobile();
  const fmtDay = (d: string) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const expandedKeys = expandedGroups as ReadonlySet<string>;

  /** Approve / Reject / View Account — shown only while the group has pending
   *  waivers; Approve / Reject additionally need manage_waivers (unchanged). */
  const renderGroupActions = (group: WaiverGroup, pendingCount: number) => pendingCount > 0 && (
    <div className="flex items-center justify-end gap-1">
      {can('manage_waivers') && (
        <>
          <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs border-success/30 text-success hover:bg-success/10"
            onClick={e => { e.stopPropagation(); openActionDialog(group, 'approve'); }}>
            Approve
          </Button>
          <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs border-destructive/30 text-destructive hover:bg-destructive/10"
            onClick={e => { e.stopPropagation(); openActionDialog(group, 'reject'); }}>
            Reject
          </Button>
        </>
      )}
      <Link to={`/accounts/${group.accountId}`} onClick={e => e.stopPropagation()}>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-gold-300" title="View Account">
          <Eye className="h-3.5 w-3.5" />
        </Button>
      </Link>
    </div>
  );

  const waiverPill = (w: WaiverRow) => {
    const config = statusConfig[w.status as keyof typeof statusConfig] || statusConfig.pending;
    const tone = WAIVER_STATUS_TONE[w.status in statusConfig ? w.status : 'pending'] ?? 'warning';
    return <StatusPill label={config.label} tone={tone} />;
  };
  const penaltyPill = (w: WaiverRow) => {
    const st = w.penalty_fees?.status || 'unknown';
    return <StatusPill label={st.charAt(0).toUpperCase() + st.slice(1)} tone={PENALTY_STATUS_TONE[st] ?? 'danger'} />;
  };
  const unwaiveButton = (w: WaiverRow, group: WaiverGroup) => w.penalty_fees?.status === 'waived' && (
    <Button variant="outline" size="sm" className="h-6 text-[10px] gap-1 border-warning/30 text-warning hover:bg-warning/10"
      onClick={e => { e.stopPropagation(); setUnwaiveTarget({ waiver: w, group }); }}>
      <Undo2 className="h-3 w-3" /> Unwaive
    </Button>
  );

  /** The penalties inside a group (desktop: ledger sub-table). */
  const renderBreakdown = (group: WaiverGroup) => (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="hairline-b">
            {['Stage', 'Cycle', 'Date Applied', 'Amount', 'Penalty Status', 'Waiver Status', 'Reason', 'Requested', 'Actions'].map((h, i) => (
              <th key={h} className={cn('px-3 py-2 text-[10px] font-medium uppercase tracking-[0.12em] text-ink-muted whitespace-nowrap', i === 3 || i === 8 ? 'text-right' : 'text-left')}>
                {h === 'Actions' ? <span className="sr-only">Actions</span> : h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {group.waivers.map(w => {
            const pen = w.penalty_fees;
            return (
              <tr key={w.id}>
                <td className="px-3 py-2 text-card-foreground">{pen?.penalty_stage || '—'}</td>
                <td className="px-3 py-2 text-card-foreground">{pen?.penalty_cycle || '—'}</td>
                <td className="px-3 py-2 text-muted-foreground text-xs whitespace-nowrap">{pen?.penalty_date ? fmtDay(pen.penalty_date) : '—'}</td>
                <td className="px-3 py-2 text-right font-semibold text-danger tabular-nums whitespace-nowrap">{formatCurrency(Number(w.penalty_amount), group.currency)}</td>
                <td className="px-3 py-2">{penaltyPill(w)}</td>
                <td className="px-3 py-2">{waiverPill(w)}</td>
                <td className="px-3 py-2 max-w-[220px]">
                  <p className="text-xs text-card-foreground truncate" title={w.reason}>{w.reason}</p>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                  {new Date(w.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </td>
                <td className="px-3 py-2 text-right">{unwaiveButton(w, group)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const columns: DataTableColumn<WaiverGroup>[] = [
    {
      key: 'invoice',
      header: 'Invoice',
      cellClassName: 'whitespace-nowrap',
      cell: g => (
        <span className="font-deco text-base font-semibold text-champagne [font-variant-numeric:lining-nums_tabular-nums]">#{g.invoiceNumber}</span>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      cellClassName: 'max-w-[260px]',
      cell: g => <span className="block truncate text-sm text-card-foreground" title={g.customerName}>{g.customerName}</span>,
    },
    {
      key: 'penalties',
      header: 'Penalties',
      cellClassName: 'whitespace-nowrap',
      cell: g => <span className="text-xs text-muted-foreground">{g.waivers.length} penalt{g.waivers.length === 1 ? 'y' : 'ies'}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      cell: g => {
        const pending = g.waivers.filter(w => w.status === 'pending').length;
        return pending > 0
          ? <StatusPill label={`${pending} pending`} tone="warning" />
          : <StatusPill label="Reviewed" tone="muted" />;
      },
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      cell: g => <span className="font-semibold text-danger">{formatCurrency(g.totalAmount, g.currency)}</span>,
    },
    {
      key: 'actions',
      header: '',
      hideable: false,
      align: 'right',
      cellClassName: 'w-px',
      cell: g => renderGroupActions(g, g.waivers.filter(w => w.status === 'pending').length),
    },
  ];

  const content = (
    <>
      <div className={embedded ? 'space-y-5' : 'animate-fade-in space-y-6'}>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          {!embedded && (
            <div>
              <p className="label-caps text-[11px] text-gold-300 mb-1">Operations</p>
              <h1 className="font-deco text-3xl font-semibold tracking-tight text-champagne">Waiver Requests</h1>
              <p className="text-sm text-muted-foreground mt-1">Review and action pending penalty waiver requests with selective penalty control</p>
            </div>
          )}
          {/* Same segmented control as the Cash / Layaway filters. */}
          <div className="flex w-fit gap-1 rounded-lg border border-border p-1 bg-card">
            {([['pending', 'Pending'], ['all', 'All Requests']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap',
                  filter === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {value === 'pending' && <Clock className="h-3.5 w-3.5" />} {label}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 text-sm text-muted-foreground" role="status">
              <LedgerIllustration kind="ledger" className="h-8 w-10" />
              Opening the ledger…
            </div>
            <div className="space-y-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)}</div>
          </div>
        ) : groups.length === 0 ? (
          <IllustratedState
            kind="ledger"
            className="rounded-xl border border-gold-500/15 bg-card py-12"
            text={filter === 'pending' ? 'No pending waiver requests' : 'No waiver requests found'}
          />
        ) : !isMobile ? (
          <DataTable
            variant="ledger"
            showToolbar={false}
            columns={columns}
            rows={groups}
            rowKey={g => g.accountId}
            onRowClick={g => toggleGroup(g.accountId)}
            renderExpanded={renderBreakdown}
            expandedKeys={expandedKeys}
            onToggleExpanded={g => toggleGroup(g.accountId)}
            maxHeightClassName="max-h-[72vh]"
          />
        ) : (
          <div className="space-y-3">
            {groups.map(group => {
              const isExpanded = expandedGroups.has(group.accountId);
              const pendingCount = group.waivers.filter(w => w.status === 'pending').length;
              return (
                <div key={group.accountId} className="rounded-xl border border-gold-500/15 bg-card overflow-hidden">
                  <div
                    className="flex items-start gap-3 px-4 py-3 cursor-pointer"
                    onClick={() => toggleGroup(group.accountId)}
                  >
                    {isExpanded ? <ChevronUp className="h-4 w-4 mt-1 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 mt-1 shrink-0 text-muted-foreground" />}
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-deco text-lg font-semibold text-champagne">#{group.invoiceNumber}</span>
                        <span className="text-sm font-semibold text-danger tabular-nums whitespace-nowrap">{formatCurrency(group.totalAmount, group.currency)}</span>
                      </div>
                      <p className="truncate text-sm text-card-foreground" title={group.customerName}>{group.customerName}</p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">{group.waivers.length} penalt{group.waivers.length === 1 ? 'y' : 'ies'}</span>
                        {pendingCount > 0 ? <StatusPill label={`${pendingCount} pending`} tone="warning" /> : <StatusPill label="Reviewed" tone="muted" />}
                      </div>
                    </div>
                  </div>
                  {pendingCount > 0 && <div className="px-4 pb-3">{renderGroupActions(group, pendingCount)}</div>}
                  {isExpanded && (
                    <ul className="hairline-t divide-y divide-border/60">
                      {group.waivers.map(w => {
                        const pen = w.penalty_fees;
                        return (
                          <li key={w.id} className="px-4 py-3 space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-sm text-card-foreground">{pen?.penalty_stage || '—'} · Cycle {pen?.penalty_cycle || '—'}</span>
                              <span className="font-semibold text-danger tabular-nums">{formatCurrency(Number(w.penalty_amount), group.currency)}</span>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">{penaltyPill(w)}{waiverPill(w)}</div>
                            <p className="text-xs text-muted-foreground">
                              Applied {pen?.penalty_date ? fmtDay(pen.penalty_date) : '—'} · requested {new Date(w.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                            </p>
                            <p className="text-xs text-card-foreground break-words">{w.reason}</p>
                            {unwaiveButton(w, group)}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Selective Approve/Reject Dialog */}
      <Dialog open={!!actionDialog} onOpenChange={open => { if (!open) { setActionDialog(null); setSelectedWaiverIds(new Set()); } }}>
        <DialogContent className="bg-background border-gold-500/20 max-w-lg">
          <DialogHeader className="space-y-0">
            <DecoDialogHeader
              icon={actionDialog?.action === 'approve' ? <CheckCircle /> : <XCircle />}
              title={
                <DialogTitle className={decoTitleClass}>
                  {actionDialog?.action === 'approve' ? 'Approve Selected Penalties' : 'Reject Selected Waivers'}
                </DialogTitle>}
              description={
                <DialogDescription>
                  {actionDialog?.action === 'approve'
                    ? 'Select which penalties to waive. Only selected penalties will be removed.'
                    : 'Select which waiver requests to reject.'}
                </DialogDescription>}
            />
          </DialogHeader>
          {actionDialog && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  INV #{actionDialog.group.invoiceNumber} · {actionDialog.group.customerName}
                </p>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={selectAll}>Select All</Button>
                  <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={deselectAll}>Deselect All</Button>
                </div>
              </div>

              {/* Penalty selection checkboxes */}
              <div className="rounded-lg border border-gold-500/15 divide-y divide-border/60 max-h-60 overflow-y-auto">
                {actionDialog.group.waivers
                  .filter(w => w.status === 'pending')
                  .map(w => {
                    const pen = w.penalty_fees;
                    const isSelected = selectedWaiverIds.has(w.id);
                    const isAlreadyWaived = pen?.status === 'waived';
                    return (
                      <label
                        key={w.id}
                        className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors ${isSelected ? 'bg-primary/5' : 'hover:bg-muted/30'} ${isAlreadyWaived ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        <Checkbox
                          checked={isSelected}
                          disabled={isAlreadyWaived}
                          onCheckedChange={() => toggleWaiverSelection(w.id)}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-card-foreground">{pen?.penalty_stage} · Cycle {pen?.penalty_cycle}</span>
                            {isAlreadyWaived && <Badge variant="outline" className="text-[10px] bg-muted text-muted-foreground">Already Waived</Badge>}
                          </div>
                          <span className="text-[10px] text-muted-foreground">
                            Applied {pen?.penalty_date ? new Date(pen.penalty_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                          </span>
                        </div>
                        <span className="text-xs font-bold text-danger tabular-nums whitespace-nowrap">
                          {formatCurrency(Number(w.penalty_amount), actionDialog.group.currency)}
                        </span>
                      </label>
                    );
                  })}
              </div>

              {/* Summary */}
              <div className="rounded-lg border border-gold-500/15 bg-surface-1/60 p-3 flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {selectedWaiverIds.size} of {actionDialog.group.waivers.filter(w => w.status === 'pending').length} selected
                </span>
                <span className="text-sm font-bold text-card-foreground tabular-nums whitespace-nowrap">
                  {actionDialog.action === 'approve' ? 'Waive' : 'Reject'}: {formatCurrency(selectedTotal, actionDialog.group.currency)}
                </span>
              </div>

              <div className="space-y-2">
                <Label className="text-card-foreground text-xs">Notes (optional)</Label>
                <Textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder={actionDialog.action === 'approve' ? 'Approval notes...' : 'Rejection reason...'}
                  className="bg-background border-border resize-none text-sm"
                  rows={2}
                />
              </div>

              {/* Waiving penalties changes account balances — typed gate
                  around the EXISTING approve-waiver invocation only. */}
              {actionDialog.action === 'approve' && (
                <TypedConfirmField word="APPROVE" onArmedChange={setApproveArmed} />
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setActionDialog(null); setSelectedWaiverIds(new Set()); }}>Cancel</Button>
            <Button
              onClick={handleAction}
              disabled={submitting || selectedWaiverIds.size === 0 || (actionDialog?.action === 'approve' && !approveArmed)}
              className={actionDialog?.action === 'approve'
                ? 'bg-success text-success-foreground hover:bg-success/90'
                : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'}
            >
              {submitting ? 'Processing…' : `${actionDialog?.action === 'approve' ? 'Approve' : 'Reject'} ${selectedWaiverIds.size} Selected`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unwaive Confirmation Dialog */}
      <Dialog open={!!unwaiveTarget} onOpenChange={open => { if (!open) setUnwaiveTarget(null); }}>
        <DialogContent className="bg-background border-gold-500/20 max-w-sm">
          <DialogHeader className="space-y-0">
            <DecoDialogHeader
              icon={<Undo2 />}
              title={<DialogTitle className={decoTitleClass}>Unwaive Penalty</DialogTitle>}
              description={
                <DialogDescription>
                  Are you sure you want to unwaive this penalty? The account balance will be restored.
                </DialogDescription>}
            />
          </DialogHeader>
          {unwaiveTarget && (
            <div className="rounded-lg border border-gold-500/15 bg-surface-1/60 p-3 text-xs space-y-1">
              <div className="flex justify-between"><span className="text-muted-foreground">Invoice</span><span className="font-mono font-medium text-card-foreground">#{unwaiveTarget.group.invoiceNumber}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Penalty</span><span className="text-card-foreground">{unwaiveTarget.waiver.penalty_fees?.penalty_stage} · Cycle {unwaiveTarget.waiver.penalty_fees?.penalty_cycle}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span className="font-bold text-danger tabular-nums">{formatCurrency(Number(unwaiveTarget.waiver.penalty_amount), unwaiveTarget.group.currency)}</span></div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnwaiveTarget(null)} disabled={unwaiving}>Cancel</Button>
            <Button onClick={handleUnwaive} disabled={unwaiving} className="bg-warning text-warning-foreground hover:bg-warning/90">
              {unwaiving ? 'Processing…' : 'Confirm Unwaive'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  return embedded ? content : <AppLayout>{content}</AppLayout>;
}
