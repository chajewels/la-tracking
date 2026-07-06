import { motion } from 'framer-motion';

const BG = '#1A1410';
import { palette } from '@/theme/tokens';

const GOLD = palette.gold500;
const LOGO_URL =
  'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/brand-assets/cha-jewels-logo.png';

const EASE = [0.22, 1, 0.36, 1] as const;

interface AdminSplashScreenProps {
  fadingOut?: boolean;
}

export default function AdminSplashScreen({ fadingOut = false }: AdminSplashScreenProps) {
  return (
    <motion.div
      initial={{ opacity: 1 }}
      animate={{ opacity: fadingOut ? 0 : 1 }}
      transition={{ duration: 0.5, ease: EASE }}
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center overflow-hidden"
      style={{ background: BG }}
    >
      {/* Subtle radial glow */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(212,175,55,0.08) 0%, transparent 60%)',
        }}
      />

      {/* Logo with scale-in */}
      <motion.img
        src={LOGO_URL}
        alt="Cha Jewels"
        initial={{ opacity: 0, scale: 0.85 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 1.4, ease: EASE }}
        className="w-32 h-32 object-contain relative z-10"
        style={{ filter: 'drop-shadow(0 0 24px rgba(212,175,55,0.45))' }}
      />

      {/* Wordmark */}
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.5, ease: EASE }}
        className="font-display text-sm font-light mt-6 relative z-10"
        style={{ color: GOLD, letterSpacing: '0.4em' }}
      >
        CHA JEWELS
      </motion.p>

      {/* Animated divider */}
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: 80 }}
        transition={{ duration: 0.6, delay: 0.8, ease: EASE }}
        className="h-px my-5 relative z-10"
        style={{ background: 'rgba(212,175,55,0.6)' }}
      />

      {/* Tagline 1 */}
      <motion.p
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 1.2, ease: EASE }}
        className="text-[11px] font-medium uppercase relative z-10"
        style={{ color: GOLD, letterSpacing: '0.3em' }}
      >
        Admin Portal
      </motion.p>

      {/* Tagline 2 */}
      <motion.p
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 1.8, ease: EASE }}
        className="text-xs font-light mt-3 relative z-10"
        style={{ color: 'rgba(255,255,255,0.45)', letterSpacing: '0.2em' }}
      >
        Manage Every Layaway
      </motion.p>

      {/* Footer */}
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 2.4, ease: EASE }}
        className="absolute bottom-8 text-[11px] italic relative z-10"
        style={{ color: 'rgba(255,255,255,0.35)', letterSpacing: '0.1em' }}
      >
        Cha Jewels Hub
      </motion.p>
    </motion.div>
  );
}
