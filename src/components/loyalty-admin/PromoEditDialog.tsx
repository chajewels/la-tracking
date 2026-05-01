import { useEffect, useState } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  useCreateLoyaltyPromo,
  useUpdateLoyaltyPromo,
  type CreatePromoInput,
  type LoyaltyPromoRow,
} from '@/hooks/loyalty-admin/useLoyaltyPromosAdmin';

const TIER_OPTIONS = ['Glimmer', 'Radiant', 'Elite', 'Crown VIP'] as const;

interface FormState {
  name: string;
  description: string;
  image_url: string;
  start_date: string;
  end_date: string;
  bonus_points: string;
  bonus_multiplier: string;
  selected_tiers: string[]; // empty = "All tiers" (applicable_tiers = null)
  max_per_customer: string;
  applies_per_purchase: boolean;
  display_priority: string;
  is_active: boolean;
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function emptyForm(): FormState {
  const today = todayYmd();
  return {
    name: '',
    description: '',
    image_url: '',
    start_date: today,
    end_date: today,
    bonus_points: '0',
    bonus_multiplier: '1.00',
    selected_tiers: [],
    max_per_customer: '',
    applies_per_purchase: false,
    display_priority: '0',
    is_active: true,
  };
}

function rowToForm(p: LoyaltyPromoRow): FormState {
  return {
    name: p.name,
    description: p.description ?? '',
    image_url: p.image_url ?? '',
    start_date: p.start_date,
    end_date: p.end_date,
    bonus_points: String(p.bonus_points),
    bonus_multiplier: Number(p.bonus_multiplier ?? 1).toFixed(2),
    selected_tiers: p.applicable_tiers ?? [],
    max_per_customer: p.max_per_customer != null ? String(p.max_per_customer) : '',
    applies_per_purchase: p.applies_per_purchase,
    display_priority: String(p.display_priority),
    is_active: p.is_active,
  };
}

function validate(form: FormState): string[] {
  const errors: string[] = [];
  if (!form.name.trim()) errors.push('Name is required');
  if (!form.start_date) errors.push('Start date is required');
  if (!form.end_date) errors.push('End date is required');
  if (form.start_date && form.end_date && form.start_date > form.end_date) {
    errors.push('Start date must be before or equal to end date');
  }
  const bonus = Number(form.bonus_points);
  if (!Number.isFinite(bonus) || bonus < 0) {
    errors.push('Bonus points must be a non-negative number');
  }
  const mult = Number(form.bonus_multiplier);
  if (!Number.isFinite(mult) || mult < 1) {
    errors.push('Bonus multiplier must be at least 1.00 (1.0 = no boost)');
  }
  if (Number.isFinite(mult) && mult > 99.99) {
    errors.push('Bonus multiplier cannot exceed 99.99');
  }
  if (form.max_per_customer.trim() !== '') {
    const cap = Number(form.max_per_customer);
    if (!Number.isFinite(cap) || cap < 0) {
      errors.push('Max per customer must be a non-negative number');
    }
  }
  const priority = Number(form.display_priority);
  if (!Number.isFinite(priority)) {
    errors.push('Display priority must be a number');
  }
  return errors;
}

function formToInput(form: FormState): CreatePromoInput {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    image_url: form.image_url.trim() || null,
    start_date: form.start_date,
    end_date: form.end_date,
    bonus_points: Math.round(Number(form.bonus_points)),
    bonus_multiplier: Math.round(Number(form.bonus_multiplier) * 100) / 100,
    applicable_tiers:
      form.selected_tiers.length === 0 ? null : form.selected_tiers,
    max_per_customer:
      form.max_per_customer.trim() === ''
        ? null
        : Math.round(Number(form.max_per_customer)),
    applies_per_purchase: form.applies_per_purchase,
    display_priority: Math.round(Number(form.display_priority)),
    is_active: form.is_active,
  };
}

interface PromoEditDialogProps {
  open: boolean;
  promo: LoyaltyPromoRow | null; // null = create mode
  onClose: () => void;
}

export default function PromoEditDialog({
  open,
  promo,
  onClose,
}: PromoEditDialogProps) {
  const [form, setForm] = useState<FormState>(emptyForm);
  const createMutation = useCreateLoyaltyPromo();
  const updateMutation = useUpdateLoyaltyPromo();
  const isPending = createMutation.isPending || updateMutation.isPending;

  useEffect(() => {
    if (open) {
      setForm(promo ? rowToForm(promo) : emptyForm());
    }
  }, [open, promo?.id]);

  const errors = validate(form);

  function toggleTier(tier: string, checked: boolean) {
    setForm((f) => ({
      ...f,
      selected_tiers: checked
        ? Array.from(new Set([...f.selected_tiers, tier]))
        : f.selected_tiers.filter((t) => t !== tier),
    }));
  }

  function handleClose() {
    if (isPending) return;
    onClose();
  }

  async function handleSave() {
    if (errors.length > 0) {
      toast.error(errors[0]);
      return;
    }
    const input = formToInput(form);
    try {
      if (promo) {
        await updateMutation.mutateAsync({
          promoId: promo.id,
          oldValues: promo,
          updates: input,
        });
        toast.success('Promo updated');
      } else {
        await createMutation.mutateAsync(input);
        toast.success('Promo created');
      }
      onClose();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to save promo');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {promo ? 'Edit Promo' : 'New Promo'}
          </DialogTitle>
          <DialogDescription>
            Bonus points awarded automatically on eligible purchases during the
            scheduled window.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="promo-name">Name</Label>
            <Input
              id="promo-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Spring 2026 Double Points"
              disabled={isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="promo-desc">Description</Label>
            <Textarea
              id="promo-desc"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Customer-facing copy. Optional."
              disabled={isPending}
              rows={2}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="promo-image">Image URL (optional)</Label>
            <Input
              id="promo-image"
              value={form.image_url}
              onChange={(e) => setForm({ ...form, image_url: e.target.value })}
              placeholder="https://..."
              disabled={isPending}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="promo-start">Start date</Label>
              <Input
                id="promo-start"
                type="date"
                value={form.start_date}
                onChange={(e) => setForm({ ...form, start_date: e.target.value })}
                disabled={isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="promo-end">End date</Label>
              <Input
                id="promo-end"
                type="date"
                value={form.end_date}
                onChange={(e) => setForm({ ...form, end_date: e.target.value })}
                disabled={isPending}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="promo-bonus">Bonus points</Label>
              <Input
                id="promo-bonus"
                type="number"
                min={0}
                step={1}
                value={form.bonus_points}
                onChange={(e) => setForm({ ...form, bonus_points: e.target.value })}
                disabled={isPending}
              />
              <p className="text-[11px] text-muted-foreground">
                Flat bonus points added on top. Leave at 0 to skip flat bonus.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="promo-multiplier">Bonus multiplier</Label>
              <Input
                id="promo-multiplier"
                type="number"
                min={1}
                max={99.99}
                step={0.01}
                value={form.bonus_multiplier}
                onChange={(e) =>
                  setForm({ ...form, bonus_multiplier: e.target.value })
                }
                disabled={isPending}
              />
              <p className="text-[11px] text-muted-foreground">
                Multiplier (1.0 = no boost). Stacks with tier multiplier.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="promo-cap">Max per customer</Label>
            <Input
              id="promo-cap"
              type="number"
              min={0}
              step={1}
              value={form.max_per_customer}
              onChange={(e) => setForm({ ...form, max_per_customer: e.target.value })}
              placeholder="Unlimited"
              disabled={isPending}
            />
          </div>

          <div className="space-y-2">
            <Label>Applicable tiers</Label>
            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
              <p className="text-[11px] text-muted-foreground">
                Select one or more. Leave empty to make this promo apply to
                ALL tiers.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {TIER_OPTIONS.map((tier) => (
                  <label
                    key={tier}
                    className="flex items-center gap-2 text-sm cursor-pointer"
                  >
                    <Checkbox
                      checked={form.selected_tiers.includes(tier)}
                      disabled={isPending}
                      onCheckedChange={(v) => toggleTier(tier, v === true)}
                    />
                    <span>{tier}</span>
                  </label>
                ))}
              </div>
              {form.selected_tiers.length === 0 && (
                <p className="text-[11px] text-amber-600 italic">
                  No tiers selected — promo applies to all tiers
                </p>
              )}
            </div>
          </div>

          <div className="rounded-md border border-border bg-muted/30 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="promo-per-purchase" className="text-sm">
                Applies per purchase
              </Label>
              <Switch
                id="promo-per-purchase"
                checked={form.applies_per_purchase}
                onCheckedChange={(v) =>
                  setForm({ ...form, applies_per_purchase: v })
                }
                disabled={isPending}
              />
            </div>
            <p className="text-[11px] text-muted-foreground -mt-2">
              When ON: bonus fires every qualifying purchase (subject to max
              per customer). When OFF: bonus fires once per customer per promo.
            </p>

            <div className="flex items-center justify-between pt-2 border-t border-border">
              <Label htmlFor="promo-active" className="text-sm">
                Active
              </Label>
              <Switch
                id="promo-active"
                checked={form.is_active}
                onCheckedChange={(v) => setForm({ ...form, is_active: v })}
                disabled={isPending}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="promo-priority">Display priority</Label>
            <Input
              id="promo-priority"
              type="number"
              step={1}
              value={form.display_priority}
              onChange={(e) =>
                setForm({ ...form, display_priority: e.target.value })
              }
              placeholder="0"
              disabled={isPending}
            />
            <p className="text-[11px] text-muted-foreground">
              Higher values surface first in customer-facing lists. Default 0.
            </p>
          </div>

          {errors.length > 0 && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              <p className="font-semibold mb-1">Fix before saving:</p>
              <ul className="list-disc list-inside space-y-0.5">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={isPending || errors.length > 0}
            className="gold-gradient text-primary-foreground"
          >
            {isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            {promo ? 'Save Changes' : 'Create Promo'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
