import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import chaJewelsLogo from "@/assets/cha-jewels-logo.jpeg";

interface LoyaltySplashScreenProps {
  onComplete: () => void;
}

const LoyaltySplashScreen = ({ onComplete }: LoyaltySplashScreenProps) => {
  const [phase, setPhase] = useState<'splash' | 'onboarding'>('splash');
  const [currentSlide, setCurrentSlide] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setPhase('onboarding'), 5500);
    return () => clearTimeout(timer);
  }, []);

  const slides = [
    {
      title: "Earn With Every Purchase",
      subtitle:
        "Earn loyalty points for every ¥10,000 spent at Cha Jewels. Use them for a discount on your next purchase or save up for your dream piece.",
      icon: "✦",
    },
    {
      title: "Rise Through Exclusive Tiers",
      subtitle:
        "From Glimmer to Crown VIP — unlock double and triple points, free shipping, invoice discounts, and exclusive rewards as you level up.",
      icon: "❖",
    },
    {
      title: "Redeem Your Way",
      subtitle:
        "Use your points on regular items, layaway purchases, and discounted pieces. Your loyalty, your rewards — all in one place.",
      icon: "◆",
    },
    {
      title: "Your Golden Loyalty Journey",
      subtitle:
        "Track your points, monitor your tier progress, and celebrate every milestone — all in one beautiful place.",
      icon: "♛",
    },
  ];

  if (phase === 'splash') {
    return (
      <div className="fixed inset-0 bg-background flex flex-col items-center justify-center z-50">
        <motion.div
          initial={{ opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col items-center px-8"
        >
          <img
            src={chaJewelsLogo}
            alt="Cha Jewels Japan Gold"
            className="w-[45vw] max-w-[180px] h-auto object-contain mb-4 rounded-full mix-blend-multiply dark:mix-blend-screen"
          />
          <h1 className="font-display text-3xl font-semibold text-foreground tracking-wide">
            Cha Jewels
          </h1>
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: 80 }}
            transition={{ delay: 0.8, duration: 1, ease: "easeOut" }}
            className="h-[1px] bg-primary mt-2"
          />
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.2, duration: 0.8 }}
            className="text-primary text-[10px] mt-3 font-body tracking-[0.3em] uppercase font-semibold"
          >
            Everyday Layaway
          </motion.p>
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.8, duration: 0.8 }}
            className="text-muted-foreground text-[9px] mt-2 font-body tracking-[0.2em] uppercase"
          >
            Level Up · Earn More · Sparkle Harder
          </motion.p>
        </motion.div>
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.5 }}
          transition={{ delay: 2.4, duration: 0.8 }}
          className="absolute bottom-16 text-muted-foreground text-xs font-body italic text-center px-8"
        >
          Cha Jewels Loyalty
        </motion.p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-background flex flex-col z-50">
      <div className="flex-1 flex flex-col items-center justify-center px-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentSlide}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.5 }}
            className="flex flex-col items-center text-center"
          >
            <span className="text-6xl mb-8 animate-shimmer">
              {slides[currentSlide].icon}
            </span>
            <h2 className="font-display text-3xl font-semibold text-foreground mb-4 tracking-tight">
              {slides[currentSlide].title}
            </h2>
            <p className="text-muted-foreground font-body text-sm leading-relaxed max-w-xs">
              {slides[currentSlide].subtitle}
            </p>
          </motion.div>
        </AnimatePresence>

        <div className="flex gap-2 mt-12">
          {slides.map((_, i) => (
            <button
              key={i}
              onClick={() => setCurrentSlide(i)}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i === currentSlide ? "w-6 bg-primary" : "w-1.5 bg-accent"
              }`}
            />
          ))}
        </div>
      </div>

      <div className="px-8 pb-12 space-y-3">
        {currentSlide < slides.length - 1 ? (
          <>
            <button
              onClick={() => setCurrentSlide(currentSlide + 1)}
              className="w-full py-3.5 gradient-gold text-primary-foreground rounded-xl font-body text-sm font-semibold tracking-wide shadow-gold"
            >
              Next
            </button>
            <button
              onClick={onComplete}
              className="w-full py-3 text-muted-foreground font-body text-sm"
            >
              Skip
            </button>
          </>
        ) : (
          <button
            onClick={onComplete}
            className="w-full py-3.5 gradient-gold text-primary-foreground rounded-xl font-body text-sm font-semibold tracking-wide shadow-gold"
          >
            Get Started
          </button>
        )}
      </div>
    </div>
  );
};

export default LoyaltySplashScreen;
