import { useState, useMemo } from 'react';
import { Shield, Check, X, Loader2, RotateCcw, ChevronDown } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { usePermissions } from '@/contexts/PermissionsContext';
import { toast } from '@/hooks/use-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

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

const ADMIN_LOCKED = ['admin_settings', 'manage_team', 'view_dashboard'];

type ViewMode = 'role' | 'member';

interface TeamMember {
  user_id: string;
  full_name: string;
  role: string;
}

interface Override {
  permission_key: string;
  granted: boolean;
}

// ── By-Role matrix (unchanged) ─────────────────────────────────────────────
function RoleMatrix({
  allPermissions,
  updating,
  onToggle,
}: {
  allPermissions: any[];
  updating: string | null;
  onToggle: (role: string, key: string, current: boolean) => void;
}) {
  const getPermission = (role: string, key: string) =>
    allPermissions.find(p => p.role === role && p.permission_key === key)?.is_allowed ?? false;

  const roleLabel = (r: string) => r.charAt(0).toUpperCase() + r.slice(1);

  return (
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
                              onCheckedChange={() => onToggle(role, perm.key, allowed)}
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
  );
}

// ── By-Member matrix ────────────────────────────────────────────────────────
function MemberMatrix({
  allPermissions,
  members,
}: {
  allPermissions: any[];
  members: TeamMember[];
}) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string>(members[0]?.user_id ?? '');
  const [saving, setSaving] = useState<string | null>(null);
  const [resettingAll, setResettingAll] = useState(false);

  const selectedMember = members.find(m => m.user_id === selectedId);

  // Fetch overrides for selected member
  const { data: overrides, refetch: refetchOverrides } = useQuery<Override[]>({
    queryKey: ['user-permission-overrides', selectedId],
    enabled: !!selectedId,
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('user_permission_overrides')
        .select('permission_key, granted')
        .eq('user_id', selectedId);
      if (error) throw error;
      return (data || []) as Override[];
    },
  });

  const overrideMap = useMemo(
    () => new Map((overrides || []).map(o => [o.permission_key, o.granted])),
    [overrides],
  );

  const getRoleDefault = (key: string): boolean => {
    if (!selectedMember) return false;
    return allPermissions.find(
      p => p.role === selectedMember.role && p.permission_key === key,
    )?.is_allowed ?? false;
  };

  const handleToggle = async (key: string) => {
    if (!selectedMember) return;
    // Always derive from current effective value (override if present, else role default)
    const currentEffective = overrideMap.has(key)
      ? (overrideMap.get(key) ?? false)
      : getRoleDefault(key);
    const newGranted = !currentEffective;

    setSaving(key);
    try {
      const { error } = await (supabase as any)
        .from('user_permission_overrides')
        .upsert(
          { user_id: selectedId, permission_key: key, granted: newGranted },
          { onConflict: 'user_id,permission_key' },
        );
      if (error) throw error;
      await refetchOverrides();
      queryClient.invalidateQueries({ queryKey: ['user-permission-overrides-counts'] });
      toast({ title: `Permission updated for ${selectedMember.full_name}` });
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    }
    setSaving(null);
  };

  const handleResetOne = async (key: string) => {
    if (!selectedMember) return;
    setSaving(key);
    try {
      const { error } = await (supabase as any)
        .from('user_permission_overrides')
        .delete()
        .eq('user_id', selectedId)
        .eq('permission_key', key);
      if (error) throw error;
      await refetchOverrides();
      queryClient.invalidateQueries({ queryKey: ['user-permission-overrides-counts'] });
      toast({ title: `Reset to role default for ${selectedMember.full_name}` });
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    }
    setSaving(null);
  };

  const handleResetAll = async () => {
    if (!selectedMember) return;
    setResettingAll(true);
    try {
      const { error } = await (supabase as any)
        .from('user_permission_overrides')
        .delete()
        .eq('user_id', selectedId);
      if (error) throw error;
      await refetchOverrides();
      queryClient.invalidateQueries({ queryKey: ['user-permission-overrides-counts'] });
      toast({ title: `Reset all to role defaults for ${selectedMember.full_name}` });
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    }
    setResettingAll(false);
  };

  const overrideCount = overrideMap.size;
  const roleBadgeVariant = (role: string) =>
    role === 'admin' ? 'destructive' : role === 'finance' ? 'default' : role === 'csr' ? 'secondary' : 'outline';

  return (
    <div className="space-y-4">
      {/* Member selector + reset button */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <select
            value={selectedId}
            onChange={e => setSelectedId(e.target.value)}
            className="appearance-none rounded-lg border border-border bg-card text-card-foreground text-xs px-3 py-2 pr-8 focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {members.map(m => (
              <option key={m.user_id} value={m.user_id}>
                {m.full_name} ({m.role})
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        </div>

        {selectedMember && (
          <Badge variant={roleBadgeVariant(selectedMember.role)} className="text-[10px] capitalize">
            <Shield className="h-3 w-3 mr-1" />
            {selectedMember.role}
          </Badge>
        )}

        {overrideCount > 0 && (
          <Badge variant="outline" className="text-[10px] border-amber-500/50 text-amber-400 bg-amber-500/10">
            {overrideCount} custom {overrideCount === 1 ? 'override' : 'overrides'}
          </Badge>
        )}

        <div className="ml-auto">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1.5"
            disabled={overrideCount === 0 || resettingAll}
            onClick={handleResetAll}
          >
            {resettingAll ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
            Reset all to role defaults
          </Button>
        </div>
      </div>

      {/* Permission rows by module */}
      <div className="space-y-6">
        {PERMISSION_MODULES.map(mod => (
          <div key={mod.module}>
            <h4 className="text-xs font-bold text-primary/80 uppercase tracking-wider mb-2 flex items-center gap-2">
              <span className="h-px flex-1 bg-border" />
              {mod.module}
              <span className="h-px flex-1 bg-border" />
            </h4>
            <div className="space-y-0.5">
              {mod.permissions.map(perm => {
                const hasOverride = overrideMap.has(perm.key);
                const roleDefault = getRoleDefault(perm.key);
                const effectiveValue = hasOverride ? (overrideMap.get(perm.key) ?? false) : roleDefault;
                const isSaving = saving === perm.key;

                return (
                  <div
                    key={perm.key}
                    className={`group flex items-center justify-between rounded-lg px-3 py-2 transition-colors hover:bg-muted/20 ${
                      hasOverride ? 'border border-amber-500/20 bg-amber-500/5' : 'border border-transparent'
                    }`}
                  >
                    {/* Left: permission label */}
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`text-xs font-medium ${hasOverride ? 'text-foreground' : 'text-muted-foreground'}`}>
                        {perm.label}
                      </span>
                      {hasOverride && (
                        <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-amber-500/50 text-amber-400 bg-amber-500/10 shrink-0">
                          Custom
                        </Badge>
                      )}
                    </div>

                    {/* Right: toggle + state label + reset */}
                    <div className="flex items-center gap-2 shrink-0">
                      {!hasOverride && (
                        <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                          Role default
                        </span>
                      )}

                      {isSaving ? (
                        <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      ) : (
                        <Switch
                          checked={effectiveValue}
                          onCheckedChange={(_newVal) => handleToggle(perm.key)}
                          className={
                            hasOverride
                              ? 'data-[state=checked]:bg-amber-500 data-[state=unchecked]:bg-amber-900/60'
                              : 'data-[state=checked]:bg-primary/50 data-[state=unchecked]:bg-muted'
                          }
                        />
                      )}

                      {hasOverride && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                          disabled={isSaving}
                          onClick={() => handleResetOne(perm.key)}
                          title="Reset to role default"
                        >
                          <RotateCcw className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main export ─────────────────────────────────────────────────────────────
export default function PermissionMatrixTab() {
  const { allPermissions, updatePermission } = usePermissions();
  const [updating, setUpdating] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('role');

  // Fetch team members for the member view
  const { data: members } = useQuery<TeamMember[]>({
    queryKey: ['settings-team-members'],
    staleTime: 60_000,
    queryFn: async () => {
      const [profilesRes, rolesRes] = await Promise.all([
        supabase.from('profiles').select('user_id, full_name'),
        supabase.from('user_roles').select('user_id, role'),
      ]);
      const roleMap: Record<string, string> = {};
      (rolesRes.data || []).forEach((r: any) => { roleMap[r.user_id] = r.role; });
      return (profilesRes.data || []).map((p: any) => ({
        user_id: p.user_id,
        full_name: p.full_name,
        role: roleMap[p.user_id] || 'staff',
      }));
    },
  });

  const handleRoleToggle = async (role: string, key: string, current: boolean) => {
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

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-6">
        {/* Header + view switcher */}
        <div className="flex items-start justify-between mb-1 flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-card-foreground">Permission Matrix</h3>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/30 p-0.5">
            <button
              onClick={() => setViewMode('role')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                viewMode === 'role'
                  ? 'bg-card text-card-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              By Role
            </button>
            <button
              onClick={() => setViewMode('member')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                viewMode === 'member'
                  ? 'bg-card text-card-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              By Member
            </button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mb-5">
          {viewMode === 'role'
            ? 'Control what each role can see and do. Changes apply instantly across the system.'
            : 'Override individual permissions for a specific team member. Overrides take precedence over role defaults.'}
        </p>

        {viewMode === 'role' ? (
          <RoleMatrix
            allPermissions={allPermissions}
            updating={updating}
            onToggle={handleRoleToggle}
          />
        ) : (
          members && members.length > 0 ? (
            <MemberMatrix allPermissions={allPermissions} members={members} />
          ) : (
            <div className="text-center py-8 text-sm text-muted-foreground">
              Loading team members…
            </div>
          )
        )}
      </div>
    </div>
  );
}
