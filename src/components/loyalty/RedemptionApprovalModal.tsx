import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

interface RedemptionFull {
  id: string;
  redemption_type: string;
  points_redeemed: number;
  value_applied_jpy: number;
  value_applied_php: number | null;
  invoice_number: string;
  status: string;
  notes: string | null;
  created_at: string;
  reward_id: string | null;
  processed_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  loyalty_member: {
    id: string;
    customer_id: string;
    cumulative_spend_jpy: number;
    remaining_points: number;
    current_tier: { name: string } | null;
    customers: { full_name: string; customer_code: string } | null;
  } | null;
}

export interface RedemptionApprovalModalProps {
  isOpen: boolean;
  onClose: () => void;
  redemptionId: string | null;
  onSuccess?: () => void;
  /** Extra query keys to invalidate after approve / cancel */
  invalidateKeys?: ReadonlyArray<ReadonlyArray<unknown>>;
}

function fmtRedemptionType(t: string) {
  switch (t) {
    case 'new_order_discount': return 'New Order Discount';
    case 'shipping_fee': return 'Shipping Fee';
    case 'service_fee': return 'Service Fee';
    case 'catalog_reward': return 'Catalog Reward';
    default: return t;
  }
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function RedemptionApprovalModal({
  isOpen,
  onClose,
  redemptionId,
  onSuccess,
  invalidateKeys = [],
}: RedemptionApprovalModalProps) {
  const queryClient = useQueryClient();
  const { roles } = useAuth();
  const rolesArr = roles as any[];
  const isAdmin = rolesArr.includes('admin');
  const isFinance = rolesArr.includes('finance');
  const isStaff = rolesArr.includes('staff');
  const canApprove = isAdmin || isFinance || isStaff;

  const [check1, setCheck1] = useState(false);
  const [check2, setCheck2] = useState(false);
  const [check3, setCheck3] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showCancelInput, setShowCancelInput] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  // Phase 3.2.1 — void flow for confirmed redemptions
  const [showVoidInput, setShowVoidInput] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);

  // Reset internal state on each open.
  useEffect(() => {
    if (isOpen) {
      setCheck1(false);
      setCheck2(false);
      setCheck3(false);
      setSubmitting(false);
      setShowCancelInput(false);
      setCancelReason('');
      setShowVoidInput(false);
      setVoidReason('');
      setVoiding(false);
    }
  }, [isOpen, redemptionId]);

  const { data: redemption, isLoading } = useQuery<RedemptionFull | null>({
    queryKey: ['redemption-detail', redemptionId],
    enabled: isOpen && !!redemptionId,
    queryFn: async () => {
      if (!redemptionId) return null;
      const { data, error } = await supabase
        .from('loyalty_redemptions')
        .select(
          'id, redemption_type, points_redeemed, value_applied_jpy, value_applied_php, invoice_number, status, notes, created_at, reward_id, processed_at, cancelled_at, cancellation_reason, loyalty_member:member_id(id, customer_id, cumulative_spend_jpy, remaining_points, current_tier:current_tier_id(name), customers:customer_id(full_name, customer_code))',
        )
        .eq('id', redemptionId)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown) as RedemptionFull | null;
    },
  });

  const member = redemption?.loyalty_member ?? null;
  const customer = member?.customers ?? null;
  const isPending = redemption?.status === 'pending';
  const isConfirmed = redemption?.status === 'confirmed';
  const isCancelled = redemption?.status === 'cancelled';

  // Phase D + design correction 2026-05-19 — type-aware display.
  // new_order_discount: order-linked (invoice, brand-new checks, 3 checks).
  // shipping_fee / service_fee: STRICT points-only — no invoice, no order
  // checks; admin reviews against the customer's notes (single check).
  // catalog_reward: existing catalog flow.
  const rType = redemption?.redemption_type ?? '';
  const isNewOrderDiscount = rType === 'new_order_discount';
  const isShippingFee = rType === 'shipping_fee';
  const isServiceFee = rType === 'service_fee';
  const isPointsOnly = isShippingFee || isServiceFee;
  // Points-only redemptions need only the single notes-match check.
  const allChecksPassed = isPointsOnly
    ? check1
    : check1 && check2 && check3;
  const check1Label = isNewOrderDiscount
    ? 'Invoice is for a NEW order (not an existing in-progress account)'
    : isShippingFee
      ? "Confirm shipping request matches customer's notes"
      : isServiceFee
        ? "Confirm service request matches customer's notes"
        : 'Redemption target order is correct';
  const check3Label = isNewOrderDiscount
    ? "Redemption type matches the new order's intent"
    : "Reward selection matches the customer's request";
  const applyVerb = isNewOrderDiscount
    ? 'Apply New Order Discount'
    : isShippingFee
      ? 'Approve Shipping Fee'
      : isServiceFee
        ? 'Approve Service Fee'
        : 'Approve & Apply';

  async function invalidateAll() {
    await queryClient.invalidateQueries({ queryKey: ['loyalty-redemptions'] });
    await queryClient.invalidateQueries({ queryKey: ['loyalty-pending-count'] });
    await queryClient.invalidateQueries({ queryKey: ['loyalty-redemption-stats'] });
    for (const key of invalidateKeys) {
      await queryClient.invalidateQueries({ queryKey: key as unknown as readonly unknown[] });
    }
  }

  async function handleApprove() {
    if (!redemptionId || !allChecksPassed) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        'process-loyalty-redemption',
        {
          body: { action: 'approve', redemption_id: redemptionId },
        },
      );
      if (error) throw error;
      const errFromBody = (data as any)?.error as string | undefined;
      if (errFromBody) throw new Error(errFromBody);
      toast.success('Redemption approved');
      await invalidateAll();
      onSuccess?.();
      onClose();
    } catch (err: any) {
      toast.error(err?.message || 'Could not approve — please try again');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel() {
    if (!redemptionId) return;
    const trimmed = cancelReason.trim();
    if (!trimmed) {
      toast.error('Cancellation reason is required');
      return;
    }
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        'process-loyalty-redemption',
        {
          body: {
            action: 'cancel',
            redemption_id: redemptionId,
            cancellation_reason: trimmed,
          },
        },
      );
      if (error) throw error;
      const errFromBody = (data as any)?.error as string | undefined;
      if (errFromBody) throw new Error(errFromBody);
      toast.success('Redemption cancelled');
      await invalidateAll();
      onSuccess?.();
      onClose();
    } catch (err: any) {
      toast.error(err?.message || 'Could not cancel — please try again');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVoid() {
    if (!redemptionId) return;
    const trimmed = voidReason.trim();
    if (!trimmed) {
      toast.error('Void reason is required');
      return;
    }
    setVoiding(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        'process-loyalty-redemption',
        {
          body: {
            action: 'void',
            redemption_id: redemptionId,
            void_reason: trimmed,
          },
        },
      );
      if (error) throw error;
      const body = (data ?? {}) as { error?: string; race?: boolean };
      if (body.race) {
        toast.message('Already voided by another admin. Refreshing…');
        await invalidateAll();
        onSuccess?.();
        onClose();
        return;
      }
      if (body.error) throw new Error(body.error);
      toast.success('Redemption voided — points refunded');
      await invalidateAll();
      onSuccess?.();
      onClose();
    } catch (err: any) {
      toast.error(err?.message || 'Could not void — please try again');
    } finally {
      setVoiding(false);
    }
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(o) => (!o && !submitting && !voiding ? onClose() : undefined)}
    >
      <DialogContent className="max-w-md sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Review Redemption</DialogTitle>
          {redemption && (
            <DialogDescription className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-primary">
                {fmtRedemptionType(redemption.redemption_type)}
              </span>
              <span>Submitted {fmtDateTime(redemption.created_at)}</span>
            </DialogDescription>
          )}
        </DialogHeader>

        {isLoading || !redemption ? (
          <div className="space-y-3 py-2">
            <Skeleton className="h-20 rounded-md" />
            <Skeleton className="h-40 rounded-md" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Customer info */}
            <div className="rounded-md border border-border bg-muted/40 p-3">
              <p className="text-[13px] uppercase tracking-wider text-muted-foreground mb-1.5 font-semibold">
                Customer
              </p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <Stat label="Name" value={customer?.full_name ?? '—'} />
                <Stat label="Code" value={customer?.customer_code ?? '—'} mono />
                <Stat label="Current tier" value={member?.current_tier?.name ?? '—'} />
                <Stat
                  label="Points balance"
                  value={Number(member?.remaining_points ?? 0).toLocaleString()}
                />
                <Stat
                  label="Lifetime spend"
                  value={`¥${Number(member?.cumulative_spend_jpy ?? 0).toLocaleString()}`}
                />
              </div>
            </div>

            {/* Redemption details */}
            <div className="rounded-md border border-border bg-card p-3">
              <p className="text-[13px] uppercase tracking-wider text-muted-foreground mb-1.5 font-semibold">
                Redemption
              </p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <Stat label="Type" value={fmtRedemptionType(redemption.redemption_type)} />
                <Stat
                  label="Points"
                  value={Number(redemption.points_redeemed).toLocaleString()}
                />
                <Stat
                  label="Value"
                  value={`¥${Number(redemption.value_applied_jpy).toLocaleString()}${
                    redemption.value_applied_php != null
                      ? ` / ₱${Number(redemption.value_applied_php).toLocaleString()}`
                      : ''
                  }`}
                />
                {redemption.invoice_number != null &&
                  redemption.invoice_number !== '' && (
                    <Stat
                      label="Invoice"
                      value={`#${redemption.invoice_number}`}
                      mono
                    />
                  )}
              </div>
              {redemption.notes && (
                <div
                  className={`mt-2 rounded-md border px-2 py-1.5 text-xs ${
                    isPointsOnly
                      ? 'border-amber-500/40 bg-amber-500/10'
                      : 'border-border bg-muted/40'
                  }`}
                >
                  <p className="text-[12px] uppercase tracking-wider text-muted-foreground mb-0.5">
                    {isPointsOnly ? 'Notes (review context)' : 'Customer notes'}
                  </p>
                  <p className="text-foreground whitespace-pre-wrap">
                    {redemption.notes}
                  </p>
                </div>
              )}
            </div>

            {/* Status banner — confirmed redemptions (admins see Void affordance below) */}
            {isConfirmed && (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-900 dark:text-emerald-200 space-y-0.5">
                <p className="font-semibold">
                  Status: <span className="uppercase">Confirmed</span>
                </p>
                {redemption.processed_at && (
                  <p className="text-emerald-800/80 dark:text-emerald-300/80">
                    Approved {fmtDateTime(redemption.processed_at)}
                  </p>
                )}
              </div>
            )}

            {/* Status banner — cancelled redemptions (terminal) */}
            {isCancelled && (
              <div className="rounded-md border border-border bg-muted/60 px-3 py-2 text-xs text-muted-foreground space-y-0.5">
                <p className="font-semibold">
                  Status: <span className="uppercase">Cancelled</span>
                </p>
                {redemption.cancelled_at && (
                  <p>Cancelled {fmtDateTime(redemption.cancelled_at)}</p>
                )}
                {redemption.cancellation_reason && (
                  <p className="text-foreground">
                    Reason: {redemption.cancellation_reason}
                  </p>
                )}
              </div>
            )}

            {/* Verification checklist (only for pending) */}
            {isPending && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
                <p className="text-[13px] uppercase tracking-wider text-amber-700 font-semibold">
                  Verify before approving
                </p>
                <Verify
                  id="check-new-order"
                  checked={check1}
                  onChange={setCheck1}
                  label={check1Label}
                />
                {/* shipping_fee / service_fee are points-only — single
                    notes-match check is sufficient (design correction
                    2026-05-19). new_order_discount keeps all 3 checks. */}
                {!isPointsOnly && (
                  <>
                    <Verify
                      id="check-balance"
                      checked={check2}
                      onChange={setCheck2}
                      label={`Customer has sufficient points (${Number(
                        member?.remaining_points ?? 0,
                      ).toLocaleString()} available)`}
                    />
                    <Verify
                      id="check-type"
                      checked={check3}
                      onChange={setCheck3}
                      label={check3Label}
                    />
                  </>
                )}
              </div>
            )}

            {/* Cancel reason input (admin only, when expanded) */}
            {isPending && showCancelInput && (
              <div className="rounded-md border border-border bg-card p-3 space-y-2">
                <p className="text-xs font-semibold text-foreground">Cancellation reason</p>
                <Textarea
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  rows={3}
                  placeholder="Explain why this redemption is being cancelled (visible in the audit log)"
                />
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={submitting}
                    onClick={() => {
                      setShowCancelInput(false);
                      setCancelReason('');
                    }}
                  >
                    Back
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={submitting || !cancelReason.trim()}
                    onClick={handleCancel}
                  >
                    {submitting ? 'Cancelling…' : 'Confirm Cancel'}
                  </Button>
                </div>
              </div>
            )}

            {/* Void reason input (Phase 3.2.1 — admin only, confirmed status, when expanded) */}
            {isConfirmed && isAdmin && showVoidInput && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                <p className="text-xs font-semibold text-foreground">Void reason</p>
                <p className="text-[11px] text-muted-foreground">
                  Voiding will refund{' '}
                  <span className="font-semibold text-foreground">
                    {Number(redemption.points_redeemed).toLocaleString()} points
                  </span>
                  {redemption.reward_id ? ' and re-increment catalog stock' : ''}.
                  The customer will receive a cancellation notification.
                </p>
                <Textarea
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  rows={3}
                  maxLength={500}
                  placeholder="Explain why this redemption is being voided (visible in audit log + customer notification)"
                  disabled={voiding}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={voiding}
                    onClick={() => {
                      setShowVoidInput(false);
                      setVoidReason('');
                    }}
                  >
                    Back
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={voiding || !voidReason.trim()}
                    aria-busy={voiding}
                    onClick={handleVoid}
                  >
                    {voiding ? 'Voiding…' : 'Confirm Void'}
                  </Button>
                </div>
              </div>
            )}

            {/* Action buttons */}
            {isPending && !showCancelInput && (
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onClose}
                  disabled={submitting}
                >
                  Close
                </Button>
                {isAdmin && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowCancelInput(true)}
                    disabled={submitting}
                    className="border-destructive/40 text-destructive hover:bg-destructive/10"
                  >
                    Cancel Request
                  </Button>
                )}
                {canApprove && (
                  <Button
                    type="button"
                    onClick={handleApprove}
                    disabled={submitting || !allChecksPassed}
                    className="gold-gradient text-primary-foreground"
                  >
                    {submitting ? 'Approving…' : applyVerb}
                  </Button>
                )}
              </div>
            )}

            {/* Confirmed + admin: Void affordance (collapsed → expand input above) */}
            {isConfirmed && isAdmin && !showVoidInput && (
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onClose}
                  disabled={voiding}
                >
                  Close
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowVoidInput(true)}
                  disabled={voiding}
                  className="border-destructive/40 text-destructive hover:bg-destructive/10"
                >
                  Void Redemption
                </Button>
              </div>
            )}

            {/* Confirmed + non-admin OR cancelled: read-only close */}
            {((isConfirmed && !isAdmin) || isCancelled) && (
              <div className="flex justify-end">
                <Button type="button" variant="ghost" onClick={onClose}>
                  Close
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[12px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`text-xs font-semibold text-foreground ${mono ? 'font-mono' : 'tabular-nums'}`}>
        {value}
      </p>
    </div>
  );
}

function Verify({
  id,
  checked,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label htmlFor={id} className="flex items-start gap-2 cursor-pointer text-xs">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        className="mt-0.5"
      />
      <span className="text-foreground leading-snug">{label}</span>
    </label>
  );
}

export default RedemptionApprovalModal;
