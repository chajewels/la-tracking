import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import chaJewelsLogo from '@/assets/cha-jewels-logo.jpeg';
import luxuryHero from '@/assets/luxury-jewelry-hero.jpg';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

export default function Login() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (session) navigate(ROUTES.DASHBOARD, { replace: true });
  }, [session, navigate]);

  useEffect(() => {
    setMounted(true);
  }, []);

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
    navigate(ROUTES.DASHBOARD);
  };

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      {/* LEFT — Hero image */}
      <div className="hidden lg:block lg:w-1/2 relative overflow-hidden">
        <img
          src={luxuryHero}
          alt="Cha Jewels luxury collection"
          className="absolute inset-0 w-full h-full object-cover scale-105"
          style={{ animation: 'slowZoom 30s ease-in-out infinite alternate' }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-black/20" />
        <div
          className={`absolute bottom-12 left-10 right-10 transition-all duration-1000 delay-500 ${
            mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
          }`}
        >
          <p className="text-xs tracking-[0.35em] uppercase font-medium mb-3" style={{ color: '#D4AF37' }}>
            Cha Jewels
          </p>
          <h2
            className="text-2xl lg:text-3xl font-light leading-snug"
            style={{ fontFamily: "'Montserrat', sans-serif", color: 'rgba(255,255,255,0.9)' }}
          >
            Everyday Layaway.
            <br />
            <span style={{ color: '#D4AF37' }}>Cha Jewels</span> All the Way.
          </h2>
          <div className="mt-4 w-16 h-px" style={{ background: 'rgba(212,175,55,0.5)' }} />
        </div>
      </div>

      {/* RIGHT — Login panel */}
      <div className="flex-1 lg:w-1/2 relative flex flex-col justify-between" style={{ background: '#0B0B0B' }}>
        {/* Mobile hero background */}
        <div
          className="lg:hidden absolute inset-0 z-0"
          style={{
            backgroundImage: `url(${luxuryHero})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        >
          <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.78)' }} />
        </div>

        {/* Form */}
        <div className="relative z-10 flex-1 flex items-center justify-center px-6 sm:px-12 lg:px-16 xl:px-24">
          <div
            className={`w-full max-w-sm transition-all duration-700 ${
              mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
            }`}
          >
            {/* Logo */}
            <div className="text-center mb-10">
              <div
                className="inline-block rounded-2xl overflow-hidden mb-5"
                style={{ boxShadow: '0 0 40px rgba(212,175,55,0.15)' }}
              >
                <img src={chaJewelsLogo} alt="Cha Jewels" className="h-20 w-20 object-cover" />
              </div>
              <h1
                className="text-lg tracking-[0.25em] font-semibold"
                style={{ fontFamily: "'Montserrat', sans-serif", color: '#D4AF37' }}
              >
                CHA JEWELS
              </h1>
            </div>

            {/* Welcome */}
            <div className="text-center mb-8">
              <h2
                className="text-2xl font-light tracking-wide"
                style={{ fontFamily: "'Montserrat', sans-serif", color: '#fff' }}
              >
                Welcome Back
              </h2>
              <p className="text-xs mt-2 tracking-wider" style={{ color: 'rgba(255,255,255,0.4)' }}>
                Access your Cha Jewels Layaway Portal
              </p>
            </div>

            {/* Form */}
            <form onSubmit={handleLogin} className="space-y-5">
              <div className="space-y-1.5">
                <label
                  className="text-[11px] tracking-widest uppercase font-medium block"
                  style={{ color: 'rgba(255,255,255,0.5)' }}
                >
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@chajewels.com"
                  className="w-full h-11 px-4 rounded-lg text-sm outline-none transition-all duration-300"
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: '#fff',
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = 'rgba(212,175,55,0.6)';
                    e.target.style.boxShadow = '0 0 12px rgba(212,175,55,0.12)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = 'rgba(255,255,255,0.1)';
                    e.target.style.boxShadow = 'none';
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <label
                  className="text-[11px] tracking-widest uppercase font-medium block"
                  style={{ color: 'rgba(255,255,255,0.5)' }}
                >
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full h-11 px-4 rounded-lg text-sm outline-none transition-all duration-300"
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: '#fff',
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = 'rgba(212,175,55,0.6)';
                    e.target.style.boxShadow = '0 0 12px rgba(212,175,55,0.12)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = 'rgba(255,255,255,0.1)';
                    e.target.style.boxShadow = 'none';
                  }}
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full h-11 rounded-lg font-semibold text-sm tracking-wider uppercase transition-all duration-300 disabled:opacity-50"
                style={{
                  background: 'linear-gradient(135deg, #C9A227 0%, #D4AF37 50%, #E8C84A 100%)',
                  color: '#0B0B0B',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget).style.boxShadow = '0 0 24px rgba(212,175,55,0.35)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget).style.boxShadow = 'none';
                }}
              >
                {loading ? 'Signing in…' : 'Sign In'}
              </button>
            </form>

            {/* Secondary links */}
            <div className="flex items-center justify-between mt-5">
              <button
                className="text-[11px] tracking-wide transition-colors duration-300"
                style={{ color: 'rgba(255,255,255,0.3)' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'rgba(212,175,55,0.7)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.3)')}
              >
                Forgot Password?
              </button>
              <button
                className="text-[11px] tracking-wide transition-colors duration-300"
                style={{ color: 'rgba(255,255,255,0.3)' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'rgba(212,175,55,0.7)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.3)')}
              >
                Contact Support
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div
          className={`relative z-10 text-center pb-6 px-6 transition-all duration-700 delay-300 ${
            mounted ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <p className="text-[10px] tracking-[0.2em] uppercase" style={{ color: 'rgba(255,255,255,0.15)' }}>
            © {new Date().getFullYear()} Cha Jewels Co., Ltd.
          </p>
          <p className="text-[9px] tracking-[0.3em] uppercase mt-1" style={{ color: 'rgba(212,175,55,0.2)' }}>
            Luxury · Discipline · Investment
          </p>
        </div>
      </div>

      <style>{`
        @keyframes slowZoom {
          from { transform: scale(1.05); }
          to   { transform: scale(1.15); }
        }
      `}</style>
    </div>
  );
}
