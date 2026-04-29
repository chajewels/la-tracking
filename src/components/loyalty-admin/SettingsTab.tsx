import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Sparkles,
  Mail,
  FileSpreadsheet,
  Lock,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  useLoyaltySettings,
  useUpdateLoyaltySetting,
  type LoyaltySettings,
  type LoyaltySettingKey,
  type LoyaltySheetFrequency,
} from '@/hooks/loyalty-admin/useLoyaltySettings';

const EMAIL_TOGGLES: Array<{
  key: keyof LoyaltySettings;
  label: string;
  description: string;
}> = [
  {
    key: 'loyalty_email_welcome',
    label: 'Welcome',
    description: 'Sent when a customer joins the loyalty program',
  },
  {
    key: 'loyalty_email_earned',
    label: 'Points Earned',
    description: 'Sent when points are awarded for a purchase',
  },
  {
    key: 'loyalty_email_bonus',
    label: 'Promo Bonus',
    description: 'Sent when promo bonus points are awarded',
  },
  {
    key: 'loyalty_email_tier_upgrade',
    label: 'Tier Upgrade',
    description: 'Sent on tier promotion',
  },
  {
    key: 'loyalty_email_tier_downgrade',
    label: 'Tier Downgrade',
    description: 'Sent on tier demotion (after inactivity)',
  },
  {
    key: 'loyalty_email_pre_expire',
    label: 'Pre-Expire Warning',
    description: 'Sent 14 days before inactivity threshold',
  },
  {
    key: 'loyalty_email_expire_deduct',
    label: 'Points Expired',
    description: 'Sent when points are zeroed for inactivity',
  },
  {
    key: 'loyalty_email_redeem',
    label: 'Redemption Approved',
    description: 'Sent when a redemption request is approved',
  },
];

function SectionHeader({
  Icon,
  title,
  subtitle,
}: {
  Icon: typeof Sparkles;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-primary" />
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="text-[11px] text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

export default function SettingsTab() {
  const { roles } = useAuth();
  const rolesArr = roles as any[];
  const isAdmin = rolesArr.includes('admin');

  const settingsQuery = useLoyaltySettings();
  const updateMutation = useUpdateLoyaltySetting();

  const settings = settingsQuery.data;

  const [confirmEnable, setConfirmEnable] = useState(false);

  // Local mirror for sheet config so blur-to-save feels responsive
  const [sheetId, setSheetId] = useState('');
  const [serviceAccount, setServiceAccount] = useState('');
  useEffect(() => {
    if (settings) {
      setSheetId(settings.loyalty_sheet_id);
      setServiceAccount(settings.loyalty_sheet_service_account);
    }
  }, [settings?.loyalty_sheet_id, settings?.loyalty_sheet_service_account]);

  async function applyKey<K extends LoyaltySettingKey>(
    key: K,
    newValue: LoyaltySettings[K],
  ) {
    if (!settings) return;
    const oldValue = settings[key];
    if (oldValue === newValue) return;
    try {
      await updateMutation.mutateAsync({ key, newValue, oldValue });
      toast.success(`${key} updated`);
    } catch (err: any) {
      toast.error(err?.message || `Could not update ${key}`);
    }
  }

  async function handleFlagChange(next: boolean) {
    if (next) {
      setConfirmEnable(true);
    } else {
      await applyKey('loyalty_enabled', false);
    }
  }

  if (settingsQuery.isError) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
        <p className="text-sm text-destructive">Failed to load settings</p>
      </div>
    );
  }

  if (settingsQuery.isLoading || !settings) {
    return (
      <div className="space-y-4">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-32 rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 1. Master flag */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        <SectionHeader
          Icon={Sparkles}
          title="Loyalty Program Status"
          subtitle="Master flag — controls whether the loyalty UI is visible to customers"
        />
        {isAdmin ? (
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <p className="text-xs text-muted-foreground flex-1 min-w-0">
              {settings.loyalty_enabled
                ? 'Loyalty program is LIVE for all customers. Beta whitelist is now superseded — all enrolled customers have access.'
                : 'Loyalty program is in BETA MODE. Only customers in the beta whitelist can access the loyalty UI.'}
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <span
                className={`text-[11px] font-semibold uppercase tracking-wider ${
                  settings.loyalty_enabled ? 'text-emerald-700' : 'text-amber-700'
                }`}
              >
                {settings.loyalty_enabled ? 'Enabled for All' : 'Beta Mode Only'}
              </span>
              <Switch
                checked={settings.loyalty_enabled}
                disabled={updateMutation.isPending}
                onCheckedChange={handleFlagChange}
              />
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Master flag is admin-only.
          </p>
        )}
      </div>

      {/* 2. Hardcoded values (display only) */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        <SectionHeader
          Icon={Lock}
          title="Program Constants"
          subtitle="Display-only — engineering change required to modify"
        />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div className="rounded-lg border border-border bg-background p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Base Rate
            </p>
            <p className="text-sm font-semibold mt-0.5">100 pts / ¥10,000</p>
            <p className="text-[10px] text-muted-foreground mt-1">
              Multiplied by tier multiplier
            </p>
          </div>
          <div className="rounded-lg border border-border bg-background p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Activity Threshold
            </p>
            <p className="text-sm font-semibold mt-0.5">6 months</p>
            <p className="text-[10px] text-muted-foreground mt-1">
              Inactivity triggers tier downgrade
            </p>
          </div>
          <div className="rounded-lg border border-border bg-background p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Points Expiry
            </p>
            <p className="text-sm font-semibold mt-0.5">On downgrade</p>
            <p className="text-[10px] text-muted-foreground mt-1">
              Points zero out at downgrade time
            </p>
          </div>
        </div>
      </div>

      {/* 3. Email toggles */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        <SectionHeader
          Icon={Mail}
          title="Email Notifications"
          subtitle="Control which loyalty events send a transactional email"
        />
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200 flex gap-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <p>
            Phase 2 ships UI only. Toggling stores the preference in
            system_settings, but every send-site still fires
            unconditionally until Phase 2.5 wires the gates.
          </p>
        </div>
        <div className="space-y-2">
          {EMAIL_TOGGLES.map((t) => {
            const value = settings[t.key] as boolean;
            return (
              <div
                key={t.key}
                className="flex items-center justify-between gap-3 py-2 border-b border-border/50 last:border-0"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{t.label}</p>
                  <p className="text-[11px] text-muted-foreground">{t.description}</p>
                </div>
                <Switch
                  checked={value}
                  disabled={!isAdmin || updateMutation.isPending}
                  onCheckedChange={(v) => applyKey(t.key as LoyaltySettingKey, v)}
                />
              </div>
            );
          })}
        </div>
        {!isAdmin && (
          <p className="text-[11px] text-muted-foreground italic">
            Email toggles are admin-only.
          </p>
        )}
      </div>

      {/* 4. Google Sheets sync */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        <SectionHeader
          Icon={FileSpreadsheet}
          title="Google Sheets Sync"
          subtitle="Mirror loyalty events to a Google Sheet for backup"
        />
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200 flex gap-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <p>
            <code>sync-loyalty-to-sheet</code> is a stub. Configuration is
            stored, but actual sync is deferred until a Google service account
            is provisioned.
          </p>
        </div>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="sheet-id" className="text-xs">
              Spreadsheet ID
            </Label>
            <Input
              id="sheet-id"
              value={sheetId}
              onChange={(e) => setSheetId(e.target.value)}
              onBlur={() => applyKey('loyalty_sheet_id', sheetId)}
              placeholder="e.g. 15_YAjsYtlXJmFKpMTkHV9QAhvt26PcmhmWsuQ1PFi6k"
              disabled={!isAdmin || updateMutation.isPending}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="service-account" className="text-xs">
              Service Account Email
            </Label>
            <Input
              id="service-account"
              value={serviceAccount}
              onChange={(e) => setServiceAccount(e.target.value)}
              onBlur={() => applyKey('loyalty_sheet_service_account', serviceAccount)}
              placeholder="e.g. loyalty-sync@project.iam.gserviceaccount.com"
              disabled={!isAdmin || updateMutation.isPending}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sync-frequency" className="text-xs">
              Sync Frequency
            </Label>
            <Select
              value={settings.loyalty_sheet_sync_frequency}
              onValueChange={(v) =>
                applyKey('loyalty_sheet_sync_frequency', v as LoyaltySheetFrequency)
              }
              disabled={!isAdmin || updateMutation.isPending}
            >
              <SelectTrigger id="sync-frequency" className="w-full sm:w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">Manual only</SelectItem>
                <SelectItem value="hourly">Hourly</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Button
              variant="outline"
              size="sm"
              disabled
              title="Sync function is a stub — see CLAUDE.md backlog"
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              Sync Now
            </Button>
            <p className="text-[10px] text-muted-foreground mt-1">
              Disabled — sync function will activate when the stub is replaced
              with a real implementation.
            </p>
          </div>
        </div>
      </div>

      {/* Confirmation: enable for all */}
      <AlertDialog
        open={confirmEnable}
        onOpenChange={(o) => (!o ? setConfirmEnable(false) : undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable loyalty for all customers?</AlertDialogTitle>
            <AlertDialogDescription>
              This will enable the loyalty UI for ALL customers, regardless of
              the beta whitelist. Beta gating is bypassed once this is on.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={updateMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={updateMutation.isPending}
              onClick={async () => {
                setConfirmEnable(false);
                await applyKey('loyalty_enabled', true);
              }}
              className="gold-gradient text-primary-foreground"
            >
              {updateMutation.isPending ? 'Saving…' : 'Enable for All'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
