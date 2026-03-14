import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import chaJewelsLogo from '@/assets/cha-jewels-logo.jpeg';
import { toast } from 'sonner';

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      toast.error('Please enter your credentials');
      return;
    }
    toast.success('Welcome to Cha Jewels');
    navigate('/');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background dark p-4">
      <div className="w-full max-w-sm animate-fade-in">
        {/* Logo & Title */}
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

        {/* Login Form */}
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
          <Button type="submit" className="w-full gold-gradient text-primary-foreground font-semibold">
            Sign In
          </Button>
          <p className="text-center text-[10px] text-muted-foreground">
            Contact your administrator for access
          </p>
        </form>

        <p className="text-center text-[10px] text-muted-foreground/50 mt-6">
          © {new Date().getFullYear()} Cha Jewels Co., Ltd.
        </p>
      </div>
    </div>
  );
}
