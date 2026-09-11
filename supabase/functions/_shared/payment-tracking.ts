/**
 * refreshPaymentTracking — awaited, never throws.
 * Asks append-payment-tracking to rewrite the given invoice's row on its
 * cohort tracking sheet from DB truth (Bug #263). Safe after any payment
 * mutation: confirm, void, edit, restore. Logs and returns on failure so
 * the calling function's own response is never affected.
 */
export async function refreshPaymentTracking(invoiceNumber: string | null | undefined, caller: string): Promise<void> {
  const inv = String(invoiceNumber ?? "").trim();
  if (!inv) { console.warn(`[${caller}] refreshPaymentTracking: no invoice_number`); return; }
  try {
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/append-payment-tracking`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      },
      body: JSON.stringify({ invoice_number: inv }),
    });
    const json = await res.json().catch(() => null);
    if (!json?.ok) console.warn(`[${caller}] append-payment-tracking not ok:`, inv, json);
  } catch (e) {
    console.warn(`[${caller}] append-payment-tracking failed (non-blocking):`, inv, e);
  }
}
