import { useState } from 'react';
import { Shield, Check, X, Loader2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { usePermissions } from '@/contexts/PermissionsContext';
import { toast } from '@/hooks/use-toast';

const ROLES = ['admin', 'staff', 'finance', 'csr'] as const;

const PERMISSION_MODULES: { module: string; permissions: { key: string; label: string }[] }[] = [
  {
    module: 'Dashboard',
    permissions: [
      { key: 'view_dashboard', label: 'View Dashboard' },
      { key: 'view_kpis', label: 'View KPIs' },
      { key: 'view_system_health', label: 'System Health Panel' },
      { key: 'view_operations_panel', label: 'Operations Panel' },
      { key: 'view_ai_risk', label: 'AI Risk Panel' },
      { key: 'view_live_collection', label: 'Live Collection Tracker' },
      { key: 'view_overdue_alerts', label: 'Overdue Alerts' },
      { key: 'view_geo_breakdown', label: 'Geo Breakdown' },
      { key: 'view_aging_buckets', label: 'Aging Buckets' },
    ],
  },
  {
    module: 'Layaway Accounts',
    permissions: [
      { key: 'view_accounts', label: 'View Accounts' },
      { key: 'create_account', label: 'Create Account' },
      { key: 'edit_account', label: 'Edit Account' },
      { key: 'delete_account', label: 'Delete Account' },
      { key: 'edit_schedule', label: 'Edit Schedule' },
      { key: 'edit_invoice', label: 'Edit Invoice' },
      { key: 'forfeit_account', label: 'Forfeit Account' },
      { key: 'reactivate_account', label: 'Reactivate Account' },
      { key: 'reassign_owner', label: 'Reassign Owner' },
    ],
  },
  {
    module: 'Payments',
    permissions: [
      { key: 'record_payment', label: 'Record Payment' },
      { key: 'confirm_payment', label: 'Confirm Payment' },
      { key: 'void_payment', label: 'Void Payment' },
      { key: 'restore_payment', label: 'Restore Payment' },
    ],
  },
  {
    module: 'Payment Submissions',
    permissions: [
      { key: 'view_submissions', label: 'View Submissions' },
      { key: 'review_submission', label: 'Review Submission' },
      { key: 'reject_submission', label: 'Reject Submission' },
    ],
  },
  {
    module: 'Customers',
    permissions: [
      { key: 'view_customers', label: 'View Customers' },
      { key: 'edit_customer', label: 'Edit Customer' },
      { key: 'delete_customer', label: 'Delete Customer' },
    ],
  },
  {
    module: 'Collections & Finance',
    permissions: [
      { key: 'view_collections', label: 'View Collections' },
      { key: 'view_finance', label: 'View Finance' },
      { key: 'run_reconciliation', label: 'Run Reconciliation' },
      { key: 'recalculate_balance', label: 'Recalculate Balance' },
    ],
  },
  {
    module: 'Monitoring & Reminders',
    permissions: [
      { key: 'view_monitoring', label: 'View Monitoring' },
      { key: 'send_reminder', label: 'Send Reminders' },
      { key: 'view_reminders', label: 'View Reminders' },
    ],
  },
  {
    module: 'Penalties & Waivers',
    permissions: [
      { key: 'add_penalty', label: 'Add Penalty' },
      { key: 'waive_penalty', label: 'Waive Penalty' },
      { key: 'apply_cap_fix', label: 'Override Penalty Cap' },
      { key: 'view_waivers', label: 'View Waivers' },
    ],
  },
  {
    module: 'Services',
    permissions: [
      { key: 'add_service', label: 'Add Service' },
    ],
  },
  {
    module: 'Analytics & Audit',
    permissions: [
      { key: 'view_analytics', label: 'View Analytics' },
      { key: 'view_audit_logs', label: 'View Audit Logs' },
      { key: 'system_health', label: 'System Health Checks' },
    ],
  },
  {
    module: 'Admin',
    permissions: [
      { key: 'admin_settings', label: 'Access Settings' },
      { key: 'manage_team', label: 'Manage Team' },
      { key: 'revoke_token', label: 'Revoke Tokens' },
      { key: 'regenerate_token', label: 'Regenerate Tokens' },
    ],
  },
];

// Admin-protected permissions that cannot be toggled off for admin
const ADMIN_LOCKED = ['admin_settings', 'manage_team', 'view_dashboard'];

export default function PermissionMatrixTab() {
  const { allPermissions, updatePermission } = usePermissions();
  const [updating, setUpdating] = useState<string | null>(null);

  const getPermission = (role: string, key: string) => {
    const perm = allPermissions.find(p => p.role === role && p.permission_key === key);
    return perm?.is_allowed ?? false;
  };

  const handleToggle = async (role: string, key: string, current: boolean) => {
    // Prevent removing admin's critical permissions
    if (role === 'admin' && ADMIN_LOCKED.includes(key)) {
      toast({ title: 'Protected', description: 'Cannot disable critical admin permissions.', variant: 'destructive' });
      return;
    }

    const id = `${role}-${key}`;
    setUpdating(id);
    try {
      await updatePermission(role, key, !current);
      toast({ title: 'Permission updated', description: `${key} for ${role}: ${!current ? 'Enabled' : 'Disabled'}` });
    } catch {
      toast({ title: 'Error', description: 'Failed to update permission', variant: 'destructive' });
    }
    setUpdating(null);
  };

  const roleLabel = (r: string) => r.charAt(0).toUpperCase() + r.slice(1);

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-center gap-2 mb-1">
          <Shield className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-card-foreground">Permission Matrix</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-5">
          Control what each role can see and do. Changes apply instantly across the system.
        </p>

        <div className="space-y-6">
          {PERMISSION_MODULES.map(mod => (
            <div key={mod.module}>
              <h4 className="text-xs font-bold text-primary/80 uppercase tracking-wider mb-2 flex items-center gap-2">
                <span className="h-px flex-1 bg-border" />
                {mod.module}
                <span className="h-px flex-1 bg-border" />
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 px-3 font-medium text-muted-foreground w-[200px]">Permission</th>
                      {ROLES.map(r => (
                        <th key={r} className="text-center py-2 px-2 font-medium text-muted-foreground w-[100px]">
                          <Badge
                            variant={r === 'admin' ? 'destructive' : r === 'finance' ? 'default' : r === 'csr' ? 'secondary' : 'outline'}
                            className="text-[9px] capitalize"
                          >
                            {roleLabel(r)}
                          </Badge>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {mod.permissions.map(perm => (
                      <tr key={perm.key} className="border-b border-border/30 hover:bg-muted/20">
                        <td className="py-2 px-3 text-foreground font-medium">{perm.label}</td>
                        {ROLES.map(role => {
                          const allowed = getPermission(role, perm.key);
                          const isLocked = role === 'admin' && ADMIN_LOCKED.includes(perm.key);
                          const isUpdating = updating === `${role}-${perm.key}`;

                          return (
                            <td key={role} className="text-center py-2 px-2">
                              {isUpdating ? (
                                <Loader2 className="h-4 w-4 animate-spin mx-auto text-primary" />
                              ) : (
                                <Switch
                                  checked={allowed}
                                  onCheckedChange={() => handleToggle(role, perm.key, allowed)}
                                  disabled={isLocked}
                                  className={`mx-auto ${allowed ? 'data-[state=checked]:bg-primary' : ''}`}
                                />
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
