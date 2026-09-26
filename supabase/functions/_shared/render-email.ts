import type * as React from 'npm:react@18.3.1'
import { render } from 'npm:@react-email/components@0.0.22'

/**
 * THE ONLY WAY AN EMAIL IS RENDERED TO HTML OR PLAIN TEXT (2026-09-26).
 *
 * Never import `renderAsync` from @react-email: its stream reader
 * (@react-email/render 0.0.17, readStream) calls `decoder.decode(chunk)` on
 * every 512-byte chunk React emits WITHOUT `{ stream: true }`, so any
 * multi-byte character that straddles a chunk boundary — Japanese text, ₱, ¥,
 * an emoji — comes out as U+FFFD (「場合」→「場��」). The synchronous
 * `render()` from the same package uses renderToStaticMarkup, which returns
 * one string and never splits a character. No template uses Suspense, so
 * nothing needs the streaming renderer.
 *
 * Async signature kept so a call site reads exactly as it did with renderAsync.
 * Guarded by development/email-encoding.test.ts (fails on any U+FFFD, and on
 * any renderAsync import under supabase/functions).
 */
export function renderEmail(
  element: React.ReactElement,
  options?: { plainText?: boolean },
): Promise<string> {
  return Promise.resolve(render(element, options))
}
