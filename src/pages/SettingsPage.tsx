import { useState, useEffect, useMemo } from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import {
  Settings, UserPlus, Users, Shield, Eye, EyeOff, RotateCcw,
  DollarSign, Bell, Info, ChevronDown, ChevronUp, AlertTriangle,
  MessageSquare, Mail, Clock, Percent, Zap, Grid3X3
} from 'lucide-react';
import PermissionMatrixTab from '@/components/settings/PermissionMatrixTab';
import FeatureTogglesTab from '@/components/settings/FeatureTogglesTab';
import AppLayout from '@/components/layout/AppLayout';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getConversionRate, setConversionRate } from '@/lib/currency-converter';
import { toast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

type TeamMember = {
  user_id: string;
  full_name: string;
  email: string | null;
  status: string;
  role: string;
};

const ROLE_PERMISSIONS: Record<string, { label: string; description: string; permissions: string[] }> = {
  admin: {
    label: 'Admin',
    description: 'Full system access. Can manage team, settings, and all financial operations.',
    permissions: [
      'Create, view, and manage all layaway accounts',
      'Record, void, and restore payments',
      'Approve or reject penalty waivers',
      'Manage team members and assign roles',
      'Configure system settings',
      'View audit logs and financial reports',
      'Send reminders to customers',
      'Access all analytics and dashboards',
    ],
  },
  staff: {
    label: 'Staff',
    description: 'General operations access for day-to-day account management.',
    permissions: [
      'Create, view, and manage layaway accounts',
      'Record payments and view schedules',
      'Request penalty waivers (cannot approve)',
      'View customer information',
      'Send reminders to customers',
      'View dashboard and basic analytics',
    ],
  },
  finance: {
    label: 'Finance',
    description: 'Financial oversight with approval authority for monetary operations.',
    permissions: [
      'View all layaway accounts and payments',
      'Approve or reject penalty waivers',
      'View audit logs and financial reports',
      'Access financial analytics and forecasts',
      'View dashboard and collection data',
    ],
  },
  csr: {
    label: 'CSR (Customer Service)',
    description: 'Customer-facing role focused on inquiries and reminders.',
    permissions: [
      'View layaway accounts and schedules',
      'View customer information',
      'Request penalty waivers on behalf of customers',
      'Send reminders via Messenger and email',
      'View basic dashboard information',
    ],
  },
};

export default function SettingsPage() {
  const { roles } = useAuth();
  const isAdmin = roles.includes('admin');
  const queryClient = useQueryClient();
  const [rate, setRate] = useState(getConversionRate().toString());

  // Team management state
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<string>('staff');
  const [showPassword, setShowPassword] = useState(false);
  const [creating, setCreating] = useState(false);

  // Reset password state
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetUserId, setResetUserId] = useState('');
  const [resetUserName, setResetUserName] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Role info toggle
  const [expandedRole, setExpandedRole] = useState<string | null>(null);

  const fetchMembers = async () => {
    setLoadingMembers(true);
    const [profilesRes, rolesRes] = await Promise.all([
      supabase.from('profiles').select('user_id, full_name, email, status'),
      supabase.from('user_roles').select('user_id, role'),
    ]);
    if (profilesRes.data && rolesRes.data) {
      const roleMap: Record<string, string> = {};
      rolesRes.data.forEach((r) => { roleMap[r.user_id] = r.role; });
      setMembers(
        profilesRes.data.map((p) => ({
          user_id: p.user_id,
          full_name: p.full_name,
          email: p.email,
          status: p.status,
          role: roleMap[p.user_id] || 'unknown',
        }))
      );
    }
    setLoadingMembers(false);
  };

  useEffect(() => {
    if (isAdmin) fetchMembers();
  }, [isAdmin]);

  // Fetch set of user_ids that have any permission override (for Team tab badge)
  const { data: overrideCounts } = useQuery({
    queryKey: ['user-permission-overrides-counts'],
    enabled: isAdmin,
    staleTime: 30_000,
    queryFn: async () => {
      const { data } = await (supabase as any)
        .from('user_permission_overrides')
        .select('user_id');
      const ids = new Set<string>((data || []).map((r: any) => r.user_id as string));
      return ids;
    },
  });

  const usersWithOverrides = useMemo(() => overrideCounts ?? new Set<string>(), [overrideCounts]);

  // On mount: seed localStorage from DB so all devices start with the same rate
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'php_jpy_rate')
        .single();
      if (data) {
        const dbRate = Number(JSON.parse(String(data.value)));
        if (!isNaN(dbRate) && dbRate > 0) {
          setConversionRate(dbRate);
          setRate(dbRate.toString());
        }
      }
    })();
  }, []);

  const handleSave = async () => {
    const parsed = parseFloat(rate);
    if (isNaN(parsed) || parsed <= 0) {
      toast({ title: 'Invalid rate', description: 'Please enter a positive number.', variant: 'destructive' });
      return;
    }
    // Write to DB first (edge function reads this)
    // Use .update() not .upsert() — the row is always seeded in migrations,
    // and there is no INSERT RLS policy on system_settings (only UPDATE for admins)
    const { error: dbError } = await supabase
      .from('system_settings')
      .update({ value: JSON.stringify(parsed) })
      .eq('key', 'php_jpy_rate');
    if (dbError) {
      toast({ title: 'Save failed', description: dbError.message, variant: 'destructive' });
      return;
    }
    // Write to localStorage (client-side conversions)
    setConversionRate(parsed);
    // Invalidate dashboard cache so it refetches with the new rate immediately
    queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    toast({ title: 'Conversion rate updated', description: `PHP → JPY rate set to ${parsed}` });
  };

  const handleCreateMember = async () => {
    if (!newEmail || !newName || !newPassword || !newRole) {
      toast({ title: 'Missing fields', description: 'Please fill in all fields.', variant: 'destructive' });
      return;
    }
    if (newPassword.length < 6) {
      toast({ title: 'Weak password', description: 'Password must be at least 6 characters.', variant: 'destructive' });
      return;
    }
    setCreating(true);
    const { data, error } = await supabase.functions.invoke('create-team-member', {
      body: { email: newEmail, password: newPassword, full_name: newName, role: newRole },
    });
    setCreating(false);
    if (error || data?.error) {
      toast({ title: 'Error', description: data?.error || error?.message || 'Failed to create member', variant: 'destructive' });
      return;
    }
    toast({ title: 'Team member created', description: `${newName} added as ${newRole}` });
    setNewEmail('');
    setNewName('');
    setNewPassword('');
    setNewRole('staff');
    setShowAddDialog(false);
    fetchMembers();
  };

  const handleResetPassword = async () => {
    if (!resetPassword || resetPassword.length < 6) {
      toast({ title: 'Weak password', description: 'Password must be at least 6 characters.', variant: 'destructive' });
      return;
    }
    setResetting(true);
    const { data, error } = await supabase.functions.invoke('create-team-member', {
      body: { action: 'reset_password', user_id: resetUserId, password: resetPassword },
    });
    setResetting(false);
    if (error || data?.error) {
      toast({ title: 'Error', description: data?.error || error?.message || 'Failed to reset password', variant: 'destructive' });
      return;
    }
    toast({ title: 'Password reset', description: `Password updated for ${resetUserName}` });
    setResetDialogOpen(false);
    setResetPassword('');
  };

  const roleBadgeVariant = (role: string) => {
    switch (role) {
      case 'admin': return 'destructive' as const;
      case 'finance': return 'default' as const;
      case 'csr': return 'secondary' as const;
      default: return 'outline' as const;
    }
  };

  const roleColor = (role: string) => {
    switch (role) {
      case 'admin': return 'border-destructive/30 bg-destructive/5';
      case 'finance': return 'border-primary/30 bg-primary/5';
      case 'csr': return 'border-secondary/30 bg-secondary/5';
      default: return 'border-border bg-muted/30';
    }
  };

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex items-center gap-3">
          <Settings className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground font-display">Settings</h1>
            <p className="text-sm text-muted-foreground mt-0.5">System configuration & team management</p>
          </div>
        </div>

        <Tabs defaultValue="general" className="w-full">
          <TabsList className="bg-muted/50 border border-border">
            <TabsTrigger value="general" className="gap-1.5 text-xs">
              <Settings className="h-3.5 w-3.5" />
              General
            </TabsTrigger>
            {isAdmin && (
              <TabsTrigger value="team" className="gap-1.5 text-xs">
                <Users className="h-3.5 w-3.5" />
                Team
              </TabsTrigger>
            )}
            <TabsTrigger value="roles" className="gap-1.5 text-xs">
              <Shield className="h-3.5 w-3.5" />
              Roles & Permissions
            </TabsTrigger>
            {isAdmin && (
              <TabsTrigger value="matrix" className="gap-1.5 text-xs">
                <Grid3X3 className="h-3.5 w-3.5" />
                Permission Matrix
              </TabsTrigger>
            )}
            {isAdmin && (
              <TabsTrigger value="features" className="gap-1.5 text-xs">
                <Zap className="h-3.5 w-3.5" />
                Feature Toggles
              </TabsTrigger>
            )}
          </TabsList>

          {/* ── GENERAL TAB ── */}
          <TabsContent value="general" className="space-y-6 mt-4">
            {/* Currency */}
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="flex items-center gap-2 mb-4">
                <DollarSign className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold text-card-foreground">Currency Conversion</h3>
              </div>
              <div className="space-y-2 max-w-sm">
                <Label htmlFor="rate" className="text-xs text-card-foreground">
                  PHP → JPY Conversion Rate
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  Formula: JPY = PHP ÷ Rate. Default: 0.42
                </p>
                <div className="flex items-center gap-3">
                  <Input
                    id="rate"
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={rate}
                    onChange={(e) => setRate(e.target.value)}
                    className="w-32"
                  />
                  <Button onClick={handleSave} size="sm">Save</Button>
                </div>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Example: PHP 10,000 ÷ {rate} = ¥{Math.round(10000 / (parseFloat(rate) || 0.42)).toLocaleString()}
                </p>
              </div>
            </div>

            {/* Penalty Configuration */}
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="flex items-center gap-2 mb-4">
                <Percent className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold text-card-foreground">Penalty Configuration</h3>
              </div>
              <div className="space-y-4 max-w-lg">
                <div>
                  <Label className="text-xs text-muted-foreground mb-2 block">PHP Accounts</Label>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                      <div>
                        <span className="text-sm text-foreground font-medium">₱ 500</span>
                        <span className="text-[10px] text-muted-foreground ml-1">Week 1</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
                      <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                      <div>
                        <span className="text-sm text-foreground font-medium">₱ 1,000</span>
                        <span className="text-[10px] text-muted-foreground ml-1">Week 2</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground mb-2 block">JPY Accounts</Label>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                      <div>
                        <span className="text-sm text-foreground font-medium">¥ 1,000</span>
                        <span className="text-[10px] text-muted-foreground ml-1">Week 1</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
                      <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                      <div>
                        <span className="text-sm text-foreground font-medium">¥ 2,000</span>
                        <span className="text-[10px] text-muted-foreground ml-1">Week 2</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Trigger</Label>
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
                      <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-sm text-foreground font-medium">7 / 14 days</span>
                      <span className="text-[10px] text-muted-foreground">overdue</span>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Penalty Cycle</Label>
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
                      <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-sm text-foreground font-medium">Every 30 days</span>
                      <span className="text-[10px] text-muted-foreground">repeats</span>
                    </div>
                  </div>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground mt-3 flex items-center gap-1">
                <Info className="h-3 w-3" />
                Fixed penalty amounts per currency. Penalties repeat each 30-day cycle if unpaid.
              </p>
            </div>

            {/* Reminder Settings */}
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="flex items-center gap-2 mb-4">
                <Bell className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold text-card-foreground">Reminder Settings</h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-lg">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Automated Schedule</Label>
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
                    <Clock className="h-3.5 w-3.5 text-primary" />
                    <span className="text-sm text-foreground font-medium">Daily 8:00 AM</span>
                    <span className="text-[10px] text-muted-foreground">PHT</span>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Channels</Label>
                  <div className="flex gap-2">
                    <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2">
                      <MessageSquare className="h-3.5 w-3.5 text-blue-400" />
                      <span className="text-xs text-foreground">Messenger</span>
                    </div>
                    <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2">
                      <Mail className="h-3.5 w-3.5 text-amber-400" />
                      <span className="text-xs text-foreground">Email</span>
                    </div>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Upcoming Window</Label>
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
                    <span className="text-sm text-foreground font-medium">7 days</span>
                    <span className="text-[10px] text-muted-foreground">before due date</span>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Manual Trigger</Label>
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
                    <span className="text-sm text-foreground font-medium">Available</span>
                    <span className="text-[10px] text-muted-foreground">via Monitoring page</span>
                  </div>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground mt-3 flex items-center gap-1">
                <Info className="h-3 w-3" />
                Automated reminders run daily. Use the Monitoring page to send manually.
              </p>
            </div>

            {/* System Info */}
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="flex items-center gap-2 mb-4">
                <Info className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold text-card-foreground">System Information</h3>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'Platform', value: 'Lovable Cloud' },
                  { label: 'Currencies', value: 'PHP, JPY' },
                  { label: 'Auth', value: 'Email / Password' },
                  { label: 'Version', value: 'v1.0' },
                ].map((item) => (
                  <div key={item.label} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                    <p className="text-[10px] text-muted-foreground">{item.label}</p>
                    <p className="text-xs text-foreground font-medium mt-0.5">{item.value}</p>
                  </div>
                ))}
              </div>
            </div>
          </TabsContent>

          {/* ── TEAM TAB ── */}
          {isAdmin && (
            <TabsContent value="team" className="space-y-6 mt-4">
              <div className="rounded-xl border border-border bg-card p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-primary" />
                    <h3 className="text-sm font-semibold text-card-foreground">Team Members</h3>
                    <Badge variant="outline" className="text-[10px] ml-1">{members.length}</Badge>
                  </div>
                  <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
                    <DialogTrigger asChild>
                      <Button size="sm" className="gap-1.5">
                        <UserPlus className="h-3.5 w-3.5" />
                        Add Member
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-md">
                      <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                          <UserPlus className="h-4 w-4" />
                          Add Team Member
                        </DialogTitle>
                      </DialogHeader>
                      <div className="space-y-4 mt-2">
                        <div className="space-y-2">
                          <Label className="text-xs">Full Name</Label>
                          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Juan Dela Cruz" />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs">Email</Label>
                          <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="juan@chajewels.com" />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs">Password</Label>
                          <div className="relative">
                            <Input
                              type={showPassword ? 'text' : 'password'}
                              value={newPassword}
                              onChange={(e) => setNewPassword(e.target.value)}
                              placeholder="Min 6 characters"
                            />
                            <button
                              type="button"
                              onClick={() => setShowPassword(!showPassword)}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            >
                              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs">Role</Label>
                          <Select value={newRole} onValueChange={setNewRole}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="admin">Admin</SelectItem>
                              <SelectItem value="staff">Staff</SelectItem>
                              <SelectItem value="finance">Finance</SelectItem>
                              <SelectItem value="csr">CSR</SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="text-[10px] text-muted-foreground">
                            See the "Roles & Permissions" tab for what each role can do.
                          </p>
                        </div>
                        <Button onClick={handleCreateMember} disabled={creating} className="w-full">
                          {creating ? 'Creating…' : 'Create Member'}
                        </Button>
                      </div>
                    </DialogContent>
                  </Dialog>
                </div>

                {loadingMembers ? (
                  <div className="flex justify-center py-8">
                    <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
                  </div>
                ) : members.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">No team members found.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground">
                          <th className="text-left py-2 px-3 font-medium text-xs">Name</th>
                          <th className="text-left py-2 px-3 font-medium text-xs">Email</th>
                          <th className="text-left py-2 px-3 font-medium text-xs">Role</th>
                          <th className="text-left py-2 px-3 font-medium text-xs">Status</th>
                          <th className="text-right py-2 px-3 font-medium text-xs">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {members.map((m) => (
                          <tr key={m.user_id} className="border-b border-border/50 hover:bg-muted/30">
                            <td className="py-2.5 px-3">
                              <div className="flex items-center gap-2">
                                <span className="text-foreground font-medium">{m.full_name}</span>
                                {usersWithOverrides.has(m.user_id) && (
                                  <Badge variant="outline" className="text-[9px] h-4 px-1.5 border-amber-500/50 text-amber-400 bg-amber-500/10 shrink-0">
                                    Custom permissions
                                  </Badge>
                                )}
                              </div>
                            </td>
                            <td className="py-2.5 px-3 text-muted-foreground text-xs">{m.email || '—'}</td>
                            <td className="py-2.5 px-3">
                              <Badge variant={roleBadgeVariant(m.role)} className="text-[10px] capitalize">
                                <Shield className="h-3 w-3 mr-1" />
                                {m.role}
                              </Badge>
                            </td>
                            <td className="py-2.5 px-3">
                              <span className={`text-xs font-medium ${m.status === 'active' ? 'text-emerald-400' : 'text-muted-foreground'}`}>
                                {m.status}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs gap-1"
                                onClick={() => {
                                  setResetUserId(m.user_id);
                                  setResetUserName(m.full_name);
                                  setResetPassword('');
                                  setResetDialogOpen(true);
                                }}
                              >
                                <RotateCcw className="h-3 w-3" />
                                Reset Password
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </TabsContent>
          )}

          {/* ── ROLES & PERMISSIONS TAB ── */}
          <TabsContent value="roles" className="space-y-4 mt-4">
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="flex items-center gap-2 mb-2">
                <Shield className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold text-card-foreground">Role Definitions</h3>
              </div>
              <p className="text-xs text-muted-foreground mb-4">
                Each team member is assigned one role that determines their access level. Tap a role below to see its permissions.
              </p>

              <div className="space-y-3">
                {Object.entries(ROLE_PERMISSIONS).map(([key, role]) => (
                  <Collapsible
                    key={key}
                    open={expandedRole === key}
                    onOpenChange={() => setExpandedRole(expandedRole === key ? null : key)}
                  >
                    <CollapsibleTrigger className="w-full">
                      <div className={`flex items-center justify-between rounded-lg border px-4 py-3 transition-colors hover:bg-muted/50 ${roleColor(key)}`}>
                        <div className="flex items-center gap-3">
                          <Badge variant={roleBadgeVariant(key)} className="text-[10px] capitalize">
                            <Shield className="h-3 w-3 mr-1" />
                            {role.label}
                          </Badge>
                          <span className="text-xs text-muted-foreground hidden sm:inline">{role.description}</span>
                        </div>
                        {expandedRole === key ? (
                          <ChevronUp className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className={`mt-1 rounded-lg border px-4 py-3 ${roleColor(key)}`}>
                        <p className="text-xs text-muted-foreground mb-2 sm:hidden">{role.description}</p>
                        <ul className="space-y-1.5">
                          {role.permissions.map((perm, i) => (
                            <li key={i} className="flex items-start gap-2 text-xs text-foreground">
                              <span className="text-primary mt-0.5">✓</span>
                              {perm}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                ))}
              </div>
            </div>

            {/* Quick comparison */}
            <div className="rounded-xl border border-border bg-card p-6 overflow-x-auto">
              <h3 className="text-sm font-semibold text-card-foreground mb-3">Quick Comparison</h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 px-2 font-medium text-muted-foreground">Capability</th>
                    <th className="text-center py-2 px-2 font-medium text-muted-foreground">Admin</th>
                    <th className="text-center py-2 px-2 font-medium text-muted-foreground">Staff</th>
                    <th className="text-center py-2 px-2 font-medium text-muted-foreground">Finance</th>
                    <th className="text-center py-2 px-2 font-medium text-muted-foreground">CSR</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { cap: 'Create accounts', admin: true, staff: true, finance: false, csr: false },
                    { cap: 'Record payments', admin: true, staff: true, finance: false, csr: false },
                    { cap: 'Void / restore payments', admin: true, staff: false, finance: false, csr: false },
                    { cap: 'Approve waivers', admin: true, staff: false, finance: true, csr: false },
                    { cap: 'Request waivers', admin: true, staff: true, finance: false, csr: true },
                    { cap: 'View audit logs', admin: true, staff: false, finance: true, csr: false },
                    { cap: 'Manage team', admin: true, staff: false, finance: false, csr: false },
                    { cap: 'System settings', admin: true, staff: false, finance: false, csr: false },
                    { cap: 'Send reminders', admin: true, staff: true, finance: false, csr: true },
                    { cap: 'View analytics', admin: true, staff: true, finance: true, csr: false },
                  ].map((row) => (
                    <tr key={row.cap} className="border-b border-border/50">
                      <td className="py-2 px-2 text-foreground">{row.cap}</td>
                      {[row.admin, row.staff, row.finance, row.csr].map((v, i) => (
                        <td key={i} className="text-center py-2 px-2">
                          {v ? <span className="text-emerald-400">✓</span> : <span className="text-muted-foreground/40">—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TabsContent>

          {/* ── PERMISSION MATRIX TAB ── */}
          {isAdmin && (
            <TabsContent value="matrix" className="mt-4">
              <PermissionMatrixTab />
            </TabsContent>
          )}

          {/* ── FEATURE TOGGLES TAB ── */}
          {isAdmin && (
            <TabsContent value="features" className="mt-4">
              <FeatureTogglesTab />
            </TabsContent>
          )}
        </Tabs>

        {/* Reset Password Dialog */}
        <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Reset Password for {resetUserName}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label className="text-xs">New Password</Label>
                <div className="relative">
                  <Input
                    type={showResetPassword ? 'text' : 'password'}
                    value={resetPassword}
                    onChange={(e) => setResetPassword(e.target.value)}
                    placeholder="Min 6 characters"
                  />
                  <button
                    type="button"
                    onClick={() => setShowResetPassword(!showResetPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showResetPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <Button onClick={handleResetPassword} disabled={resetting} className="w-full">
                {resetting ? 'Resetting…' : 'Reset Password'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}
