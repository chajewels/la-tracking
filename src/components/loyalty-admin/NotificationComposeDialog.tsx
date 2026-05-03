import { useEffect, useMemo, useState } from 'react';
import {
  Bell, Loader2, Send, Calendar, Users as UsersIcon, Crown, Sparkles,
  Cake, Gift, Megaphone, Settings as SettingsIcon, X, Search,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import {
  useSendNotification,
  useUpdateNotification,
  useLoyaltyMembersForAudience,
  TIERS,
  type LoyaltyNotificationRow,
  type NotificationCategory,
  type AudienceType,
  type SendNotificationInput,
} from '@/hooks/loyalty-admin/useLoyaltyNotifications';

const CATEGORY_OPTIONS: Array<{
  value: NotificationCategory;
  label: string;
  Icon: typeof Megaphone;
}> = [
  { value: 'info', label: 'Info', Icon: Megaphone },
  { value: 'promo', label: 'Promo', Icon: Sparkles },
  { value: 'tier', label: 'Tier', Icon: Crown },
  { value: 'system', label: 'System', Icon: SettingsIcon },
  { value: 'reward', label: 'Reward', Icon: Gift },
  { value: 'birthday', label: 'Birthday', Icon: Cake },
];

const TAB_TARGETS = [
  { value: 'tab:home', label: 'Home' },
  { value: 'tab:rewards', label: 'Rewards' },
  { value: 'tab:points', label: 'Points' },
  { value: 'tab:tiers', label: 'Tiers' },
  { value: 'tab:notifications', label: 'Notifications' },
  { value: 'tab:profile', label: 'Profile' },
] as const;

type LinkMode = 'none' | 'tab' | 'url';
type ScheduleMode = 'now' | 'schedule';

interface FormState {
  title: string;
  body: string;
  category: NotificationCategory;
  audience_type: AudienceType;
  audience_tiers: string[];
  audience_member_ids: string[];
  link_mode: LinkMode;
  link_tab: string;
  link_url: string;
  schedule_mode: ScheduleMode;
  scheduled_for: string; // datetime-local format YYYY-MM-DDTHH:mm
  send_email: boolean;
  expires_at_enabled: boolean;
  expires_at: string;
}

function emptyForm(): FormState {
  return {
    title: '',
    body: '',
    category: 'info',
    audience_type: 'all',
    audience_tiers: [],
    audience_member_ids: [],
    link_mode: 'none',
    link_tab: 'tab:rewards',
    link_url: '',
    schedule_mode: 'now',
    scheduled_for: '',
    send_email: false,
    expires_at_enabled: false,
    expires_at: '',
  };
}

function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // YYYY-MM-DDTHH:mm in local tz
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function rowToForm(row: LoyaltyNotificationRow): FormState {
  let linkMode: LinkMode = 'none';
  let linkTab = 'tab:rewards';
  let linkUrl = '';
  if (row.link_target) {
    if (row.link_target.startsWith('tab:')) {
      linkMode = 'tab';
      linkTab = row.link_target;
    } else {
      linkMode = 'url';
      linkUrl = row.link_target;
    }
  }
  return {
    title: row.title,
    body: row.body,
    category: row.category,
    audience_type: row.audience_type,
    audience_tiers: row.audience_tiers ?? [],
    audience_member_ids: row.audience_member_ids ?? [],
    link_mode: linkMode,
    link_tab: linkTab,
    link_url: linkUrl,
    schedule_mode: row.scheduled_for ? 'schedule' : 'now',
    scheduled_for: isoToLocalInput(row.scheduled_for),
    send_email: row.send_email,
    expires_at_enabled: !!row.expires_at,
    expires_at: isoToLocalInput(row.expires_at),
  };
}

function validate(form: FormState): string[] {
  const errors: string[] = [];
  if (!form.title.trim()) errors.push('Title is required');
  if (form.title.length > 100) errors.push('Title must be 100 characters or fewer');
  if (!form.body.trim()) errors.push('Body is required');
  if (form.body.length > 500) errors.push('Body must be 500 characters or fewer');
  if (form.audience_type === 'tier' && form.audience_tiers.length === 0) {
    errors.push('Select at least one tier');
  }
  if (form.audience_type === 'specific' && form.audience_member_ids.length === 0) {
    errors.push('Pick at least one member');
  }
  if (form.link_mode === 'url') {
    const u = form.link_url.trim();
    if (!u) errors.push('External URL is required');
    else if (!/^https?:\/\//i.test(u)) errors.push('External URL must start with https://');
  }
  if (form.schedule_mode === 'schedule') {
    if (!form.scheduled_for) {
      errors.push('Scheduled time is required');
    } else {
      const t = new Date(form.scheduled_for).getTime();
      if (Number.isNaN(t)) errors.push('Invalid scheduled time');
      else if (t <= Date.now()) errors.push('Scheduled time must be in the future');
    }
  }
  if (form.expires_at_enabled) {
    if (!form.expires_at) {
      errors.push('Expiry time is required when enabled');
    } else {
      const t = new Date(form.expires_at).getTime();
      const ref = form.schedule_mode === 'schedule' && form.scheduled_for
        ? new Date(form.scheduled_for).getTime()
        : Date.now();
      if (Number.isNaN(t)) errors.push('Invalid expiry time');
      else if (t <= ref) errors.push('Expiry time must be after the send time');
    }
  }
  return errors;
}

function formToInput(form: FormState): SendNotificationInput {
  let link_target: string | null = null;
  if (form.link_mode === 'tab') link_target = form.link_tab;
  else if (form.link_mode === 'url') link_target = form.link_url.trim();

  return {
    title: form.title.trim(),
    body: form.body.trim(),
    category: form.category,
    audience_type: form.audience_type,
    audience_tiers:
      form.audience_type === 'tier' ? form.audience_tiers : null,
    audience_member_ids:
      form.audience_type === 'specific' ? form.audience_member_ids : null,
    link_target,
    send_email: form.send_email,
    scheduled_for:
      form.schedule_mode === 'schedule' ? localInputToIso(form.scheduled_for) : null,
    expires_at: form.expires_at_enabled ? localInputToIso(form.expires_at) : null,
  };
}

function fmtPht(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }) + ' PHT';
}

interface NotificationComposeDialogProps {
  open: boolean;
  notification: LoyaltyNotificationRow | null;
  onClose: () => void;
}

export default function NotificationComposeDialog({
  open,
  notification,
  onClose,
}: NotificationComposeDialogProps) {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [confirmAction, setConfirmAction] = useState<null | 'now' | 'schedule'>(null);
  const [memberSearch, setMemberSearch] = useState('');
  const [globalEmailGate, setGlobalEmailGate] = useState<boolean | null>(null);

  const sendMutation = useSendNotification();
  const updateMutation = useUpdateNotification();
  const isPending = sendMutation.isPending || updateMutation.isPending;
  const isEditMode = !!notification;
  const editLocked = isEditMode && !['draft', 'scheduled'].includes(notification!.status);

  const { data: audienceMembers, isLoading: membersLoading } =
    useLoyaltyMembersForAudience(open && form.audience_type === 'specific');

  // Pull global broadcast email gate so the helper text reflects reality.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'loyalty_email_broadcast')
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const v: any = data?.value;
        const parsed = typeof v === 'string' ? v === 'true' : !!v;
        setGlobalEmailGate(parsed);
      });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (open) {
      setForm(notification ? rowToForm(notification) : emptyForm());
      setMemberSearch('');
    }
  }, [open, notification?.id]);

  const errors = useMemo(() => validate(form), [form]);
  const filteredMembers = useMemo(() => {
    const list = audienceMembers ?? [];
    const q = memberSearch.trim().toLowerCase();
    if (!q) return list.slice(0, 50);
    return list
      .filter(
        (m) =>
          m.customer_name.toLowerCase().includes(q) ||
          (m.customer_code ?? '').toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [audienceMembers, memberSearch]);
  const selectedMemberMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of audienceMembers ?? []) {
      if (form.audience_member_ids.includes(m.member_id)) {
        map.set(m.member_id, m.customer_name);
      }
    }
    return map;
  }, [audienceMembers, form.audience_member_ids]);

  function toggleTier(tier: string, checked: boolean) {
    setForm((f) => ({
      ...f,
      audience_tiers: checked
        ? Array.from(new Set([...f.audience_tiers, tier]))
        : f.audience_tiers.filter((t) => t !== tier),
    }));
  }

  function toggleMember(id: string, checked: boolean) {
    setForm((f) => ({
      ...f,
      audience_member_ids: checked
        ? Array.from(new Set([...f.audience_member_ids, id]))
        : f.audience_member_ids.filter((m) => m !== id),
    }));
  }

  function handleClose() {
    if (isPending) return;
    setConfirmAction(null);
    onClose();
  }

  function attemptSend() {
    if (editLocked) {
      toast.error(`Cannot edit a ${notification!.status} notification`);
      return;
    }
    if (errors.length > 0) {
      toast.error(errors[0]);
      return;
    }
    setConfirmAction(form.schedule_mode === 'schedule' ? 'schedule' : 'now');
  }

  async function handleConfirm() {
    if (confirmAction === null) return;
    const input = formToInput(form);
    try {
      if (isEditMode) {
        const res = await updateMutation.mutateAsync({
          ...input,
          notification_id: notification!.id,
        });
        toast.success(
          res.status === 'scheduled'
            ? `Notification scheduled for ${fmtPht(res.scheduled_for!)}`
            : `Notification sent to ${res.recipient_count} recipient(s)`,
        );
      } else {
        const res = await sendMutation.mutateAsync(input);
        toast.success(
          res.status === 'scheduled'
            ? `Notification scheduled for ${fmtPht(res.scheduled_for!)}`
            : `Notification sent to ${res.recipient_count} recipient(s)`,
        );
      }
      setConfirmAction(null);
      onClose();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to send notification');
      setConfirmAction(null);
    }
  }

  const audienceLabel = (() => {
    if (form.audience_type === 'all') return 'All members';
    if (form.audience_type === 'tier') {
      return form.audience_tiers.length === 0
        ? '—'
        : `Tiers: ${form.audience_tiers.join(', ')}`;
    }
    return `${form.audience_member_ids.length} specific member(s)`;
  })();

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-primary" />
              {isEditMode ? 'Edit Notification' : 'New Notification'}
            </DialogTitle>
            <DialogDescription>
              Loyalty members see this in the Notifications tab of the customer portal.
            </DialogDescription>
          </DialogHeader>

          {editLocked && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              This notification is <strong>{notification!.status}</strong> and can no longer be
              edited. Close and create a new one instead.
            </div>
          )}

          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <Label htmlFor="notif-title">Title</Label>
                <span className="text-[10px] text-muted-foreground">
                  {form.title.length} / 100
                </span>
              </div>
              <Input
                id="notif-title"
                value={form.title}
                maxLength={100}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="e.g. Spring 2026 Collection Now Live"
                disabled={isPending || editLocked}
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <Label htmlFor="notif-body">Body</Label>
                <span className="text-[10px] text-muted-foreground">
                  {form.body.length} / 500
                </span>
              </div>
              <Textarea
                id="notif-body"
                value={form.body}
                maxLength={500}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                placeholder="Customer-facing body text. Keep it tight."
                rows={4}
                disabled={isPending || editLocked}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="notif-category">Category</Label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm({ ...form, category: v as NotificationCategory })}
                disabled={isPending || editLocked}
              >
                <SelectTrigger id="notif-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORY_OPTIONS.map(({ value, label, Icon }) => (
                    <SelectItem key={value} value={value}>
                      <div className="flex items-center gap-2">
                        <Icon className="h-3.5 w-3.5" />
                        <span>{label}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Audience</Label>
              <RadioGroup
                value={form.audience_type}
                onValueChange={(v) =>
                  setForm({ ...form, audience_type: v as AudienceType })
                }
                disabled={isPending || editLocked}
                className="grid grid-cols-3 gap-2"
              >
                {(['all', 'tier', 'specific'] as AudienceType[]).map((opt) => (
                  <label
                    key={opt}
                    className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm cursor-pointer"
                  >
                    <RadioGroupItem value={opt} />
                    <span className="capitalize">
                      {opt === 'all' ? 'All' : opt === 'tier' ? 'By tier' : 'Specific'}
                    </span>
                  </label>
                ))}
              </RadioGroup>

              {form.audience_type === 'tier' && (
                <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
                  <p className="text-[11px] text-muted-foreground">
                    Select one or more tiers.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {TIERS.map((tier) => (
                      <label key={tier} className="flex items-center gap-2 text-sm cursor-pointer">
                        <Checkbox
                          checked={form.audience_tiers.includes(tier)}
                          disabled={isPending || editLocked}
                          onCheckedChange={(v) => toggleTier(tier, v === true)}
                        />
                        <span>{tier}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {form.audience_type === 'specific' && (
                <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
                  {form.audience_member_ids.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-1">
                      {form.audience_member_ids.map((id) => (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[11px]"
                        >
                          <span className="truncate max-w-[140px]">
                            {selectedMemberMap.get(id) ?? id.slice(0, 8)}
                          </span>
                          <button
                            type="button"
                            onClick={() => toggleMember(id, false)}
                            disabled={isPending || editLocked}
                            className="hover:bg-primary/20 rounded"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={memberSearch}
                      onChange={(e) => setMemberSearch(e.target.value)}
                      placeholder="Search by name or customer code…"
                      disabled={isPending || editLocked}
                      className="pl-7 h-8 text-xs"
                    />
                  </div>
                  <div className="max-h-44 overflow-y-auto rounded-md border border-border bg-background">
                    {membersLoading ? (
                      <p className="p-3 text-xs text-muted-foreground">Loading members…</p>
                    ) : filteredMembers.length === 0 ? (
                      <p className="p-3 text-xs text-muted-foreground">
                        {memberSearch ? 'No matches.' : 'No members.'}
                      </p>
                    ) : (
                      filteredMembers.map((m) => {
                        const checked = form.audience_member_ids.includes(m.member_id);
                        return (
                          <label
                            key={m.member_id}
                            className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-muted/50 border-b border-border last:border-0"
                          >
                            <Checkbox
                              checked={checked}
                              disabled={isPending || editLocked}
                              onCheckedChange={(v) => toggleMember(m.member_id, v === true)}
                            />
                            <span className="flex-1 truncate">{m.customer_name}</span>
                            <span className="text-[10px] text-muted-foreground">
                              {m.current_tier}
                            </span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Link target (optional)</Label>
              <Select
                value={form.link_mode}
                onValueChange={(v) => setForm({ ...form, link_mode: v as LinkMode })}
                disabled={isPending || editLocked}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="tab">Portal tab</SelectItem>
                  <SelectItem value="url">External URL</SelectItem>
                </SelectContent>
              </Select>
              {form.link_mode === 'tab' && (
                <Select
                  value={form.link_tab}
                  onValueChange={(v) => setForm({ ...form, link_tab: v })}
                  disabled={isPending || editLocked}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TAB_TARGETS.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {form.link_mode === 'url' && (
                <Input
                  type="url"
                  value={form.link_url}
                  onChange={(e) => setForm({ ...form, link_url: e.target.value })}
                  placeholder="https://..."
                  disabled={isPending || editLocked}
                />
              )}
            </div>

            <div className="space-y-2">
              <Label>Schedule</Label>
              <RadioGroup
                value={form.schedule_mode}
                onValueChange={(v) => setForm({ ...form, schedule_mode: v as ScheduleMode })}
                disabled={isPending || editLocked}
                className="grid grid-cols-2 gap-2"
              >
                {(['now', 'schedule'] as ScheduleMode[]).map((opt) => (
                  <label
                    key={opt}
                    className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm cursor-pointer"
                  >
                    <RadioGroupItem value={opt} />
                    <span>{opt === 'now' ? 'Send now' : 'Schedule'}</span>
                  </label>
                ))}
              </RadioGroup>
              {form.schedule_mode === 'schedule' && (
                <Input
                  type="datetime-local"
                  value={form.scheduled_for}
                  onChange={(e) => setForm({ ...form, scheduled_for: e.target.value })}
                  disabled={isPending || editLocked}
                />
              )}
            </div>

            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="notif-email" className="text-sm">
                  Also send email
                </Label>
                <Switch
                  id="notif-email"
                  checked={form.send_email}
                  disabled={isPending || editLocked}
                  onCheckedChange={(v) => setForm({ ...form, send_email: v })}
                />
              </div>
              <p className="text-[11px] text-muted-foreground -mt-1">
                Sends the loyalty-broadcast email template alongside the in-portal
                notification.{' '}
                {globalEmailGate === false && (
                  <span className="text-amber-600">
                    Global toggle <code className="text-[11px]">loyalty_email_broadcast</code> is OFF — emails will be suppressed regardless of this switch.
                  </span>
                )}
                {globalEmailGate === true && (
                  <span className="text-muted-foreground/80">
                    Global toggle is on.
                  </span>
                )}
              </p>
            </div>

            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="notif-expiry" className="text-sm">
                  Auto-archive after a date
                </Label>
                <Switch
                  id="notif-expiry"
                  checked={form.expires_at_enabled}
                  disabled={isPending || editLocked}
                  onCheckedChange={(v) =>
                    setForm({ ...form, expires_at_enabled: v })
                  }
                />
              </div>
              {form.expires_at_enabled && (
                <Input
                  type="datetime-local"
                  value={form.expires_at}
                  onChange={(e) => setForm({ ...form, expires_at: e.target.value })}
                  disabled={isPending || editLocked}
                />
              )}
            </div>

            {errors.length > 0 && !editLocked && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                <p className="font-semibold mb-1">Fix before sending:</p>
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
              onClick={attemptSend}
              disabled={isPending || editLocked || errors.length > 0}
              className="gold-gradient text-primary-foreground"
            >
              {isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              {form.schedule_mode === 'schedule' ? (
                <><Calendar className="h-3.5 w-3.5 mr-1" /> Schedule</>
              ) : (
                <><Send className="h-3.5 w-3.5 mr-1" /> Send Now</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={(o) => !o && setConfirmAction(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === 'schedule' ? 'Schedule notification?' : 'Send notification now?'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <div className="flex items-start gap-2">
                  <UsersIcon className="h-4 w-4 mt-0.5 text-muted-foreground" />
                  <span>{audienceLabel}</span>
                </div>
                {confirmAction === 'schedule' && form.scheduled_for && (
                  <div className="flex items-start gap-2">
                    <Calendar className="h-4 w-4 mt-0.5 text-muted-foreground" />
                    <span>
                      Sends at <strong>{fmtPht(localInputToIso(form.scheduled_for) || '')}</strong>
                    </span>
                  </div>
                )}
                <div className="flex items-start gap-2">
                  <Send className="h-4 w-4 mt-0.5 text-muted-foreground" />
                  <span>
                    Email{' '}
                    <strong>{form.send_email ? 'will be sent' : 'will NOT be sent'}</strong>
                  </span>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirm}
              disabled={isPending}
              className="gold-gradient text-primary-foreground"
            >
              {isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
