import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * useNotificationSound — staff-bell audio alerts.
 *
 * Plays a Web Audio chime (no asset files) when a NEW, UNREAD, FRESH
 * staff_notification arrives, and speaks a short label for the important
 * types. Mute + volume persist in localStorage. All playback is gated on
 * the document being visible and on a one-time AudioContext unlock from the
 * first user gesture.
 */

const LS_MUTED = 'cha_notif_sound_muted';
const LS_VOLUME = 'cha_notif_sound_volume';
const DEFAULT_VOLUME = 0.6;
const FRESH_WINDOW_MS = 3 * 60 * 1000; // 3 minutes

const IMPORTANT_SPEECH: Record<string, string> = {
  submission_confirmed: 'Payment confirmed',
  penalty_applied: 'Penalty added',
  account_forfeited: 'Account forfeited',
};

interface NotificationLike {
  id: string;
  type: string;
  created_at: string;
  metadata?: Record<string, unknown> | null;
}

interface Note {
  freq: number;
  start: number; // seconds offset from now
  dur: number; // seconds
  wave?: OscillatorType;
}

// ── Shared AudioContext (lazy singleton, unlocked on first gesture) ──────────

let sharedCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (sharedCtx) return sharedCtx;
  const Ctor =
    window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    sharedCtx = new Ctor();
  } catch {
    sharedCtx = null;
  }
  return sharedCtx;
}

// ── Chime palette (distinct per type / family) ──────────────────────────────

function chimeForType(type: string, metadata?: Record<string, unknown> | null): Note[] {
  switch (type) {
    case 'submission_confirmed':
      return [
        { freq: 660, start: 0, dur: 0.12 },
        { freq: 880, start: 0.12, dur: 0.16 },
      ];
    case 'penalty_applied':
      return [{ freq: 220, start: 0, dur: 0.38, wave: 'square' }];
    case 'account_forfeited':
      return [
        { freq: 330, start: 0, dur: 0.16 },
        { freq: 160, start: 0.16, dur: 0.3 },
      ];
    case 'loyalty_award':
      return [
        { freq: 990, start: 0, dur: 0.08 },
        { freq: 1320, start: 0.1, dur: 0.12 },
      ];
    case 'account_created': {
      const isCash = !!(metadata as { cash_order_id?: string } | null)?.cash_order_id;
      return isCash
        ? [ // bright triad
            { freq: 784, start: 0, dur: 0.1 },
            { freq: 988, start: 0.1, dur: 0.1 },
            { freq: 1319, start: 0.2, dur: 0.16 },
          ]
        : [ // two-note (layaway)
            { freq: 587, start: 0, dur: 0.12 },
            { freq: 784, start: 0.12, dur: 0.16 },
          ];
    }
    // ── Assorted distinct mid tones, grouped by family ──
    case 'submission_created':
      return [
        { freq: 520, start: 0, dur: 0.1 },
        { freq: 520, start: 0.14, dur: 0.1 },
      ];
    case 'submission_rejected':
      return [
        { freq: 520, start: 0, dur: 0.12 },
        { freq: 392, start: 0.13, dur: 0.16 },
      ];
    case 'loyalty_award_failed':
    case 'loyalty_award_missing':
      return [{ freq: 440, start: 0, dur: 0.22, wave: 'square' }];
    case 'customer_notified':
      return [{ freq: 700, start: 0, dur: 0.12 }];
    case 'extension_requested':
    case 'extension_granted':
      return [
        { freq: 600, start: 0, dur: 0.1 },
        { freq: 720, start: 0.12, dur: 0.12 },
      ];
    case 'waiver_requested':
    case 'waiver_approved':
    case 'waiver_rejected':
      return [
        { freq: 560, start: 0, dur: 0.1 },
        { freq: 672, start: 0.12, dur: 0.12 },
      ];
    case 'redemption_requested':
    case 'redemption_approved':
    case 'redemption_cancelled':
    case 'redemption_voided':
      return [
        { freq: 740, start: 0, dur: 0.08 },
        { freq: 888, start: 0.1, dur: 0.12 },
      ];
    default:
      return [{ freq: 500, start: 0, dur: 0.2 }];
  }
}

function playNotes(notes: Note[], volume: number) {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    // Best-effort resume; if the gesture unlock hasn't happened yet this is a no-op.
    void ctx.resume().catch(() => {});
  }
  const now = ctx.currentTime;
  const v = Math.max(0, Math.min(1, volume));
  for (const n of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = n.wave ?? 'sine';
    osc.frequency.value = n.freq;
    const t0 = now + n.start;
    const t1 = t0 + n.dur;
    // Short attack/decay envelope to avoid clicks; peak scaled by volume.
    const peak = 0.18 * v;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t1);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t1 + 0.02);
  }
}

function speak(text: string) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    u.volume = 1;
    window.speechSynthesis.speak(u);
  } catch {
    /* speech unavailable — silent */
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useNotificationSound(
  notifications: NotificationLike[],
  readIds: Set<string>,
) {
  const [muted, setMutedState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(LS_MUTED) === 'true';
  });
  const [volume, setVolumeState] = useState<number>(() => {
    if (typeof window === 'undefined') return DEFAULT_VOLUME;
    const raw = window.localStorage.getItem(LS_VOLUME);
    const n = raw == null ? DEFAULT_VOLUME : Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : DEFAULT_VOLUME;
  });

  const setMuted = useCallback((v: boolean) => {
    setMutedState(v);
    try { window.localStorage.setItem(LS_MUTED, String(v)); } catch { /* ignore */ }
  }, []);
  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
    try { window.localStorage.setItem(LS_VOLUME, String(clamped)); } catch { /* ignore */ }
  }, []);

  // Latest mute/volume for the playback effect without re-subscribing it.
  const mutedRef = useRef(muted);
  const volumeRef = useRef(volume);
  mutedRef.current = muted;
  volumeRef.current = volume;

  // Accumulated set of notification IDs already observed. null = first run.
  const seenRef = useRef<Set<string> | null>(null);

  // One-time AudioContext unlock on the first user gesture (covers chimes +
  // speech autoplay gating).
  useEffect(() => {
    const unlock = () => {
      const ctx = getCtx();
      if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {});
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    // First run: seed the seen set silently, play nothing.
    if (seenRef.current === null) {
      seenRef.current = new Set(notifications.map((n) => n.id));
      return;
    }

    const seen = seenRef.current;
    const nowMs = Date.now();
    const fresh: NotificationLike[] = [];
    for (const n of notifications) {
      if (seen.has(n.id)) continue;
      const isUnread = !readIds.has(n.id);
      const createdMs = new Date(n.created_at).getTime();
      const isFresh = Number.isFinite(createdMs) && nowMs - createdMs <= FRESH_WINDOW_MS;
      if (isUnread && isFresh) fresh.push(n);
    }

    // Mark every current id as seen this run (growing accumulator).
    for (const n of notifications) seen.add(n.id);

    if (fresh.length === 0) return;

    const canPlay =
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible' &&
      !mutedRef.current;
    if (!canPlay) return;

    // Chime every qualifying row; among the IMPORTANT ones, speak only the
    // single most-recent label.
    let mostRecentImportant: NotificationLike | null = null;
    for (const n of fresh) {
      playNotes(chimeForType(n.type, n.metadata), volumeRef.current);
      if (IMPORTANT_SPEECH[n.type]) {
        if (
          !mostRecentImportant ||
          new Date(n.created_at).getTime() > new Date(mostRecentImportant.created_at).getTime()
        ) {
          mostRecentImportant = n;
        }
      }
    }
    if (mostRecentImportant) {
      speak(IMPORTANT_SPEECH[mostRecentImportant.type]);
    }
  }, [notifications, readIds]);

  return { muted, setMuted, volume, setVolume };
}

export default useNotificationSound;
