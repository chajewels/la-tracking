import { motion } from 'framer-motion';
import { Users } from 'lucide-react';

const WHATSAPP_URL = 'https://chat.whatsapp.com/ENdMNvF8N3jB3iG963f6EF';
const LINE_URL = 'https://line.me/ti/g/5fb8KyBCCJ';

export default function CommunityCard() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.4 }}
      className="bg-card rounded-xl p-4 shadow-card border-gold-accent"
    >
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Users size={16} className="text-primary" strokeWidth={2} />
        </div>
        <div className="flex-1">
          <p className="text-[13px] font-body font-semibold text-foreground">
            Join our community
          </p>
          <p className="text-[12px] text-muted-foreground font-body mt-1 leading-relaxed">
            Connect with fellow Cha Jewels members for exclusive updates and community perks.
          </p>
          <div className="flex flex-wrap gap-2 mt-3">
            {/* Darkened from the literal WhatsApp/LINE brand hexes (#25D366,
                #06C755) — white text on those measured 1.98:1 / 2.26:1
                (Lighthouse), far short of WCAG AA's 4.5:1. These shades keep
                the same hue/recognizable green while clearing 5.2:1+. */}
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center rounded-md px-3 py-1.5 text-[12px] font-body font-semibold text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: '#167C3C' }}
            >
              Join on WhatsApp
            </a>
            <a
              href={LINE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center rounded-md px-3 py-1.5 text-[12px] font-body font-semibold text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: '#047D35' }}
            >
              Join on LINE
            </a>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
