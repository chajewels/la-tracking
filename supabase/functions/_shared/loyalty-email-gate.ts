/**
 * Loyalty email gate — Phase 2.5
 *
 * Each loyalty email send-site reads a system_settings boolean to
 * decide whether the send fires. The 8 keys were seeded in Phase 2;
 * Phase 2.5 wires the gates at every call site.
 *
 * Usage from an edge function handler:
 *
 *   import { createLoyaltyEmailGate } from "../_shared/loyalty-email-gate.ts";
 *
 *   Deno.serve(async (req) => {
 *     const supabase = createClient(...);
 *     const gate = createLoyaltyEmailGate(supabase);
 *     // ... later:
 *     if (await gate("loyalty_email_earned")) {
 *       await fetch(emailUrl, { ... });
 *     } else {
 *       console.log("[email-gate] loyalty-earned skipped — toggle off");
 *     }
 *   });
 *
 * Design notes:
 * - Per-invocation cache (closure-scoped Map). Avoids repeating the
 *   system_settings query when the same key is checked multiple times
 *   in one invocation (e.g. award-loyalty-points fires up to 3 emails
 *   under different keys; loyalty-inactivity-check loops members and
 *   may check the same key hundreds of times).
 * - Fail-safe to true. Missing key, RLS denial, network error, JSON
 *   parse failure — all default to true so the gate never silently
 *   suppresses a send because of an infrastructure problem. The only
 *   way a send is suppressed is an explicit `false` value in
 *   system_settings.
 * - All errors logged via console.warn so the cause is visible in
 *   Supabase function logs without surfacing to the client.
 */

export const LOYALTY_EMAIL_KEYS = [
  "loyalty_email_welcome",
  "loyalty_email_earned",
  "loyalty_email_bonus",
  "loyalty_email_tier_upgrade",
  "loyalty_email_tier_downgrade",
  "loyalty_email_pre_expire",
  "loyalty_email_expire_deduct",
  "loyalty_email_redeem",
] as const;

export type LoyaltyEmailKey = typeof LOYALTY_EMAIL_KEYS[number];

export function createLoyaltyEmailGate(
  supabase: any,
): (key: LoyaltyEmailKey) => Promise<boolean> {
  const cache = new Map<LoyaltyEmailKey, boolean>();

  return async function shouldSend(key: LoyaltyEmailKey): Promise<boolean> {
    if (cache.has(key)) return cache.get(key)!;

    try {
      const { data, error } = await supabase
        .from("system_settings")
        .select("value")
        .eq("key", key)
        .maybeSingle();

      if (error) {
        console.warn(
          `[email-gate] failed to read '${key}', defaulting to true:`,
          error.message ?? error,
        );
        cache.set(key, true);
        return true;
      }

      if (!data) {
        console.warn(
          `[email-gate] system_settings key '${key}' missing, defaulting to true`,
        );
        cache.set(key, true);
        return true;
      }

      let parsed: unknown = data.value;
      if (typeof parsed === "string") {
        try {
          parsed = JSON.parse(parsed);
        } catch {
          // Leave as the original string; coercion below handles it
        }
      }

      const enabled = parsed === true || parsed === "true";
      cache.set(key, enabled);
      return enabled;
    } catch (err) {
      console.warn(
        `[email-gate] unexpected error for '${key}', defaulting to true:`,
        err,
      );
      cache.set(key, true);
      return true;
    }
  };
}
