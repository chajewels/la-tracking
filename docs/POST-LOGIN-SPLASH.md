<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

## POST-LOGIN SPLASH (added 2026-07-06)

  Full-screen video splash after a SUCCESSFUL staff sign-in on the Hub
  (src/components/auth/PostLoginSplash.tsx, wired in src/pages/Login.tsx).
  The Lovable route for this feature was CANCELLED — this on-branch
  implementation is canonical.

  Triggers ONLY on a fresh staff sign-in with NO ?next param:
    - ?next set (OAuth consent flows) → navigate(nextPath) exactly as
      before; the splash NEVER shows. The relative-only open-redirect
      validation on ?next is unchanged.
    - Session restore (visiting /login with a live session) → redirect as
      before, no splash. Enforced by freshLoginRef, set BEFORE the
      signInWithPassword await so the async SIGNED_IN event cannot race
      the gate; reset on failed sign-in.
    - The pre-login AdminSplashScreen and the type=recovery hash guard
      are independent and unchanged.

  Failsafes (all mandatory, all timers cleaned up on unmount):
    video onError → proceed immediately; 5s canplay watchdog → proceed;
    prefers-reduced-motion → no video, backdrop + "Enter Dashboard"
    button immediately. These are BROKEN-VIDEO protection only — there is
    NO auto-navigate timer: the splash waits for the user (button / Enter
    / ESC). The former 15s auto-navigate was removed by owner decision
    (2026-07-06). All exits are idempotent.

  Presentation (blur-fill, 2026-07-06): TWO layers of the SAME video
  source. Background: object-cover full viewport, blur(40px) + scale(1.1)
  to hide blur edges, under a surface-0 ~45% dark overlay — the screen is
  dressed edge to edge. Foreground: CONTAINED and centered (square aspect
  preserved, max ~92vh/94vw) — the actual content is never cropped. Both
  layers share the canplay-driven fade-in. Until canplay: surface-0
  backdrop with the shimmer treatment — never a black flash (no poster
  asset exists).

  Sound (2026-07-06): the hosted MP4 carries an AAC track. The FOREGROUND
  video attempts UNMUTED playback (valid — the splash mounts from the
  sign-in click = user activation). If the browser rejects unmuted
  autoplay (NotAllowedError), fall back: set muted, play again, and show
  an unmute toggle (gold icon button, bottom-right, aria-label
  "Unmute"/"Mute") that flips muted on tap; when playing WITH sound the
  same toggle acts as the mute control. The BACKGROUND blur layer is
  ALWAYS muted. Playback loops (audio loops with it — the toggle is the
  user's control). Reduced-motion path unchanged: no video at all.

  Video URL constant (in PostLoginSplash.tsx): the DOUBLE SLASH in
  .../brand-assets//AdminSpalshScreen.mp4 is part of the real storage
  object key — NEVER "normalize" it; the single-slash URL is a different,
  nonexistent object.

  Guard invariants locked by src/test/post-login-splash-guard.test.tsx:
  session-restore no-splash + redirect; fresh-sign-in splash survives the
  late SIGNED_IN event; failed sign-in resets the guard; ?next sign-in
  navigates to nextPath with no splash.

