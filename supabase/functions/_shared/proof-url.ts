// Edge wrapper for proof-url-rules.ts (pure, shared with the Hub frontend).
// The host is read from SUPABASE_URL at call time and never logged.
import { isAllowedProofUrl } from "./proof-url-rules.ts";

export * from "./proof-url-rules.ts";

/** The project's Supabase host from SUPABASE_URL, or null. Never logged. */
export function proofUrlHostFromEnv(): string | null {
  const base = Deno.env.get("SUPABASE_URL");
  if (!base) return null;
  try {
    return new URL(base).host.toLowerCase();
  } catch {
    return null;
  }
}

/** isAllowedProofUrl against this deployment's own host (fails closed). */
export function isOwnProofUrl(url: unknown): boolean {
  const host = proofUrlHostFromEnv();
  if (!host) return false;
  return isAllowedProofUrl(url, { host });
}

