import { useState } from 'react';
import { Zap, Loader2, Shield, Bell, CreditCard, Wrench, Users, BarChart3, Scale, Activity, FileText, Eye } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { usePermissions } from '@/contexts/PermissionsContext';
import { toast } from '@/hooks/use-toast';

const FEATURE_ICONS: Record<string, any> = {
  penalty_system: Shield,
  reminder_system: Bell,
  payment_submissions: CreditCard,
  add_services: Wrench,
  portal_access: Users,
  analytics_module: BarChart3,
  waiver_system: Scale,
  collections_module: Activity,
  audit_logs: FileText,
  csr_monitoring: Eye,
};

export default function FeatureTogglesTab() {
  const { featureToggles, updateFeatureToggle } = usePermissions();
  const [updating, setUpdating] = useState<string | null>(null);

  const handleToggle = async (featureKey: string, current: boolean) => {
    // Don't allow disabling audit logs
    if (featureKey === 'audit_logs') {
      toast({ title: 'Protected', description: 'Audit logging cannot be disabled.', variant: 'destructive' });
      return;
    }

    setUpdating(featureKey);
    try {
      await updateFeatureToggle(featureKey, !current);
      toast({
        title: !current ? 'Feature Enabled' : 'Feature Disabled',
        description: `${featureToggles.find(t => t.feature_key === featureKey)?.label} has been ${!current ? 'enabled' : 'disabled'}.`,
      });
    } catch {
      toast({ title: 'Error', description: 'Failed to update feature toggle', variant: 'destructive' });
    }
    setUpdating(null);
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-center gap-2 mb-1">
          <Zap className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-card-foreground">Feature Toggles</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-5">
          Enable or disable system features globally. When disabled, the feature is hidden from all users and blocked on the backend.
        </p>

        <div className="grid gap-3">
          {featureToggles.map(toggle => {
            const Icon = FEATURE_ICONS[toggle.feature_key] || Zap;
            const isProtected = toggle.feature_key === 'audit_logs';
            const isUpdating = updating === toggle.feature_key;

            return (
              <div
                key={toggle.feature_key}
                className={`flex items-center justify-between rounded-lg border px-4 py-3 transition-all ${
                  toggle.is_enabled
                    ? 'border-primary/30 bg-primary/5'
                    : 'border-border bg-muted/20 opacity-60'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`h-9 w-9 rounded-lg flex items-center justify-center ${
                    toggle.is_enabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                  }`}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{toggle.label}</span>
                      <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                        toggle.is_enabled
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : 'bg-muted text-muted-foreground'
                      }`}>
                        {toggle.is_enabled ? 'ON' : 'OFF'}
                      </span>
                    </div>
                    {toggle.description && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">{toggle.description}</p>
                    )}
                    <span className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">{toggle.module}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {isUpdating ? (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  ) : (
                    <Switch
                      checked={toggle.is_enabled}
                      onCheckedChange={() => handleToggle(toggle.feature_key, toggle.is_enabled)}
                      disabled={isProtected}
                      className={toggle.is_enabled ? 'data-[state=checked]:bg-primary' : ''}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
