import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Volume2, VolumeX } from 'lucide-react';
import { transition } from '@/theme/motion';

/**
 * Full-screen video splash shown ONLY after a fresh, successful staff
 * sign-in (Login.tsx gates it with freshLoginRef — session restores never
 * mount this). The pre-login AdminSplashScreen is a separate, unchanged
 * component.
 *
 * Deco Ledger tokens only — no hex literals in this file.
 *
 * Presentation: cinematic blur-fill. A background layer renders the same
 * video source object-cover across the full viewport, blurred + slightly
 * scaled with a dark overlay, so the screen is dressed edge to edge; the
 * sharp foreground renders CONTAINED and centered (max ~92vh/94vw) —
 * the actual content is never cropped. Both layers fade in on canplay.
 *
 * Sound: the foreground attempts UNMUTED playback (the splash mounts from
 * the sign-in click — user activation). If the browser rejects it, we fall
 * back to muted playback and surface an unmute toggle; with sound playing,
 * the same toggle acts as a mute control. The background layer is ALWAYS
 * muted. There is no auto-navigate timer: the splash waits for the user;
 * onError and the 5s canplay watchdog exist purely as broken-video
 * protection.
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
  const [isMuted, setIsMuted] = useState(false);
  const navigatedRef = useRef(false);
  const canPlayRef = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const src = srcOverride ?? SPLASH_VIDEO_URL;

  // Every exit path funnels through here exactly once.
  const proceed = useCallback(() => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    onEnter();
  }, [onEnter]);

  // Foreground playback: try WITH sound first (the splash mounts from the
  // sign-in click, so user activation is normally live). If the browser
  // still rejects unmuted autoplay, fall back to muted and let the toggle
  // restore sound on tap.
  useEffect(() => {
    if (prefersReducedMotion) return;
    const video = videoRef.current;
    if (!video) return;
    const attempt = video.play();
    // jsdom's play() returns undefined — guard before chaining.
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch(() => {
        video.muted = true;
        setIsMuted(true);
        const retry = video.play();
        if (retry && typeof retry.catch === 'function') retry.catch(() => {});
      });
    }
  }, [prefersReducedMotion]);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  }, []);

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
      className="fixed inset-0 z-50 bg-surface-0 overflow-hidden"
      role="dialog"
      aria-label="Welcome to Cha Jewels Hub"
    >
      {!prefersReducedMotion && (
        <>
          {/* Blur-fill background: same source, cover + blur + slight scale
              (the scale hides the blur's soft edges), under a dark overlay
              so the sharp layer reads clearly. Decorative — ALWAYS muted. */}
          <motion.video
            data-testid="splash-bg-video"
            aria-hidden="true"
            className="absolute inset-0 h-full w-full scale-110 object-cover blur-[40px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: canPlay ? 1 : 0 }}
            transition={transition.standard}
            src={src}
            muted
            autoPlay
            loop
            playsInline
            tabIndex={-1}
          />
          <div className="absolute inset-0 bg-[hsl(var(--surface-0)/0.45)]" aria-hidden="true" />
          {/* Until the first frame is ready: surface-0 backdrop with the
              shimmer treatment — never a black flash (no poster exists). */}
          {!canPlay && <div className="absolute inset-0 skeleton-shimmer" aria-hidden="true" />}
          <motion.video
            ref={videoRef}
            data-testid="splash-fg-video"
            className="absolute inset-0 m-auto max-h-[92vh] max-w-[94vw] object-contain"
            initial={{ opacity: 0 }}
            animate={{ opacity: canPlay ? 1 : 0 }}
            transition={transition.standard}
            src={src}
            loop
            playsInline
            onCanPlay={() => {
              canPlayRef.current = true;
              setCanPlay(true);
            }}
            onError={proceed}
          />
          {canPlay && (
            <motion.button
              type="button"
              onClick={toggleMute}
              aria-label={isMuted ? 'Unmute' : 'Mute'}
              className="absolute bottom-6 right-6 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-[hsl(var(--gold-500)/0.4)] bg-[hsl(var(--surface-0)/0.6)] text-gold-300 backdrop-blur-sm transition-colors hover:text-gold-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-300"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={transition.standard}
            >
              {isMuted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
            </motion.button>
          )}
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
