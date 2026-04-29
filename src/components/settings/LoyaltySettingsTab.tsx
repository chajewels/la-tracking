import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, ExternalLink } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
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
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

function useLoyaltyEnabled() {
  return useQuery({
    queryKey: ['settings', 'loyalty_enabled'],
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'loyalty_enabled')
        .maybeSingle();
      const raw = data?.value;
      if (raw == null) return false;
      try {
        const parsed = JSON.parse(String(raw));
        return parsed === true || parsed === 'true';
      } catch {
        return String(raw).toLowerCase() === 'true';
      }
    },
  });
}

export default function LoyaltySettingsTab() {
  const { roles } = useAuth();
  const rolesArr = roles as any[];
  const isAdmin = rolesArr.includes('admin');
  const queryClient = useQueryClient();

  const flagQuery = useLoyaltyEnabled();
  const featureEnabled = flagQuery.data ?? false;

  const [confirmEnable, setConfirmEnable] = useState(false);
  const [flagSaving, setFlagSaving] = useState(false);

  async function applyFlag(next: boolean) {
    setFlagSaving(true);
    try {
      const { error } = await supabase
        .from('system_settings')
        .upsert({ key: 'loyalty_enabled', value: next }, { onConflict: 'key' });
      if (error) throw error;
      toast.success(
        next
          ? 'Loyalty program enabled for all customers'
          : 'Loyalty program set to beta mode',
      );
      await queryClient.invalidateQueries({ queryKey: ['settings', 'loyalty_enabled'] });
      await queryClient.invalidateQueries({ queryKey: ['loyalty-access'] });
    } catch (err: any) {
      toast.error(err?.message || 'Could not update feature flag');
    } finally {
      setFlagSaving(false);
    }
  }

  async function handleFlagChange(next: boolean) {
    if (next) {
      setConfirmEnable(true);
    } else {
      await applyFlag(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg gold-gradient">
          <Sparkles className="h-5 w-5 text-primary-foreground" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-foreground font-display">
            Loyalty Program Settings
          </h2>
          <p className="text-xs text-muted-foreground">
            Master feature flag — full management lives in the Loyalty Portal
          </p>
        </div>
      </div>

      {/* Feature flag (admin only) */}
      {isAdmin ? (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">
                Loyalty Program Status
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {flagQuery.isLoading
                  ? 'Loading…'
                  : featureEnabled
                  ? 'Loyalty program is LIVE for all customers. Beta whitelist is now superseded — all enrolled customers have access.'
                  : 'Loyalty program is in BETA MODE. Only customers in the beta whitelist can access the loyalty UI. Toggle ON to launch to all customers.'}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span
                className={`text-[11px] font-semibold uppercase tracking-wider ${
                  featureEnabled ? 'text-emerald-700' : 'text-amber-700'
                }`}
              >
                {featureEnabled ? 'Enabled for All' : 'Beta Mode Only'}
              </span>
              <Switch
                checked={featureEnabled}
                disabled={flagQuery.isLoading || flagSaving}
                onCheckedChange={(v) => handleFlagChange(v)}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-sm text-muted-foreground">
            Loyalty feature flag is admin-only. Open the Loyalty Portal for
            program data and member management.
          </p>
        </div>
      )}

      {/* Manage in Loyalty Portal */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Loyalty Portal</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Members, redemptions, beta whitelist, and program stats all live
              in one place.
            </p>
          </div>
          <Link
            to="/loyalty/admin"
            className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 shrink-0"
          >
            Manage in Loyalty Portal
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </div>

      {/* Confirmation: enabling for all customers */}
      <AlertDialog
        open={confirmEnable}
        onOpenChange={(o) => (!o ? setConfirmEnable(false) : undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable loyalty for all customers?</AlertDialogTitle>
            <AlertDialogDescription>
              This will enable the loyalty UI for ALL customers, regardless of the
              beta whitelist. Beta gating is bypassed once this is on. Are you sure?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={flagSaving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={flagSaving}
              onClick={async () => {
                setConfirmEnable(false);
                await applyFlag(true);
              }}
              className="gold-gradient text-primary-foreground"
            >
              {flagSaving ? 'Saving…' : 'Enable for All'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
