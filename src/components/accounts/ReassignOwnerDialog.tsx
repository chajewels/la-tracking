import { useEffect, useMemo, useState } from 'react';
import { UserRoundCog, Search, ArrowRight, AlertTriangle, CheckCircle2, Sparkles, ShieldAlert } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { useCustomers } from '@/hooks/use-supabase-data';
import { useOrderLoyaltyAward } from '@/hooks/useOrderLoyaltyAward';
import { usePermissions } from '@/contexts/PermissionsContext';
import LoyaltyAmountField from '@/components/loyalty/LoyaltyAmountField';
import { supabase } from '@/integrations/supabase/client';
import { matchedOnText, movedList } from '@/lib/reassign-owner-labels';
import { toast } from 'sonner';
import { useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * Reassign Owner — layaway plans AND cash orders (CLAUDE.md "REASSIGN OWNER").
 * Every decision is made server-side by reassign_order_owner_atomic through
 * the reassign-order-owner edge function; this dialog only collects the
 * inputs, shows the preview (apply:false) and then confirms (apply:true).
 * It never writes customer_id itself — the DB now refuses a browser write.
 */

type Kind = 'layaway' | 'cash';

interface Props {
  kind: Kind;
  orderId: string;
  invoiceNumber: string;
  currentCustomerId: string;
  currentCustomerName: string;
  status: string;
  loyaltyJpyAmount: number | null;
  /** (total − shipping) in JPY, for the "Use ¥Y" hint. null hides it. */
  suggestedLoyaltyJpy?: number | null;
}

interface Side {
  customer_id: string;
  full_name: string;
  enrolled: boolean;
  tier: string | null;
  points: number;
  spend_jpy: number;
  has_points: boolean;
}

interface Preview {
  ok: boolean;
  applied: boolean;
  error?: string;
  message?: string;
  invoice_number: string;
  order_date: string;
  current: Side;
  target: Side & { enrolled_at: string | null };
  refusals: { code: string; message: string }[];
  can_apply: boolean;
  /** R11 — identity fields the target shares with the current owner. */
  matched_on: string[];
  /** R11 — true when nothing matched (a different customer). */
  unmatched: boolean;
  loyalty_jpy_amount: { stored: number | null; effective: number | null; changes: boolean };
  award_point: { at: string | null; source: string | null };
  catch_up: {
    eligible: boolean;
    reason: 'eligible' | 'not_enrolled' | 'not_at_award_point' | 'paid_before_enrollment';
    grace_days: number;
    expected_points: number;
    below_minimum: boolean;
    expired_on_award: boolean;
    lot_expires_on: string;
    loyalty_enabled: boolean;
  };
  child_rows: Record<string, number>;
  award?: { outcome: 'awarded' | 'benign_skip' | 'failed'; points_earned?: number; failure?: string; reason?: string } | null;
}

const CLOSED: Record<Kind, string[]> = {
  layaway: ['cancelled', 'forfeited', 'final_forfeited'],
  cash: ['cancelled', 'expired'],
};

const yen = (n: number) => `¥${Math.round(n).toLocaleString('en-US')}`;
const pts = (n: number) => `${Math.round(n).toLocaleString('en-US')} pt`;

async function callReassign(body: Record<string, unknown>): Promise<Preview> {
  const { data, error } = await supabase.functions.invoke('reassign-order-owner', { body });
  if (error) {
    const payload = await (error as { context?: Response }).context?.json?.().catch(() => null);
    if (payload && typeof payload === 'object') return payload as Preview;
    throw error;
  }
  return data as Preview;
}

function catchUpText(p: Preview): string {
  const name = p.target.full_name;
  const c = p.catch_up;
  switch (c.reason) {
    case 'not_enrolled':
      return `No catch-up: ${name} is not a loyalty member.`;
    case 'not_at_award_point':
      return `No catch-up now: the order has not reached its award point yet. It will earn for ${name} as usual when it does.`;
    case 'paid_before_enrollment':
      return `No catch-up: paid before ${name} enrolled.`;
    default:
      if (!c.loyalty_enabled) return `Catch-up is due, but the loyalty program is switched off, so no points will be awarded.`;
      if (c.below_minimum) return `Catch-up is due, but the loyalty amount is under ¥10,000, so it earns no points.`;
      return c.expired_on_award
        ? `Will earn ${pts(c.expected_points)} for ${name} — but the points will be born expired (order date + 180 days, ${c.lot_expires_on}, has passed). The spend still counts toward ${name}'s tier.`
        : `Will earn ${pts(c.expected_points)} for ${name} (expiring ${c.lot_expires_on}).`;
  }
}

function SideCard({ title, side }: { title: string; side: Side }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1 min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{title}</p>
      <p className="text-sm font-medium text-card-foreground truncate">{side.full_name}</p>
      {side.enrolled ? (
        <div className="text-xs text-muted-foreground space-y-0.5 tabular-nums">
          <p>Tier: <span className="text-card-foreground">{side.tier ?? '—'}</span></p>
          <p>Points: <span className="text-card-foreground">{pts(side.points)}</span></p>
          <p>Spend: <span className="text-card-foreground">{yen(side.spend_jpy)}</span></p>
          {side.has_points && <p className="text-warning">Has loyalty history</p>}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Not a loyalty member</p>
      )}
    </div>
  );
}

export default function ReassignOwnerDialog({
  kind, orderId, invoiceNumber, currentCustomerId, currentCustomerName, status, loyaltyJpyAmount, suggestedLoyaltyJpy = null,
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [loyaltyInput, setLoyaltyInput] = useState(loyaltyJpyAmount ? String(loyaltyJpyAmount) : '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [done, setDone] = useState<Preview | null>(null);
  /** R11 override: the wrong-customer confirmation box, and the override
   *  flag the preview on screen was computed with (they must agree before
   *  Confirm is enabled, so what is shown is what will be applied). */
  const [overrideTicked, setOverrideTicked] = useState(false);
  const [previewOverride, setPreviewOverride] = useState(false);

  const { can } = usePermissions();
  const canEditLoyalty = can('edit_loyalty_amount');
  const canOverride = can('reassign_owner_unmatched');
  const { data: customers } = useCustomers();
  const { data: award, isLoading: awardLoading } = useOrderLoyaltyAward(kind, orderId, open);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (open) return;
    setSearch(''); setSelected(null); setReason(''); setPreview(null); setDone(null);
    setOverrideTicked(false); setPreviewOverride(false);
    setLoyaltyInput(loyaltyJpyAmount ? String(loyaltyJpyAmount) : '');
  }, [open, loyaltyJpyAmount]);

  const currentIsTest = customers?.find(c => c.id === currentCustomerId)?.is_test === true;

  const filtered = useMemo(() => {
    if (!customers) return [];
    const q = search.toLowerCase();
    return customers
      .filter(c => c.id !== currentCustomerId)
      .filter(c => (c.is_test === true) === currentIsTest)
      .filter(c =>
        c.full_name.toLowerCase().includes(q) ||
        (c.customer_code || '').toLowerCase().includes(q) ||
        (c.facebook_name || '').toLowerCase().includes(q)
      )
      .sort((a, b) => a.full_name.localeCompare(b.full_name))
      .slice(0, 20);
  }, [customers, search, currentCustomerId, currentIsTest]);

  const candidateIds = filtered.map(c => c.id);
  const { data: loyaltyByCustomer } = useQuery({
    queryKey: ['reassign-candidate-loyalty', candidateIds],
    enabled: open && candidateIds.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('loyalty_members')
        .select('customer_id, remaining_points, cumulative_spend_jpy, current_tier:current_tier_id(name)')
        .in('customer_id', candidateIds);
      if (error) throw error;
      const map = new Map<string, { tier: string | null; points: number; spend: number }>();
      for (const r of (data ?? []) as unknown as { customer_id: string; remaining_points: number | null; cumulative_spend_jpy: number | null; current_tier: { name: string } | null }[]) {
        map.set(r.customer_id, {
          tier: r.current_tier?.name ?? null,
          points: Number(r.remaining_points ?? 0),
          spend: Number(r.cumulative_spend_jpy ?? 0),
        });
      }
      return map;
    },
  });

  const selectedCustomer = customers?.find(c => c.id === selected);
  const loyaltyValue = loyaltyInput.trim() === '' ? null : Number(loyaltyInput);
  const loyaltyOk = loyaltyValue !== null && loyaltyValue > 0;
  const loyaltyChanged = loyaltyValue !== (loyaltyJpyAmount ?? null);
  const closed = CLOSED[kind].includes(status);

  const body = (apply: boolean, override: boolean) => ({
    kind,
    order_id: orderId,
    new_customer_id: selected,
    reason: reason.trim(),
    apply,
    ...(override ? { override: true } : {}),
    ...(loyaltyChanged && loyaltyValue !== null ? { loyalty_jpy_amount: loyaltyValue } : {}),
  });

  const runPreview = async (override = false) => {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await callReassign(body(false, override));
      if (!res.refusals) {
        toast.error(res.message || res.error || 'Preview failed');
        return;
      }
      setPreview(res);
      setPreviewOverride(override);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setBusy(false);
    }
  };

  // Ticking or unticking the wrong-customer box re-runs the preview with the
  // matching override flag, so the result on screen is the one Confirm applies.
  const toggleOverride = (checked: boolean) => {
    setOverrideTicked(checked);
    void runPreview(checked);
  };

  const runApply = async () => {
    setBusy(true);
    try {
      const res = await callReassign(body(true, previewOverride));
      if (!res.ok || !res.applied) {
        toast.error(res.message || res.error || 'Reassign failed');
        if (res.refusals) setPreview(res);
        return;
      }
      setDone(res);
      toast.success(`Inv# ${invoiceNumber} moved to ${res.target.full_name}`);
      if (kind === 'layaway') {
        queryClient.invalidateQueries({ queryKey: ['account', orderId] });
        queryClient.invalidateQueries({ queryKey: ['accounts'] });
      } else {
        queryClient.invalidateQueries({ queryKey: ['cash-order', orderId] });
        queryClient.invalidateQueries({ queryKey: ['cash-orders'] });
        queryClient.invalidateQueries({ queryKey: ['cash-submissions', orderId] });
      }
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      queryClient.invalidateQueries({ queryKey: ['customer-detail'] });
      queryClient.invalidateQueries({ queryKey: ['order-loyalty-award'] });
      queryClient.invalidateQueries({ queryKey: ['customer-loyalty-tier'] });
      queryClient.invalidateQueries({ queryKey: ['pending-submissions-summary'] });
      queryClient.invalidateQueries({ queryKey: ['pending-submission-count'] });
      queryClient.invalidateQueries({ queryKey: ['payment-submissions'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Reassign failed');
    } finally {
      setBusy(false);
    }
  };

  // R11. With the override permission, a no-match is not shown as a red
  // refusal: it becomes the amber wrong-customer block below. Every other
  // refusal stays red — the override bypasses R11 only.
  const overrideOffered = !!preview?.unmatched && canOverride;
  const shownRefusals = (preview?.refusals ?? []).filter(
    r => !(overrideOffered && r.code === 'different_customer_details'),
  );
  const matchedText = matchedOnText(preview?.matched_on);
  const confirmEnabled = !!preview && !busy && preview.can_apply
    && (!overrideOffered || (overrideTicked && previewOverride));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="border-primary/30 text-primary hover:bg-primary/10">
          <UserRoundCog className="h-4 w-4 mr-1.5" /> Reassign Owner
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto grid-cols-[minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle className="font-display">Reassign {kind === 'layaway' ? 'Plan' : 'Order'} Owner</DialogTitle>
          <DialogDescription>
            Inv# <span className="font-medium text-foreground">{invoiceNumber}</span> currently belongs to{' '}
            <span className="font-medium text-foreground">{currentCustomerName}</span>.
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-lg border border-success/40 bg-success/10 p-3 text-sm">
              <CheckCircle2 className="h-4 w-4 mt-0.5 text-success shrink-0" />
              <div className="space-y-1">
                <p className="text-card-foreground">Moved to <span className="font-medium">{done.target.full_name}</span>.</p>
                {movedList(done.child_rows).length > 0 && (
                  <p className="text-xs text-muted-foreground">Also moved: {movedList(done.child_rows).join(', ')}.</p>
                )}
              </div>
            </div>
            {done.catch_up.eligible && done.award && (
              done.award.outcome === 'awarded' ? (
                <p className="text-sm text-card-foreground">
                  <Sparkles className="inline h-4 w-4 mr-1 text-primary" />
                  Catch-up: {pts(done.award.points_earned ?? 0)} awarded to {done.target.full_name}
                  {done.catch_up.expired_on_award ? ' (born expired — the spend counts toward the tier).' : '.'}
                </p>
              ) : done.award.outcome === 'benign_skip' ? (
                <p className="text-sm text-muted-foreground">Catch-up earned no points ({done.award.reason?.replace(/_/g, ' ')}).</p>
              ) : (
                <p className="text-sm text-destructive">
                  The move stands, but the catch-up award failed ({done.award.failure}). Staff have been notified to award it manually.
                </p>
              )
            )}
            <div className="flex justify-end">
              <Button onClick={() => setOpen(false)} className="gold-gradient text-primary-foreground">Close</Button>
            </div>
          </div>
        ) : preview ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-stretch gap-2">
              <SideCard title="From" side={preview.current} />
              <div className="hidden sm:flex items-center justify-center text-muted-foreground"><ArrowRight className="h-4 w-4" /></div>
              <SideCard title="To" side={preview.target} />
            </div>

            {matchedText && (
              <p className="text-xs text-muted-foreground">{matchedText}</p>
            )}

            {overrideOffered && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 space-y-2.5">
                <p className="flex items-start gap-1.5 text-sm font-medium text-warning">
                  <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
                  Different customer details — use only if this order was put on the wrong customer
                </p>
                <label htmlFor="reassign-override" className="flex items-start gap-2 text-sm text-card-foreground cursor-pointer">
                  <Checkbox
                    id="reassign-override"
                    checked={overrideTicked}
                    disabled={busy}
                    onCheckedChange={v => toggleOverride(v === true)}
                    className="mt-0.5"
                  />
                  <span>
                    I confirm this order was put on the wrong customer and should belong to{' '}
                    <span className="font-medium">{preview.target.full_name}</span>
                  </span>
                </label>
              </div>
            )}

            {shownRefusals.length > 0 ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 space-y-1.5">
                <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                  <AlertTriangle className="h-4 w-4" /> This order cannot be moved
                </p>
                <ul className="list-disc pl-5 space-y-1 text-sm text-card-foreground">
                  {shownRefusals.map(r => <li key={r.code}>{r.message}</li>)}
                </ul>
              </div>
            ) : (
              <div className="space-y-2 text-sm">
                <p className="text-card-foreground">
                  Loyalty amount: <span className="tabular-nums">{yen(preview.loyalty_jpy_amount.effective ?? 0)}</span>
                  {preview.loyalty_jpy_amount.changes && <span className="text-muted-foreground"> (will be saved)</span>}
                </p>
                <p className={preview.catch_up.eligible && preview.catch_up.expired_on_award ? 'text-warning' : 'text-card-foreground'}>
                  {catchUpText(preview)}
                </p>
                {movedList(preview.child_rows).length > 0 && (
                  <p className="text-xs text-muted-foreground">Moves with it: {movedList(preview.child_rows).join(', ')}.</p>
                )}
                <p className="text-xs text-muted-foreground break-words">Reason: {reason.trim()}</p>
              </div>
            )}

            <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                onClick={() => { setPreview(null); setOverrideTicked(false); setPreviewOverride(false); }}
                disabled={busy}
              >Back</Button>
              <Button
                onClick={runApply}
                disabled={!confirmEnabled}
                className="gold-gradient text-primary-foreground font-medium"
              >
                {busy ? 'Moving…' : `Confirm — move to ${preview.target.full_name}`}
              </Button>
            </div>
          </div>
        ) : closed ? (
          <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
            This order is {status.replace(/_/g, ' ')}. A closed order cannot change owner.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search customer by name or code…"
                className="pl-9"
              />
            </div>

            <div className="max-h-48 overflow-y-auto rounded-lg border border-border divide-y divide-border">
              {filtered.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">No customers found</p>
              ) : filtered.map(c => {
                const l = loyaltyByCustomer?.get(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/50 ${selected === c.id ? 'bg-primary/10 border-l-2 border-l-primary' : ''}`}
                    onClick={() => setSelected(c.id)}
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold shrink-0">
                      {c.full_name.charAt(0)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-card-foreground truncate">{c.full_name}</p>
                      <p className="text-xs text-muted-foreground truncate">{c.customer_code}{c.facebook_name ? ` · @${c.facebook_name}` : ''}</p>
                    </div>
                    <div className="text-right text-[11px] text-muted-foreground tabular-nums shrink-0">
                      {l ? (<><p className="text-card-foreground">{l.tier ?? 'Member'}</p><p>{pts(l.points)} · {yen(l.spend)}</p></>) : <p>Not a member</p>}
                    </div>
                  </button>
                );
              })}
            </div>

            <LoyaltyAmountField
              value={loyaltyInput}
              onChange={setLoyaltyInput}
              required
              canEdit={canEditLoyalty}
              award={award}
              awardLoading={awardLoading}
              suggestedJpy={suggestedLoyaltyJpy}
            />
            {!loyaltyOk && !canEditLoyalty && (
              <p className="text-[11px] text-destructive">
                This order has no loyalty amount. Someone with the Edit Loyalty Amount permission must set it before it can be reassigned.
              </p>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="reassign-reason" className="text-xs text-muted-foreground">Reason *</Label>
              <Textarea
                id="reassign-reason"
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="Why is this order moving to another customer?"
                rows={2}
              />
            </div>

            <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 pt-1">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                onClick={() => runPreview(false)}
                disabled={!selected || !loyaltyOk || !reason.trim() || busy}
                className="gold-gradient text-primary-foreground font-medium"
              >
                {busy ? 'Checking…' : `Preview move to ${selectedCustomer?.full_name || '…'}`}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
