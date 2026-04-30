import { useEffect, useState } from 'react';
import { Megaphone, Loader2, ArrowRight, ChevronRight } from 'lucide-react';
import { motion } from 'framer-motion';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useCreateLoyaltyBanner,
  useUpdateLoyaltyBanner,
  type BannerType,
  type CreateBannerInput,
  type LoyaltyBannerRow,
} from '@/hooks/loyalty-admin/useLoyaltyBanners';

const TIER_OPTIONS = ['Glimmer', 'Radiant', 'Elite', 'Crown VIP'] as const;

interface FormState {
  banner_type: BannerType;
  title: string;
  subtitle: string;
  description: string;
  image_url: string;
  emoji: string;
  link_target: string;
  selected_tiers: string[]; // empty = all tiers (applicable_tiers = null)
  is_active: boolean;
  display_priority: string;
  start_at: string; // datetime-local string
  end_at: string;
}

function tsToInput(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  // datetime-local format: YYYY-MM-DDTHH:mm
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function inputToTs(s: string): string | null {
  const v = s.trim();
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function emptyForm(type: BannerType = 'featured'): FormState {
  return {
    banner_type: type,
    title: '',
    subtitle: '',
    description: '',
    image_url: '',
    emoji: '',
    link_target: '',
    selected_tiers: [],
    is_active: true,
    display_priority: '0',
    start_at: '',
    end_at: '',
  };
}

function rowToForm(b: LoyaltyBannerRow): FormState {
  return {
    banner_type: b.banner_type,
    title: b.title,
    subtitle: b.subtitle ?? '',
    description: b.description ?? '',
    image_url: b.image_url ?? '',
    emoji: b.emoji ?? '',
    link_target: b.link_target ?? '',
    selected_tiers: b.applicable_tiers ?? [],
    is_active: b.is_active,
    display_priority: String(b.display_priority),
    start_at: tsToInput(b.start_at),
    end_at: tsToInput(b.end_at),
  };
}

function validate(form: FormState): string[] {
  const errors: string[] = [];
  if (!form.title.trim()) errors.push('Title is required');
  const priority = Number(form.display_priority);
  if (!Number.isFinite(priority)) {
    errors.push('Display priority must be a number');
  }
  if (form.start_at && form.end_at) {
    const s = new Date(form.start_at).getTime();
    const e = new Date(form.end_at).getTime();
    if (Number.isFinite(s) && Number.isFinite(e) && s > e) {
      errors.push('Start must be before end');
    }
  }
  if (form.banner_type === 'promo' && !form.emoji.trim() && !form.image_url.trim()) {
    errors.push('Promo banners need either an emoji or an image');
  }
  return errors;
}

function formToInput(form: FormState): CreateBannerInput {
  return {
    banner_type: form.banner_type,
    title: form.title.trim(),
    subtitle: form.subtitle.trim() || null,
    description: form.description.trim() || null,
    image_url: form.image_url.trim() || null,
    emoji: form.emoji.trim() || null,
    link_target: form.link_target.trim() || null,
    applicable_tiers:
      form.selected_tiers.length === 0 ? null : form.selected_tiers,
    is_active: form.is_active,
    display_priority: Math.round(Number(form.display_priority)),
    start_at: inputToTs(form.start_at),
    end_at: inputToTs(form.end_at),
  };
}

interface BannerEditDialogProps {
  open: boolean;
  banner: LoyaltyBannerRow | null;
  defaultType?: BannerType; // used when creating new
  onClose: () => void;
}

export default function BannerEditDialog({
  open,
  banner,
  defaultType = 'featured',
  onClose,
}: BannerEditDialogProps) {
  const [form, setForm] = useState<FormState>(() => emptyForm(defaultType));
  const createMutation = useCreateLoyaltyBanner();
  const updateMutation = useUpdateLoyaltyBanner();
  const isPending = createMutation.isPending || updateMutation.isPending;

  useEffect(() => {
    if (open) {
      setForm(banner ? rowToForm(banner) : emptyForm(defaultType));
    }
  }, [open, banner?.id, defaultType]);

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
      if (banner) {
        await updateMutation.mutateAsync({
          bannerId: banner.id,
          oldValues: banner,
          updates: input,
        });
        toast.success('Banner updated');
      } else {
        await createMutation.mutateAsync(input);
        toast.success('Banner created');
      }
      onClose();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to save banner');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Megaphone className="h-4 w-4 text-primary" />
            {banner ? 'Edit Banner' : 'New Banner'}
          </DialogTitle>
          <DialogDescription>
            Banners surface on the customer-facing loyalty home screen.
            Featured banners are the large hero card; promo banners are the
            small cards below.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Form column */}
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="banner-type">Banner type</Label>
              <Select
                value={form.banner_type}
                onValueChange={(v) =>
                  setForm({ ...form, banner_type: v as BannerType })
                }
                disabled={isPending}
              >
                <SelectTrigger id="banner-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="featured">Featured (large hero)</SelectItem>
                  <SelectItem value="promo">Promo (small card)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="banner-title">Title</Label>
              <Input
                id="banner-title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="e.g. Spring 2026 Gold Collection"
                disabled={isPending}
              />
            </div>

            {form.banner_type === 'featured' && (
              <div className="space-y-1.5">
                <Label htmlFor="banner-subtitle">Subtitle (eyebrow)</Label>
                <Input
                  id="banner-subtitle"
                  value={form.subtitle}
                  onChange={(e) => setForm({ ...form, subtitle: e.target.value })}
                  placeholder="e.g. New Japan Gold Collection"
                  disabled={isPending}
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="banner-desc">Description / body</Label>
              <Textarea
                id="banner-desc"
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                placeholder="Customer-facing copy"
                disabled={isPending}
                rows={2}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="banner-image">Image URL (optional)</Label>
                <Input
                  id="banner-image"
                  value={form.image_url}
                  onChange={(e) =>
                    setForm({ ...form, image_url: e.target.value })
                  }
                  placeholder="https://..."
                  disabled={isPending}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="banner-emoji">Emoji</Label>
                <Input
                  id="banner-emoji"
                  value={form.emoji}
                  onChange={(e) => setForm({ ...form, emoji: e.target.value })}
                  placeholder="e.g. 🎂  💎  👑"
                  disabled={isPending}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="banner-link">Link target</Label>
              <Input
                id="banner-link"
                value={form.link_target}
                onChange={(e) => setForm({ ...form, link_target: e.target.value })}
                placeholder="tab:tiers / tab:rewards / tab:profile / https://..."
                disabled={isPending}
              />
              <p className="text-[11px] text-muted-foreground">
                Use <code className="text-[11px]">tab:profile</code>,{' '}
                <code className="text-[11px]">tab:rewards</code>,{' '}
                <code className="text-[11px]">tab:tiers</code>, etc. for
                in-portal navigation, or paste a full URL for external links.
                Leave empty for no click action.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Tier visibility</Label>
              <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
                <p className="text-[11px] text-muted-foreground">
                  Select one or more. Leave empty to show this banner to all
                  tiers.
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
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="banner-start">Schedule start (optional)</Label>
                <Input
                  id="banner-start"
                  type="datetime-local"
                  value={form.start_at}
                  onChange={(e) => setForm({ ...form, start_at: e.target.value })}
                  disabled={isPending}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="banner-end">Schedule end (optional)</Label>
                <Input
                  id="banner-end"
                  type="datetime-local"
                  value={form.end_at}
                  onChange={(e) => setForm({ ...form, end_at: e.target.value })}
                  disabled={isPending}
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground -mt-2">
              Leave both empty to show indefinitely.
            </p>

            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="banner-active" className="text-sm">
                  Active
                </Label>
                <Switch
                  id="banner-active"
                  checked={form.is_active}
                  onCheckedChange={(v) => setForm({ ...form, is_active: v })}
                  disabled={isPending}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="banner-priority">Display priority</Label>
              <Input
                id="banner-priority"
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
                For featured: highest priority is selected as the hero card.
                For promo: higher priority surfaces first in the list.
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

          {/* Preview column */}
          <div className="space-y-3 lg:sticky lg:top-0 lg:self-start">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Live Preview
            </p>
            <BannerPreview form={form} />
            <p className="text-[11px] text-muted-foreground italic">
              Preview matches the customer-facing component shape but uses
              admin styling for context.
            </p>
          </div>
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
            {banner ? 'Save Changes' : 'Create Banner'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Live preview that mirrors the customer-facing FeaturedBanner /
 * PromoBanners visual shape so admins see what their data will look
 * like in the portal.
 */
function BannerPreview({ form }: { form: FormState }) {
  if (form.banner_type === 'featured') {
    return (
      <motion.div className="relative overflow-hidden rounded-2xl shadow-soft">
        <div className="bg-gradient-to-br from-primary/8 via-accent/15 to-primary/5 p-6 border-gold-accent">
          <div className="absolute top-3 right-4 text-primary/20">✦</div>
          <div className="absolute bottom-4 right-8 text-primary/10">✦</div>

          {form.subtitle && (
            <p className="text-[11px] tracking-[0.3em] uppercase text-primary font-body font-semibold">
              {form.subtitle}
            </p>
          )}
          <h3 className="font-display text-xl font-semibold text-foreground mt-2 tracking-tight">
            {form.title || 'Banner Title'}
          </h3>
          {form.description && (
            <p className="text-[13px] text-muted-foreground font-body mt-2 leading-relaxed max-w-[85%]">
              {form.description}
            </p>
          )}
          <button
            type="button"
            disabled
            className="flex items-center gap-1.5 text-primary text-[13px] font-body font-semibold mt-4"
          >
            Explore
            <ArrowRight size={12} />
          </button>
        </div>
      </motion.div>
    );
  }

  // promo card
  return (
    <div className="bg-card rounded-2xl p-4 shadow-card border-gold-accent flex items-center gap-4">
      <div className="w-11 h-11 rounded-full bg-primary/8 flex items-center justify-center flex-shrink-0 overflow-hidden">
        {form.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={form.image_url}
            alt=""
            className="h-full w-full object-cover"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <span className="text-xl">{form.emoji || '✨'}</span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-display text-[15px] font-semibold text-foreground">
          {form.title || 'Banner Title'}
        </p>
        {form.description && (
          <p className="text-[13px] text-muted-foreground font-body mt-0.5 line-clamp-2">
            {form.description}
          </p>
        )}
      </div>
      <ChevronRight size={16} className="text-primary/40 flex-shrink-0" />
    </div>
  );
}
