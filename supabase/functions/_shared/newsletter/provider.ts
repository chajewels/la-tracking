/**
 * Newsletter send provider adapter.
 *
 * Campaign mail is DELIBERATELY not sent through send-transactional-email.
 * That path is the Lovable-managed transactional sender shared by payment,
 * penalty and loyalty email; a marketing blast through it would both breach the
 * platform's bulk-sending policy and put the reputation those emails depend on
 * at the mercy of a campaign's complaint rate. Campaigns therefore go out
 * through Resend on their OWN subdomain sender (news@news.chajewelsjp.com), so
 * a bad campaign can never damage delivery of a payment confirmation.
 *
 * Sends stay DISABLED until both of these are true:
 *   1. the RESEND_API_KEY secret exists, and
 *   2. NEWSLETTER_DOMAIN_VERIFIED is set to "true" (set it once the sending
 *      subdomain shows Verified in Resend — the key alone is not proof the
 *      domain is ready, and Resend refuses every send until it is).
 * While disabled: "send to list" is refused with a clear reason and "send test"
 * returns the rendered HTML without sending.
 */

export const DEFAULT_FROM_EMAIL = "news@news.chajewelsjp.com";
export const DEFAULT_FROM_NAME = "Cha Jewels";

/** Hourly send ceiling. Config, not a constant: with a dedicated provider the
 * cap no longer shares a budget with transactional mail, so it can be raised
 * once the sending domain is warmed up. Stored in
 * system_settings.newsletter_rate_per_hour (jsonb scalar). */
export const DEFAULT_RATE_PER_HOUR = 60;

/** The worker runs every 10 minutes, so a run may send a sixth of the hourly
 * allowance. Keeps the pacing rule in one place. */
export const RUNS_PER_HOUR = 6;

export interface ProviderStatus {
  enabled: boolean;
  /** Machine-readable reason when disabled. */
  reason: "ok" | "missing_api_key" | "domain_not_verified";
  /** One sentence a staff member can act on. */
  message: string;
  fromEmail: string;
  fromName: string;
}

export function providerStatus(): ProviderStatus {
  const fromEmail = Deno.env.get("NEWSLETTER_FROM_EMAIL") ?? DEFAULT_FROM_EMAIL;
  const fromName = Deno.env.get("NEWSLETTER_FROM_NAME") ?? DEFAULT_FROM_NAME;
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) {
    return {
      enabled: false,
      reason: "missing_api_key",
      message:
        "Newsletter sending is off: the RESEND_API_KEY secret is not set yet. Add it, then verify the sending domain.",
      fromEmail,
      fromName,
    };
  }
  if ((Deno.env.get("NEWSLETTER_DOMAIN_VERIFIED") ?? "").toLowerCase() !== "true") {
    return {
      enabled: false,
      reason: "domain_not_verified",
      message:
        `Newsletter sending is off: ${fromEmail.split("@")[1]} is not confirmed as verified yet. Once it shows Verified in Resend, set NEWSLETTER_DOMAIN_VERIFIED to true.`,
      fromEmail,
      fromName,
    };
  }
  return { enabled: true, reason: "ok", message: "Newsletter sending is enabled.", fromEmail, fromName };
}

export async function getRatePerHour(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<number> {
  try {
    const { data } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", "newsletter_rate_per_hour")
      .maybeSingle();
    const raw = data?.value;
    const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch (e) {
    console.warn("[newsletter] rate lookup failed, using default:", e);
  }
  return DEFAULT_RATE_PER_HOUR;
}

export type SendOutcome =
  | { status: "sent"; providerId: string | null }
  | { status: "rate_limited"; error: string }
  | { status: "failed"; error: string };

export interface SendArgs {
  to: string;
  subject: string;
  html: string;
  /** Also rendered as a visible link in the body — the header alone is not
   * sufficient for the legal one-click-unsubscribe requirement. */
  unsubscribeUrl: string;
}

export async function sendCampaignEmail(args: SendArgs): Promise<SendOutcome> {
  const status = providerStatus();
  if (!status.enabled) return { status: "failed", error: status.message };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${status.fromName} <${status.fromEmail}>`,
      to: [args.to],
      subject: args.subject,
      html: args.html,
      reply_to: "sales@chajewelsjp.com",
      headers: {
        "List-Unsubscribe": `<${args.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });

  const text = await res.text();
  if (res.ok) {
    let providerId: string | null = null;
    try {
      providerId = (JSON.parse(text) as { id?: string }).id ?? null;
    } catch { /* body shape is not load-bearing */ }
    return { status: "sent", providerId };
  }
  // 429 is pacing, not a failure of this recipient: the caller stops the run and
  // leaves the rest pending rather than burning them as failed.
  if (res.status === 429) return { status: "rate_limited", error: `[429]: ${text.slice(0, 500)}` };
  return { status: "failed", error: `[${res.status}]: ${text.slice(0, 500)}` };
}
