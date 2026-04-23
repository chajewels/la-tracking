import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '@/constants/routes';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

const BG_LEFT = '#1A1410';
const BG_RIGHT = '#110E0A';
const GOLD = '#D4AF37';
const GOLD_HOVER = '#E8C547';
const GOLD_BORDER = 'rgba(212,175,55,0.12)';
const INPUT_BG = 'rgba(255,255,255,0.04)';
const INPUT_BORDER = 'rgba(255,255,255,0.08)';

const UNSPLASH_HERO =
  'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/brand-assets/IMG_3197.jpeg';

export default function Login() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (session && !window.location.hash.includes('type=recovery')) {
      navigate(ROUTES.DASHBOARD, { replace: true });
    }
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
    <div className="min-h-screen flex flex-col lg:flex-row" style={{ background: BG_RIGHT }}>
      {/* LEFT PANEL — 55% */}
      <div
        className="hidden lg:flex lg:w-[55%] relative overflow-hidden flex-col"
        style={{
          background: `radial-gradient(ellipse at 60% 50%, rgba(212,175,55,0.07) 0%, ${BG_LEFT} 65%)`,
        }}
      >
        <div
          className="absolute inset-0 z-10"
          style={{
            background:
              'linear-gradient(to bottom, #1A1410 8%, transparent 35%, transparent 75%, #1A1410 100%)',
          }}
        />
        <img
          src={UNSPLASH_HERO}
          alt=""
          className="absolute inset-0 w-full h-full object-cover opacity-45"
          style={{ mixBlendMode: 'normal' }}
        />

        {/* Centered brand block */}
        <div
          className={`relative z-20 flex-1 flex flex-col items-center justify-center h-full text-center px-12 transition-all duration-700 ${
            mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
          }`}
        >
          <div className="relative mb-2">
            <img
              src="https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/brand-assets/cha-jewels-logo.png"
              alt="Cha Jewels"
              className="w-32 h-32 object-contain"
              style={{
                filter: 'drop-shadow(0 0 20px rgba(212,175,55,0.5))',
              }}
            />
          </div>
          <p
            className="font-display text-sm font-light mt-6"
            style={{ color: GOLD, letterSpacing: '0.4em' }}
          >
            CHA JEWELS
          </p>
          <div className="w-10 h-px my-5" style={{ background: 'rgba(212,175,55,0.5)' }} />
          <p
            className="text-xs font-light opacity-60"
            style={{ color: '#fff', letterSpacing: '0.3em' }}
          >
            Management Portal
          </p>
        </div>

        {/* Bottom left branding */}
        <div className="relative z-20 p-8 opacity-30">
          <p className="text-[10px] text-white" style={{ letterSpacing: '0.2em' }}>
            © {new Date().getFullYear()} CHA JEWELS CO., LTD.
          </p>
          <p className="text-[10px] text-white mt-1" style={{ letterSpacing: '0.3em' }}>
            LUXURY · DISCIPLINE · INVESTMENT
          </p>
        </div>
      </div>

      {/* RIGHT PANEL — 45% */}
      <div
        className="flex-1 lg:w-[45%] relative flex flex-col justify-between"
        style={{ background: BG_RIGHT, borderLeft: `1px solid ${GOLD_BORDER}` }}
      >
        {/* Mobile hero */}
        <div
          className="lg:hidden absolute inset-0 z-0"
          style={{
            backgroundImage: `url(${UNSPLASH_HERO})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        >
          <div className="absolute inset-0" style={{ background: 'rgba(10,8,6,0.85)' }} />
        </div>

        {/* Form */}
        <div className="relative z-10 flex-1 flex flex-col items-center justify-center h-full px-6 sm:px-12 lg:px-16 xl:px-20">
          <div
            className={`w-full max-w-sm transition-all duration-700 ${
              mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
            }`}
          >
            {/* Heading */}
            <h2
              className="font-display text-2xl font-light tracking-wide"
              style={{ color: '#fff' }}
            >
              Welcome Back
            </h2>
            <p
              className="text-xs font-light mb-10 mt-2"
              style={{ color: GOLD, letterSpacing: '0.2em' }}
            >
              Access your Cha Jewels Hub
            </p>

            {/* Form */}
            <form onSubmit={handleLogin} className="space-y-5">
              <div className="space-y-1.5">
                <label
                  className="text-[10px] font-medium uppercase block"
                  style={{ color: GOLD, letterSpacing: '0.2em' }}
                >
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@chajewels.com"
                  className="w-full h-11 px-4 rounded-lg text-sm outline-none transition-all duration-300 text-white"
                  style={{
                    background: INPUT_BG,
                    border: `1px solid ${INPUT_BORDER}`,
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = GOLD;
                    e.target.style.boxShadow = '0 0 0 1px rgba(212,175,55,0.2)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = INPUT_BORDER;
                    e.target.style.boxShadow = 'none';
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <label
                  className="text-[10px] font-medium uppercase block"
                  style={{ color: GOLD, letterSpacing: '0.2em' }}
                >
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full h-11 px-4 rounded-lg text-sm outline-none transition-all duration-300 text-white"
                  style={{
                    background: INPUT_BG,
                    border: `1px solid ${INPUT_BORDER}`,
                  }}
                  onFocus={(e) => {
                    e.target.style.borderColor = GOLD;
                    e.target.style.boxShadow = '0 0 0 1px rgba(212,175,55,0.2)';
                  }}
                  onBlur={(e) => {
                    e.target.style.borderColor = INPUT_BORDER;
                    e.target.style.boxShadow = 'none';
                  }}
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full h-11 rounded-lg font-semibold text-sm uppercase transition-all duration-300 disabled:opacity-50"
                style={{
                  background: GOLD,
                  color: '#0A0A0A',
                  letterSpacing: '0.15em',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = GOLD_HOVER;
                  e.currentTarget.style.boxShadow = '0 4px 20px rgba(212,175,55,0.25)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = GOLD;
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                {loading ? 'Signing in…' : 'SIGN IN'}
              </button>
            </form>

            {/* Secondary links */}
            <div className="flex items-center justify-between mt-5">
              <button
                className="text-[11px] tracking-wide transition-colors duration-300"
                style={{ color: 'rgba(255,255,255,0.3)' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = GOLD)}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.3)')}
                onClick={() => navigate('/forgot-password')}
              >
                Forgot Password?
              </button>
              <button
                className="text-[11px] tracking-wide transition-colors duration-300"
                style={{ color: 'rgba(255,255,255,0.3)' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = GOLD)}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.3)')}
                onClick={() => window.open('https://m.me/chajewelsjapan', '_blank')}
              >
                Contact Support
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
