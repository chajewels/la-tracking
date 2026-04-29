import { useEffect, useState } from 'react';
import { Crown, Sparkles, AlertTriangle, ArrowLeft, ArrowRight, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useUpdateLoyaltyTier,
  type LoyaltyTierRow,
  type LoyaltyTierUpdate,
} from '@/hooks/loyalty-admin/useLoyaltyTiers';
import { useTierImpactPreview } from '@/hooks/loyalty-admin/useTierImpactPreview';

interface TierEditDialogProps {
  tier: LoyaltyTierRow | null;
  onClose: () => void;
}

interface FormState {
  min_spend_jpy: string;
  points_multiplier: string;
  color_hex: string;
  free_shipping_enabled: boolean;
  free_shipping_min_items: string;
  mystery_gift: boolean;
}

function tierToForm(tier: LoyaltyTierRow): FormState {
  return {
    min_spend_jpy: String(tier.min_spend_jpy),
    points_multiplier: String(tier.points_multiplier),
    color_hex: tier.color_hex ?? '#9CA3AF',
    free_shipping_enabled: tier.free_shipping_min_items != null,
    free_shipping_min_items: tier.free_shipping_min_items != null
      ? String(tier.free_shipping_min_items)
      : '',
    mystery_gift: tier.mystery_gift,
  };
}

function diffFromForm(form: FormState, tier: LoyaltyTierRow): {
  updates: LoyaltyTierUpdate;
  hasChanges: boolean;
  thresholdChanged: boolean;
  errors: string[];
} {
  const updates: LoyaltyTierUpdate = {};
  const errors: string[] = [];

  const minSpend = Number(form.min_spend_jpy);
  if (!Number.isFinite(minSpend) || minSpend < 0) {
    errors.push('Minimum spend must be a non-negative number');
  } else if (minSpend !== tier.min_spend_jpy) {
    updates.min_spend_jpy = Math.round(minSpend);
  }

  const mult = Number(form.points_multiplier);
  if (!Number.isFinite(mult) || mult <= 0) {
    errors.push('Points multiplier must be greater than zero');
  } else if (mult !== tier.points_multiplier) {
    updates.points_multiplier = mult;
  }

  if (form.color_hex && !/^#[0-9a-fA-F]{6}$/.test(form.color_hex)) {
    errors.push('Color must be in #RRGGBB format');
  } else if ((form.color_hex || null) !== tier.color_hex) {
    updates.color_hex = form.color_hex || null;
  }

  let nextFreeShipping: number | null;
  if (form.free_shipping_enabled) {
    const fs = Number(form.free_shipping_min_items);
    if (!Number.isFinite(fs) || fs < 1) {
      errors.push('Free shipping minimum items must be at least 1');
      nextFreeShipping = tier.free_shipping_min_items;
    } else {
      nextFreeShipping = Math.round(fs);
    }
  } else {
    nextFreeShipping = null;
  }
  if (nextFreeShipping !== tier.free_shipping_min_items) {
    updates.free_shipping_min_items = nextFreeShipping;
  }

  if (form.mystery_gift !== tier.mystery_gift) {
    updates.mystery_gift = form.mystery_gift;
  }

  return {
    updates,
    hasChanges: Object.keys(updates).length > 0,
    thresholdChanged: 'min_spend_jpy' in updates,
    errors,
  };
}

export default function TierEditDialog({ tier, onClose }: TierEditDialogProps) {
  const [step, setStep] = useState<'form' | 'preview'>('form');
  const [form, setForm] = useState<FormState | null>(null);
  const updateMutation = useUpdateLoyaltyTier();

  useEffect(() => {
    if (tier) {
      setForm(tierToForm(tier));
      setStep('form');
    } else {
      setForm(null);
    }
  }, [tier?.id]);

  const isOpen = !!tier && !!form;

  const diff = tier && form ? diffFromForm(form, tier) : null;
  const proposedThreshold =
    diff?.thresholdChanged && diff.updates.min_spend_jpy != null
      ? diff.updates.min_spend_jpy
      : tier?.min_spend_jpy ?? 0;

  const impactQuery = useTierImpactPreview({
    tierId: tier?.id ?? '',
    newMinSpendJpy: proposedThreshold,
    enabled: step === 'preview' && !!tier,
  });

  function handleClose() {
    if (updateMutation.isPending) return;
    onClose();
  }

  async function handleConfirm() {
    if (!tier || !diff) return;
    if (diff.errors.length > 0) {
      toast.error(diff.errors[0]);
      return;
    }
    if (!diff.hasChanges) {
      toast.message('No changes to save');
      onClose();
      return;
    }
    try {
      await updateMutation.mutateAsync({
        tierId: tier.id,
        oldValues: tier,
        updates: diff.updates,
      });
      toast.success(`${tier.name} updated`);
      onClose();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update tier');
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Crown className="h-4 w-4 text-primary" />
            {step === 'form' ? `Edit ${tier?.name ?? 'Tier'}` : 'Impact Preview'}
          </DialogTitle>
          <DialogDescription>
            {step === 'form'
              ? 'Tier name is locked because it is referenced by promo configuration. Multiplier, threshold, and benefits are editable.'
              : 'Review how member tier assignments will change before confirming.'}
          </DialogDescription>
        </DialogHeader>

        {tier && form && step === 'form' && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Name (locked)</Label>
              <Input value={tier.name} disabled />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="min-spend">Min Spend (JPY)</Label>
                <Input
                  id="min-spend"
                  type="number"
                  min={0}
                  step={1}
                  value={form.min_spend_jpy}
                  onChange={(e) =>
                    setForm({ ...form, min_spend_jpy: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="multiplier">Points Multiplier</Label>
                <Input
                  id="multiplier"
                  type="number"
                  min={0}
                  step={0.5}
                  value={form.points_multiplier}
                  onChange={(e) =>
                    setForm({ ...form, points_multiplier: e.target.value })
                  }
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="color">Tier Color</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="color"
                  type="text"
                  value={form.color_hex}
                  onChange={(e) =>
                    setForm({ ...form, color_hex: e.target.value })
                  }
                  placeholder="#RRGGBB"
                  className="font-mono"
                />
                <input
                  type="color"
                  value={
                    /^#[0-9a-fA-F]{6}$/.test(form.color_hex)
                      ? form.color_hex
                      : '#9CA3AF'
                  }
                  onChange={(e) =>
                    setForm({ ...form, color_hex: e.target.value })
                  }
                  className="h-9 w-12 cursor-pointer rounded border border-border bg-background"
                />
              </div>
            </div>

            <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="free-shipping" className="text-sm">
                  Free shipping benefit
                </Label>
                <Switch
                  id="free-shipping"
                  checked={form.free_shipping_enabled}
                  onCheckedChange={(v) =>
                    setForm({ ...form, free_shipping_enabled: v })
                  }
                />
              </div>
              {form.free_shipping_enabled && (
                <div className="space-y-1.5">
                  <Label htmlFor="fs-min" className="text-xs text-muted-foreground">
                    Minimum items per qualifying order
                  </Label>
                  <Input
                    id="fs-min"
                    type="number"
                    min={1}
                    step={1}
                    value={form.free_shipping_min_items}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        free_shipping_min_items: e.target.value,
                      })
                    }
                  />
                </div>
              )}
              <div className="flex items-center justify-between">
                <Label htmlFor="mystery-gift" className="text-sm">
                  Mystery gift on tier-up
                </Label>
                <Switch
                  id="mystery-gift"
                  checked={form.mystery_gift}
                  onCheckedChange={(v) =>
                    setForm({ ...form, mystery_gift: v })
                  }
                />
              </div>
            </div>

            {diff && diff.errors.length > 0 && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                <p className="font-semibold mb-1">Fix before continuing:</p>
                <ul className="space-y-0.5 list-disc list-inside">
                  {diff.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {tier && form && step === 'preview' && (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tier</span>
                <span className="font-semibold">{tier.name}</span>
              </div>
              {diff?.thresholdChanged && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Threshold</span>
                  <span>
                    ¥{tier.min_spend_jpy.toLocaleString()} → ¥
                    {Number(form.min_spend_jpy).toLocaleString()}
                  </span>
                </div>
              )}
              {diff?.updates.points_multiplier != null && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Multiplier</span>
                  <span>
                    {tier.points_multiplier}x → {diff.updates.points_multiplier}x
                  </span>
                </div>
              )}
            </div>

            <div className="rounded-lg border border-primary/30 bg-card p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold">Member Impact</h3>
              </div>

              {impactQuery.isLoading || !impactQuery.data ? (
                <div className="space-y-2">
                  {[...Array(4)].map((_, i) => (
                    <Skeleton key={i} className="h-6 rounded-md" />
                  ))}
                </div>
              ) : (
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Currently in {tier.name}
                    </span>
                    <span className="font-semibold tabular-nums">
                      {impactQuery.data.current_count}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      After change
                    </span>
                    <span className="font-semibold tabular-nums">
                      {impactQuery.data.count_after}
                    </span>
                  </div>
                  <div className="border-t border-border pt-2 space-y-2">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Promoted into this tier
                      </span>
                      <span
                        className={`font-semibold tabular-nums ${
                          impactQuery.data.promoted_in > 0
                            ? 'text-emerald-600'
                            : ''
                        }`}
                      >
                        +{impactQuery.data.promoted_in}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        Demoted out of this tier
                      </span>
                      <span
                        className={`font-semibold tabular-nums ${
                          impactQuery.data.demoted_out > 0
                            ? 'text-amber-600'
                            : ''
                        }`}
                      >
                        −{impactQuery.data.demoted_out}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200 flex gap-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <p>
                Tier reassignments only affect <em>future</em> point-earning
                events. Already-awarded points are not retroactively
                recomputed; member tier on the dashboard updates the next time
                a customer earns or spends.
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          {step === 'preview' && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setStep('form')}
              disabled={updateMutation.isPending}
            >
              <ArrowLeft className="h-3.5 w-3.5 mr-1" />
              Back
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={updateMutation.isPending}
          >
            Cancel
          </Button>
          {step === 'form' ? (
            <Button
              type="button"
              onClick={() => setStep('preview')}
              disabled={!diff?.hasChanges || diff.errors.length > 0}
              className="gold-gradient text-primary-foreground"
            >
              Continue
              <ArrowRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          ) : (
            <Button
              type="button"
              onClick={handleConfirm}
              disabled={updateMutation.isPending || !diff?.hasChanges}
              className="gold-gradient text-primary-foreground"
            >
              {updateMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              )}
              Confirm Changes
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
