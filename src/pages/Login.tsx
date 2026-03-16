import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import chaJewelsLogo from '@/assets/cha-jewels-logo.jpeg';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useEffect } from 'react';

export default function Login() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (session) navigate('/', { replace: true });
  }, [session, navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      toast.error('Please enter your credentials');
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success('Welcome to Cha Jewels');
    navigate('/');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background dark p-4">
      <div className="w-full max-w-sm animate-fade-in">
        <div className="text-center mb-8">
          <img
            src={chaJewelsLogo}
            alt="Cha Jewels"
            className="h-24 w-24 mx-auto rounded-2xl object-cover mb-4"
          />
          <h1 className="text-xl font-bold text-foreground font-display tracking-wide">
            CHA JEWELS
          </h1>
          <p className="text-xs text-muted-foreground mt-1 tracking-wider font-medium">
            LAYAWAY MANAGEMENT
          </p>
        </div>

        <form onSubmit={handleLogin} className="rounded-xl border border-border bg-card p-6 space-y-4">
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
          <Button type="submit" disabled={loading} className="w-full gold-gradient text-primary-foreground font-semibold">
            {loading ? 'Signing in…' : 'Sign In'}
          </Button>
          <p className="text-center text-[10px] text-muted-foreground">
            Don't have an account?{' '}
            <Link to="/signup" className="text-primary hover:underline">Sign up</Link>
          </p>
        </form>

        <p className="text-center text-[10px] text-muted-foreground/50 mt-6">
          © {new Date().getFullYear()} Cha Jewels Co., Ltd.
        </p>
      </div>
    </div>
  );
}
