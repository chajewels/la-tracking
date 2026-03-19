import { useState, useEffect } from 'react';
import { Settings, UserPlus, Users, Shield, Eye, EyeOff, RotateCcw } from 'lucide-react';
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

type TeamMember = {
  user_id: string;
  full_name: string;
  email: string | null;
  status: string;
  role: string;
};

export default function SettingsPage() {
  const { roles } = useAuth();
  const isAdmin = roles.includes('admin');
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

  const handleSave = () => {
    const parsed = parseFloat(rate);
    if (isNaN(parsed) || parsed <= 0) {
      toast({ title: 'Invalid rate', description: 'Please enter a positive number.', variant: 'destructive' });
      return;
    }
    setConversionRate(parsed);
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

  const roleBadgeColor = (role: string) => {
    switch (role) {
      case 'admin': return 'destructive';
      case 'finance': return 'default';
      case 'csr': return 'secondary';
      default: return 'outline';
    }
  };

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex items-center gap-3">
          <Settings className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground font-display">Settings</h1>
            <p className="text-sm text-muted-foreground mt-0.5">System configuration</p>
          </div>
        </div>

        {/* Currency Conversion Settings */}
        <div className="rounded-xl border border-border bg-card p-6 max-w-lg">
          <h3 className="text-sm font-semibold text-card-foreground mb-4">Currency Conversion</h3>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="rate" className="text-sm text-card-foreground">
                PHP → JPY Conversion Rate
              </Label>
              <p className="text-xs text-muted-foreground">
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
                <Button onClick={handleSave} size="sm">
                  Save
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground mt-2">
                Example: PHP 10,000 ÷ {rate} = ¥ {Math.round(10000 / (parseFloat(rate) || 0.42)).toLocaleString()}
              </p>
            </div>
          </div>
        </div>

        {/* Team Management - Admin Only */}
        {isAdmin && (
          <div className="rounded-xl border border-border bg-card p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold text-card-foreground">Team Members</h3>
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
                        <td className="py-2.5 px-3 text-foreground font-medium">{m.full_name}</td>
                        <td className="py-2.5 px-3 text-muted-foreground">{m.email || '—'}</td>
                        <td className="py-2.5 px-3">
                          <Badge variant={roleBadgeColor(m.role)} className="text-[10px] capitalize">
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
        )}

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
