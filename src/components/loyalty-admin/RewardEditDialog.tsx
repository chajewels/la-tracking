import { useEffect, useRef, useState } from 'react';
import { Gift, Loader2 } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useCreateLoyaltyReward,
  useUpdateLoyaltyReward,
  type CreateRewardInput,
  type LoyaltyRewardRow,
  type RewardCategory,
  type TierVisibility,
} from '@/hooks/loyalty-admin/useLoyaltyRewards';

const NON_VAULT_CATEGORIES: RewardCategory[] = [
  'Redeem with Points',
  'Tier Exclusive',
  'Shipping Rewards',
  'Member-Only Offers',
];

const TIER_OPTIONS: TierVisibility[] = [
  'All',
  'Glimmer',
  'Radiant',
  'Elite',
  'Crown VIP',
];

interface FormState {
  name: string;
  description: string;
  image_url: string;
  category: RewardCategory;
  tier_visibility: TierVisibility;
  points_cost: string;
  stock_limit: string; // empty = unlimited
  current_stock: string;
  is_limited: boolean;
  is_vip_only: boolean;
  is_vault: boolean;
  is_active: boolean;
  display_priority: string;
}

function emptyForm(): FormState {
  return {
    name: '',
    description: '',
    image_url: '',
    category: 'Redeem with Points',
    tier_visibility: 'All',
    points_cost: '0',
    stock_limit: '',
    current_stock: '',
    is_limited: false,
    is_vip_only: false,
    is_vault: false,
    is_active: true,
    display_priority: '0',
  };
}

function rowToForm(r: LoyaltyRewardRow): FormState {
  return {
    name: r.name,
    description: r.description ?? '',
    image_url: r.image_url ?? '',
    category: r.category,
    tier_visibility: r.tier_visibility,
    points_cost: String(r.points_cost),
    stock_limit: r.stock_limit != null ? String(r.stock_limit) : '',
    current_stock: r.current_stock != null ? String(r.current_stock) : '',
    is_limited: r.is_limited,
    is_vip_only: r.is_vip_only,
    is_vault: r.is_vault,
    is_active: r.is_active,
    display_priority: String(r.display_priority),
  };
}

function validate(form: FormState): string[] {
  const errors: string[] = [];
  if (!form.name.trim()) errors.push('Name is required');
  const cost = Number(form.points_cost);
  if (!Number.isFinite(cost) || cost < 0) {
    errors.push('Points cost must be a non-negative number');
  }
  if (form.stock_limit.trim() !== '') {
    const sl = Number(form.stock_limit);
    if (!Number.isFinite(sl) || sl < 0) {
      errors.push('Stock limit must be a non-negative number');
    }
  }
  if (form.current_stock.trim() !== '') {
    const cs = Number(form.current_stock);
    if (!Number.isFinite(cs) || cs < 0) {
      errors.push('Current stock must be a non-negative number');
    }
    if (form.stock_limit.trim() !== '') {
      const sl = Number(form.stock_limit);
      if (Number.isFinite(sl) && Number.isFinite(cs) && cs > sl) {
        errors.push('Current stock cannot exceed stock limit');
      }
    }
  }
  const priority = Number(form.display_priority);
  if (!Number.isFinite(priority)) errors.push('Display priority must be a number');
  return errors;
}

function formToInput(form: FormState): CreateRewardInput {
  // Vault toggle is the canonical Vault control: when true, category is
  // forced to 'VIP Vault' and is_vault stays true. When false, is_vault
  // is forced to false; category falls back to whatever is in the form.
  const category: RewardCategory = form.is_vault ? 'VIP Vault' : form.category;
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    image_url: form.image_url.trim() || null,
    category,
    tier_visibility: form.tier_visibility,
    points_cost: Math.round(Number(form.points_cost)),
    stock_limit:
      form.stock_limit.trim() === '' ? null : Math.round(Number(form.stock_limit)),
    current_stock:
      form.current_stock.trim() === ''
        ? null
        : Math.round(Number(form.current_stock)),
    is_limited: form.is_limited,
    is_vip_only: form.is_vip_only,
    is_vault: form.is_vault,
    is_active: form.is_active,
    display_priority: Math.round(Number(form.display_priority)),
  };
}

interface RewardEditDialogProps {
  open: boolean;
  reward: LoyaltyRewardRow | null; // null = create mode
  onClose: () => void;
}

export default function RewardEditDialog({
  open,
  reward,
  onClose,
}: RewardEditDialogProps) {
  const [form, setForm] = useState<FormState>(emptyForm);
  // Remember last non-vault category so toggling Vault OFF can restore it
  const lastNonVaultCategoryRef = useRef<RewardCategory>('Redeem with Points');
  const createMutation = useCreateLoyaltyReward();
  const updateMutation = useUpdateLoyaltyReward();
  const isPending = createMutation.isPending || updateMutation.isPending;

  useEffect(() => {
    if (open) {
      const initial = reward ? rowToForm(reward) : emptyForm();
      setForm(initial);
      lastNonVaultCategoryRef.current =
        initial.category === 'VIP Vault'
          ? 'Redeem with Points'
          : initial.category;
    }
  }, [open, reward?.id]);

  const errors = validate(form);

  function handleVaultToggle(next: boolean) {
    if (next) {
      // Going Vault ON — remember current non-vault category, set form fields
      if (form.category !== 'VIP Vault') {
        lastNonVaultCategoryRef.current = form.category;
      }
      setForm({ ...form, is_vault: true, category: 'VIP Vault' });
    } else {
      // Going Vault OFF — restore previous non-vault category
      setForm({
        ...form,
        is_vault: false,
        category: lastNonVaultCategoryRef.current,
      });
    }
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
      if (reward) {
        await updateMutation.mutateAsync({
          rewardId: reward.id,
          oldValues: reward,
          updates: input,
        });
        toast.success('Reward updated');
      } else {
        await createMutation.mutateAsync(input);
        toast.success('Reward created');
      }
      onClose();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to save reward');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gift className="h-4 w-4 text-primary" />
            {reward ? 'Edit Reward' : 'New Reward'}
          </DialogTitle>
          <DialogDescription>
            Catalog item that customers can redeem with points. Customers see
            only active rewards their tier qualifies for.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="reward-name">Name</Label>
            <Input
              id="reward-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. ¥500 Cha Jewels Voucher"
              disabled={isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reward-desc">Description</Label>
            <Textarea
              id="reward-desc"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Customer-facing copy. Optional."
              disabled={isPending}
              rows={2}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reward-image">Image URL (optional)</Label>
            <Input
              id="reward-image"
              value={form.image_url}
              onChange={(e) => setForm({ ...form, image_url: e.target.value })}
              placeholder="https://..."
              disabled={isPending}
            />
          </div>

          {/* Vault toggle — canonical Vault control */}
          <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="reward-vault" className="text-sm">
                VIP Vault item
              </Label>
              <Switch
                id="reward-vault"
                checked={form.is_vault}
                onCheckedChange={handleVaultToggle}
                disabled={isPending}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Vault rewards live in their own customer-facing section.
              Toggling this on forces category to "VIP Vault" and exposes
              the reward only to vault members.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="reward-category">Category</Label>
              <Select
                value={form.category}
                onValueChange={(v) =>
                  setForm({ ...form, category: v as RewardCategory })
                }
                disabled={isPending || form.is_vault}
              >
                <SelectTrigger id="reward-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {form.is_vault ? (
                    <SelectItem value="VIP Vault">VIP Vault</SelectItem>
                  ) : (
                    NON_VAULT_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {form.is_vault && (
                <p className="text-[10px] text-muted-foreground italic">
                  Locked because Vault is on
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reward-tier">Tier visibility</Label>
              <Select
                value={form.tier_visibility}
                onValueChange={(v) =>
                  setForm({ ...form, tier_visibility: v as TierVisibility })
                }
                disabled={isPending}
              >
                <SelectTrigger id="reward-tier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIER_OPTIONS.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="reward-cost">Points cost</Label>
              <Input
                id="reward-cost"
                type="number"
                min={0}
                step={1}
                value={form.points_cost}
                onChange={(e) => setForm({ ...form, points_cost: e.target.value })}
                disabled={isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reward-stock-limit">Stock limit</Label>
              <Input
                id="reward-stock-limit"
                type="number"
                min={0}
                step={1}
                value={form.stock_limit}
                onChange={(e) =>
                  setForm({ ...form, stock_limit: e.target.value })
                }
                placeholder="Unlimited"
                disabled={isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reward-stock-current">Current stock</Label>
              <Input
                id="reward-stock-current"
                type="number"
                min={0}
                step={1}
                value={form.current_stock}
                onChange={(e) =>
                  setForm({ ...form, current_stock: e.target.value })
                }
                placeholder="Unlimited"
                disabled={isPending}
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground -mt-2">
            Leave both stock fields empty for unlimited supply. Stock decrement
            on redemption ships in Phase 3.1.
          </p>

          <div className="rounded-md border border-border bg-muted/30 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="reward-limited" className="text-sm">
                Limited edition
              </Label>
              <Switch
                id="reward-limited"
                checked={form.is_limited}
                onCheckedChange={(v) => setForm({ ...form, is_limited: v })}
                disabled={isPending}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="reward-viponly" className="text-sm">
                VIP-only badge
              </Label>
              <Switch
                id="reward-viponly"
                checked={form.is_vip_only}
                onCheckedChange={(v) => setForm({ ...form, is_vip_only: v })}
                disabled={isPending}
              />
            </div>
            <div className="flex items-center justify-between pt-2 border-t border-border">
              <Label htmlFor="reward-active" className="text-sm">
                Active
              </Label>
              <Switch
                id="reward-active"
                checked={form.is_active}
                onCheckedChange={(v) => setForm({ ...form, is_active: v })}
                disabled={isPending}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reward-priority">Display priority</Label>
            <Input
              id="reward-priority"
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
              Higher values surface first within the category. Default 0.
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
            {reward ? 'Save Changes' : 'Create Reward'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
