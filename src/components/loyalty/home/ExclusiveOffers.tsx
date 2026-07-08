import { motion } from 'framer-motion';

const OFFERS = [
  { title: 'VIP Early Access', desc: 'New gold arrivals before anyone else', tag: 'Radiant+' },
  { title: 'Secret Vault Sale', desc: 'Members-only pricing on select pieces', tag: 'Exclusive' },
  { title: 'Layaway Rewards', desc: 'Earn points on every layaway purchase or order', tag: 'This Week' },
  { title: 'Crown VIP Rewards', desc: 'Mystery gifts & private gold viewings', tag: 'Crown VIP' },
];

export default function ExclusiveOffers() {
  return (
    <div>
      <h3 className="font-display text-lg font-semibold text-foreground mb-3">Exclusive for You</h3>
      <div className="flex gap-3 overflow-x-auto pb-3 -mx-5 px-5 scrollbar-hide">
        {OFFERS.map((offer, i) => (
          <motion.div
            key={offer.title}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1 * i + 1 }}
            className="bg-card rounded-xl p-4 shadow-card border-gold-accent min-w-[180px] flex-shrink-0 hover:shadow-soft transition-shadow cursor-pointer"
          >
            <span className="text-[10px] tracking-[0.3em] uppercase text-primary font-body font-semibold">
              {offer.tag}
            </span>
            <p className="font-display text-[14px] font-semibold text-foreground mt-2 leading-tight">
              {offer.title}
            </p>
            <p className="text-[12px] text-muted-foreground font-body mt-1.5">{offer.desc}</p>
          </motion.div>
        ))}
      </div>

      <div className="text-center mt-4 pb-2">
        <div className="divider-gold mb-3" />
        <p className="text-[11px] text-muted-foreground font-body italic tracking-wide">
          Level Up · Earn More · Sparkle Harder
        </p>
      </div>
    </div>
  );
}
