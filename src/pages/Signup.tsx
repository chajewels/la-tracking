import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import chaJewelsLogo from '@/assets/cha-jewels-logo.jpeg';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

type AppRole = 'admin' | 'staff' | 'finance' | 'csr';

export default function Signup() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<AppRole>('csr');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password || !fullName) {
      toast.error('Please fill in all fields');
      return;
    }
    if (password.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin,
        data: { full_name: fullName, requested_role: role },
      },
    });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setSent(true);
    toast.success('Check your email to verify your account');
  };

  if (sent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background dark p-4">
        <div className="w-full max-w-sm text-center space-y-4">
          <img src={chaJewelsLogo} alt="Cha Jewels" className="h-20 w-20 mx-auto rounded-2xl object-cover" />
          <h2 className="text-lg font-bold text-foreground">Check Your Email</h2>
          <p className="text-sm text-muted-foreground">
            We've sent a verification link to <strong className="text-foreground">{email}</strong>.
            Click it to activate your account.
          </p>
          <p className="text-xs text-muted-foreground">
            An admin will assign your role after verification.
          </p>
          <Link to="/login">
            <Button variant="outline" className="mt-4">Back to Login</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background dark p-4">
      <div className="w-full max-w-sm animate-fade-in">
        <div className="text-center mb-8">
          <img src={chaJewelsLogo} alt="Cha Jewels" className="h-20 w-20 mx-auto rounded-2xl object-cover mb-4" />
          <h1 className="text-xl font-bold text-foreground font-display tracking-wide">CREATE ACCOUNT</h1>
          <p className="text-xs text-muted-foreground mt-1 tracking-wider font-medium">CHA JEWELS STAFF</p>
        </div>

        <form onSubmit={handleSignup} className="rounded-xl border border-border bg-card p-6 space-y-4">
          <div className="space-y-2">
            <Label className="text-card-foreground text-xs font-medium">Full Name</Label>
            <Input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Juan Dela Cruz"
              className="bg-background border-border"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-card-foreground text-xs font-medium">Email</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@chajewels.com"
              className="bg-background border-border"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-card-foreground text-xs font-medium">Password</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="bg-background border-border"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-card-foreground text-xs font-medium">Requested Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as AppRole)}>
              <SelectTrigger className="bg-background border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="csr">CSR</SelectItem>
                <SelectItem value="staff">Staff</SelectItem>
                <SelectItem value="finance">Finance</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">An admin must approve your role after signup.</p>
          </div>
          <Button type="submit" disabled={loading} className="w-full gold-gradient text-primary-foreground font-semibold">
            {loading ? 'Creating…' : 'Sign Up'}
          </Button>
          <p className="text-center text-[10px] text-muted-foreground">
            Already have an account?{' '}
            <Link to="/login" className="text-primary hover:underline">Sign in</Link>
          </p>
        </form>

        <p className="text-center text-[10px] text-muted-foreground/50 mt-6">
          © {new Date().getFullYear()} Cha Jewels Co., Ltd.
        </p>
      </div>
    </div>
  );
}
