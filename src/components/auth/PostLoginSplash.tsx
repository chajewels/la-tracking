import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { transition } from '@/theme/motion';

/**
 * Full-screen video splash shown ONLY after a fresh, successful staff
 * sign-in (Login.tsx gates it with freshLoginRef — session restores never
 * mount this). The pre-login AdminSplashScreen is a separate, unchanged
 * component.
 *
 * Deco Ledger tokens only — no hex literals in this file.
 *
 * The video renders CONTAINED and centered (square aspect preserved,
 * max ~80vh/90vw) on the surface-0 backdrop — never cropped. There is no
 * auto-navigate timer: the splash waits for the user; onError and the 5s
 * canplay watchdog exist purely as broken-video protection.
 */

// Production asset (Supabase Storage, public). The DOUBLE SLASH before the
// filename is part of the real object path — do NOT "normalize" it; the
// single-slash URL is a different, nonexistent object.
const SPLASH_VIDEO_URL =
  'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/brand-assets//AdminSpalshScreen.mp4';

/** "Enter Dashboard" fades in at ~1.2s (durations/easing from theme/motion). */
const CTA_DELAY_MS = 1200;
/** If the video hasn't reached canplay by then, proceed immediately. */
const CANPLAY_WATCHDOG_MS = 5_000;

interface PostLoginSplashProps {
  onEnter: () => void;
  /**
   * DEV fixture-harness escape hatch (src/dev/FixturePreview only, for
   * Playwright screenshots — the sandbox cannot reach supabase.co). Plain
   * optional prop: no production code path passes it, and there is no
   * query-param/env plumbing that could swap the source in a deployed build.
   */
  srcOverride?: string;
}

export default function PostLoginSplash({ onEnter, srcOverride }: PostLoginSplashProps) {
  const prefersReducedMotion = useReducedMotion();
  const [canPlay, setCanPlay] = useState(false);
  // Reduced motion: no video playback — backdrop + button immediately.
  const [showCta, setShowCta] = useState(Boolean(prefersReducedMotion));
  const navigatedRef = useRef(false);
  const canPlayRef = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Every exit path funnels through here exactly once.
  const proceed = useCallback(() => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    onEnter();
  }, [onEnter]);

  // CTA reveal. No auto-navigate: the splash waits for the user (button /
  // Enter / ESC) — the 15s failsafe was removed by owner decision
  // (2026-07-06). Broken-video protection (onError + canplay watchdog)
  // remains below.
  useEffect(() => {
    if (prefersReducedMotion) return;
    const ctaTimer = setTimeout(() => setShowCta(true), CTA_DELAY_MS);
    return () => clearTimeout(ctaTimer);
  }, [prefersReducedMotion]);

  // canplay watchdog — video variant only.
  useEffect(() => {
    if (prefersReducedMotion) return;
    const watchdog = setTimeout(() => {
      if (!canPlayRef.current) proceed();
    }, CANPLAY_WATCHDOG_MS);
    return () => clearTimeout(watchdog);
  }, [prefersReducedMotion, proceed]);

  // Enter / Escape proceed too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        proceed();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [proceed]);

  // Focus lands on the button when it appears.
  useEffect(() => {
    if (showCta) buttonRef.current?.focus();
  }, [showCta]);

  return (
    <div
      className="fixed inset-0 z-50 bg-surface-0"
      role="dialog"
      aria-label="Welcome to Cha Jewels Hub"
    >
      {!prefersReducedMotion && (
        <>
          {/* Until the first frame is ready: surface-0 backdrop with the
              shimmer treatment — never a black flash (no poster exists). */}
          {!canPlay && <div className="absolute inset-0 skeleton-shimmer" aria-hidden="true" />}
          <motion.video
            className="absolute inset-0 m-auto max-h-[80vh] max-w-[90vw] object-contain"
            initial={{ opacity: 0 }}
            animate={{ opacity: canPlay ? 1 : 0 }}
            transition={transition.standard}
            src={srcOverride ?? SPLASH_VIDEO_URL}
            muted
            autoPlay
            loop
            playsInline
            onCanPlay={() => {
              canPlayRef.current = true;
              setCanPlay(true);
            }}
            onError={proceed}
          />
        </>
      )}

      {showCta && (
        <motion.div
          className="absolute inset-x-0 bottom-[12vh] flex justify-center px-6"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={transition.emphasis}
        >
          <button
            ref={buttonRef}
            type="button"
            onClick={proceed}
            className="gold-gradient text-primary-foreground font-semibold text-sm uppercase tracking-[0.15em] rounded-lg h-12 px-8 shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-300"
          >
            Enter Dashboard
          </button>
        </motion.div>
      )}
    </div>
  );
}
