import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

const TIER_OPTIONS = ['Glimmer', 'Radiant', 'Elite', 'Crown VIP'] as const;

export interface LoyaltyPromoRow {
  id: string;
  name: string;
  description: string | null;
  start_date: string;
  end_date: string;
  bonus_points: number;
  applicable_tiers: string[] | null;
  max_per_customer: number | null;
  is_active: boolean;
  created_at?: string;
}

export interface LoyaltyPromoFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  promo: LoyaltyPromoRow | null;
  onSaved?: () => void;
}

interface FormState {
  name: string;
  description: string;
  startDate: string;
  endDate: string;
  bonusPoints: string;
  allTiers: boolean;
  selectedTiers: Set<string>;
  maxPerCustomer: string;
  isActive: boolean;
}

const EMPTY: FormState = {
  name: '',
  description: '',
  startDate: '',
  endDate: '',
  bonusPoints: '',
  allTiers: true,
  selectedTiers: new Set(),
  maxPerCustomer: '',
  isActive: true,
};

function fromPromo(p: LoyaltyPromoRow): FormState {
  const tiers = p.applicable_tiers;
  const allTiers = !tiers || tiers.length === 0;
  return {
    name: p.name,
    description: p.description ?? '',
    startDate: p.start_date,
    endDate: p.end_date,
    bonusPoints: String(p.bonus_points),
    allTiers,
    selectedTiers: new Set(tiers ?? []),
    maxPerCustomer: p.max_per_customer != null ? String(p.max_per_customer) : '',
    isActive: p.is_active,
  };
}

export function LoyaltyPromoFormModal({
  isOpen,
  onClose,
  promo,
  onSaved,
}: LoyaltyPromoFormModalProps) {
  const isEdit = !!promo;
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Reset form whenever the modal flips open or the target promo changes.
  useEffect(() => {
    if (!isOpen) return;
    setForm(promo ? fromPromo(promo) : EMPTY);
    setSaving(false);
    setErrorMsg(null);
  }, [isOpen, promo]);

  const bonusPointsNum = Number(form.bonusPoints);
  const maxPerCustomerNum = form.maxPerCustomer.trim() === ''
    ? null
    : Number(form.maxPerCustomer);

  // Validation
  const issues: string[] = [];
  if (!form.name.trim()) issues.push('Name is required');
  if (!form.startDate) issues.push('Start date is required');
  if (!form.endDate) issues.push('End date is required');
  if (form.startDate && form.endDate && form.endDate < form.startDate) {
    issues.push('End date must be on or after start date');
  }
  if (!form.bonusPoints || !Number.isFinite(bonusPointsNum) || bonusPointsNum <= 0) {
    issues.push('Bonus points must be greater than 0');
  }
  if (
    maxPerCustomerNum != null &&
    (!Number.isFinite(maxPerCustomerNum) || maxPerCustomerNum <= 0 || !Number.isInteger(maxPerCustomerNum))
  ) {
    issues.push('Max per customer must be a positive whole number');
  }
  if (!form.allTiers && form.selectedTiers.size === 0) {
    issues.push('Select at least one tier or choose "All tiers"');
  }
  const isValid = issues.length === 0;

  function toggleTier(name: string, checked: boolean) {
    setForm((f) => {
      const next = new Set(f.selectedTiers);
      if (checked) next.add(name);
      else next.delete(name);
      return { ...f, selectedTiers: next };
    });
  }

  async function handleSave() {
    if (!isValid) return;
    setSaving(true);
    setErrorMsg(null);
    try {
      const applicable = form.allTiers ? null : Array.from(form.selectedTiers);
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        start_date: form.startDate,
        end_date: form.endDate,
        bonus_points: Math.floor(bonusPointsNum),
        applicable_tiers: applicable,
        max_per_customer: maxPerCustomerNum != null ? Math.floor(maxPerCustomerNum) : null,
        is_active: form.isActive,
      };
      const { error } = isEdit
        ? await supabase.from('loyalty_promos').update(payload).eq('id', promo!.id)
        : await supabase.from('loyalty_promos').insert(payload);
      if (error) throw error;
      toast.success(isEdit ? 'Promo updated' : 'Promo created');
      onSaved?.();
      onClose();
    } catch (err: any) {
      const msg = err?.message || 'Could not save promo';
      setErrorMsg(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(o) => (!o && !saving ? onClose() : undefined)}>
      <DialogContent className="max-w-md sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Loyalty Promo' : 'New Loyalty Promo'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Update the promo details. Changes apply on the next eligible purchase.'
              : 'Configure a bonus-points promotion. Auto-applies on eligible purchases within the date window.'}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
        >
          <div>
            <Label htmlFor="promo-name">Name</Label>
            <Input
              id="promo-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Spring Bonus 2026"
              disabled={saving}
              className="mt-1.5"
            />
          </div>

          <div>
            <Label htmlFor="promo-desc">Description <span className="text-muted-foreground">(optional)</span></Label>
            <Textarea
              id="promo-desc"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              rows={2}
              placeholder="Internal note about this promotion"
              disabled={saving}
              className="mt-1.5"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="promo-start">Start Date</Label>
              <Input
                id="promo-start"
                type="date"
                value={form.startDate}
                onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                disabled={saving}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="promo-end">End Date</Label>
              <Input
                id="promo-end"
                type="date"
                value={form.endDate}
                min={form.startDate || undefined}
                onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
                disabled={saving}
                className="mt-1.5"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="promo-bonus">Bonus Points</Label>
              <Input
                id="promo-bonus"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={form.bonusPoints}
                onChange={(e) => setForm((f) => ({ ...f, bonusPoints: e.target.value }))}
                placeholder="500"
                disabled={saving}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="promo-max">
                Max per Customer <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="promo-max"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={form.maxPerCustomer}
                onChange={(e) => setForm((f) => ({ ...f, maxPerCustomer: e.target.value }))}
                placeholder="Unlimited"
                disabled={saving}
                className="mt-1.5"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Applicable Tiers</Label>
            <label
              htmlFor="all-tiers"
              className="flex items-center gap-2 cursor-pointer text-sm"
            >
              <Checkbox
                id="all-tiers"
                checked={form.allTiers}
                onCheckedChange={(v) =>
                  setForm((f) => ({
                    ...f,
                    allTiers: v === true,
                    selectedTiers: v === true ? new Set() : f.selectedTiers,
                  }))
                }
              />
              <span>All tiers</span>
            </label>
            {!form.allTiers && (
              <div className="grid grid-cols-2 gap-1.5 pl-6">
                {TIER_OPTIONS.map((tier) => (
                  <label
                    key={tier}
                    htmlFor={`tier-${tier}`}
                    className="flex items-center gap-2 cursor-pointer text-sm"
                  >
                    <Checkbox
                      id={`tier-${tier}`}
                      checked={form.selectedTiers.has(tier)}
                      onCheckedChange={(v) => toggleTier(tier, v === true)}
                    />
                    <span>{tier}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Locked toggle: applies per purchase */}
          <div className="rounded-md border border-border bg-muted/40 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">Applies per Purchase</p>
                <p className="text-xs text-muted-foreground">
                  Bonus applies on every qualifying purchase. Cannot be changed.
                </p>
              </div>
              <Switch checked disabled />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border bg-card p-3">
            <div>
              <p className="text-sm font-medium text-foreground">Active</p>
              <p className="text-xs text-muted-foreground">
                Inactive promos won't award bonus points until re-activated.
              </p>
            </div>
            <Switch
              checked={form.isActive}
              onCheckedChange={(v) => setForm((f) => ({ ...f, isActive: v }))}
              disabled={saving}
            />
          </div>

          {!isValid && form.name && (
            <ul className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs space-y-0.5">
              {issues.map((i) => (
                <li key={i} className="text-amber-700">• {i}</li>
              ))}
            </ul>
          )}
          {errorMsg && (
            <div className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errorMsg}
            </div>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!isValid || saving}
              className="gold-gradient text-primary-foreground"
            >
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Promo'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default LoyaltyPromoFormModal;
