import { useState } from 'react';
import { motion } from 'framer-motion';
import { Copy, Check, Users, Coins } from 'lucide-react';
import { toast } from 'sonner';
import { REFERRAL } from '@/components/loyalty/staticFallback';

export default function ReferralSection() {
  const [copied, setCopied] = useState(false);

  const shareMessage = `Join Cha Jewels Loyalty with my code ${REFERRAL.code} and we both earn rewards! ${REFERRAL.link}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(REFERRAL.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleWhatsApp = () => {
    window.open('https://wa.me/?text=' + encodeURIComponent(shareMessage), '_blank');
  };

  const handleMessenger = () => {
    window.open('fb-messenger://share/?link=' + encodeURIComponent(REFERRAL.link), '_blank');
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(REFERRAL.link);
    toast('Link copied!');
  };

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Join Cha Jewels Loyalty', text: shareMessage, url: REFERRAL.link });
      } catch {
        // user cancelled — no toast
      }
    } else {
      navigator.clipboard.writeText(REFERRAL.link);
      toast('Link copied!');
    }
  };

  const SHARE_CHANNELS = [
    { name: 'WhatsApp', emoji: '💬', color: 'bg-[hsl(142,70%,45%)]/10', onClick: handleWhatsApp },
    { name: 'Messenger', emoji: '💙', color: 'bg-[hsl(214,89%,52%)]/10', onClick: handleMessenger },
    { name: 'Copy Link', emoji: '🔗', color: 'bg-primary/8', onClick: handleCopyLink },
    { name: 'Share', emoji: '📲', color: 'bg-primary/8', onClick: handleShare },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.9 }}
    >
      <h3 className="font-display text-lg font-semibold text-foreground mb-3">Invite & Earn Rewards</h3>
      <div className="bg-card rounded-2xl p-5 shadow-card border-gold-accent space-y-4">
        <p className="text-[13px] text-muted-foreground font-body leading-relaxed">
          Invite your friends to Cha Jewels and both of you earn rewards. You get{' '}
          <span className="font-semibold text-primary">{REFERRAL.bonusPerReferral} points</span> per referral,
          and your friend receives{' '}
          <span className="font-semibold text-primary">{REFERRAL.welcomeBonus} welcome points</span>.
        </p>

        <div className="bg-background/60 rounded-xl p-4 border-gold-accent">
          <p className="text-[11px] text-muted-foreground font-body tracking-[0.2em] uppercase mb-2">
            Your Referral Code
          </p>
          <div className="flex items-center justify-between">
            <p className="font-display text-xl font-bold text-foreground tracking-wide">{REFERRAL.code}</p>
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-[12px] font-body font-semibold"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div className="bg-background/60 rounded-xl p-3 text-center border-gold-accent">
            <Users size={14} className="text-primary mx-auto mb-1" />
            <p className="font-display text-xl font-bold text-foreground">{REFERRAL.friendsReferred}</p>
            <p className="text-[10px] text-muted-foreground font-body tracking-wider uppercase mt-0.5">
              Friends Referred
            </p>
          </div>
          <div className="bg-background/60 rounded-xl p-3 text-center border-gold-accent">
            <Coins size={14} className="text-primary mx-auto mb-1" />
            <p className="font-display text-xl font-bold text-foreground">{REFERRAL.pointsEarned}</p>
            <p className="text-[10px] text-muted-foreground font-body tracking-wider uppercase mt-0.5">
              Points Earned
            </p>
          </div>
        </div>

        <div>
          <p className="text-[11px] text-muted-foreground font-body tracking-[0.15em] uppercase mb-2">Share Via</p>
          <div className="grid grid-cols-4 gap-2">
            {SHARE_CHANNELS.map((ch) => (
              <button
                key={ch.name}
                onClick={ch.onClick}
                className={`flex flex-col items-center gap-1.5 py-2.5 rounded-xl ${ch.color} hover:shadow-card transition-shadow`}
              >
                <span className="text-base">{ch.emoji}</span>
                <span className="text-[10px] font-body font-medium text-muted-foreground">{ch.name}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
