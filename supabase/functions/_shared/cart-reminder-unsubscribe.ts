/**
 * Cart reminders: react to Lovable's OWN unsubscribe (docs/CART-REMINDERS.md,
 * decision D1 mitigation).
 *
 * When a recipient uses the provider's unsubscribe on a cart reminder, Lovable
 * suppresses the ADDRESS on notify.chajewelsjp.com — which may silently stop
 * that customer's order emails too. Two things happen here, both non-fatal to
 * the webhook that calls this:
 *   1. withdraw_cart_reminder_by_email — our consent is withdrawn for every
 *      customer on that address (source 'lovable_unsubscribe'), so we stop as
 *      well and the legal record shows why.
 *   2. a staff bell 'cart_reminder_unsubscribed' naming the address, so staff
 *      know her ORDER emails may now be suppressed and can reach her another
 *      way.
 * Idempotent: a second delivery of the same event withdraws nothing and rings
 * no bell.
 */

// deno-lint-ignore no-explicit-any
type Db = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function withdrawCartRemindersForAddress(supabase: Db, email: string, via: string): Promise<number> {
  const addr = String(email ?? "").trim().toLowerCase();
  if (!addr) return 0;
  try {
    const { data, error } = await supabase.rpc("withdraw_cart_reminder_by_email", { p_email: addr });
    if (error) throw error;
    const n = Number(data ?? 0);
    if (n > 0) {
      await supabase.rpc("staff_notify", {
        p_type: "cart_reminder_unsubscribed",
        p_title: "A customer unsubscribed through the email provider",
        p_body: `${addr} used the provider's unsubscribe (${via}). Cart reminders are withdrawn for ${n} customer record(s); `
          + "the address may now be suppressed for ORDER emails too — reach the customer another way for anything about an order.",
        p_account_id: null,
        p_customer_id: null,
        p_invoice: null,
        p_meta: { source: "cart_reminder_unsubscribe", via, email: addr, withdrawn: n },
      });
    }
    return n;
  } catch (err) {
    console.error("[cart-reminder-unsubscribe] withdraw failed (non-blocking):", (err as Error)?.message ?? err);
    return 0;
  }
}
