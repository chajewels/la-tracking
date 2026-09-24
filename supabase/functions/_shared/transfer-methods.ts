/**
 * Transfer payment methods as the customer sees them — the storefront checkout,
 * the order and plan pages, and every email that prints where to send money.
 *
 * Moved verbatim out of website/index.ts on 2026-09-24 (reserve-first A2) so
 * confirm-web-order-ready can print exactly the accounts the website would
 * have shown. One definition: a method the checkout would hide can never
 * appear in an email, and the other way round.
 */

type AnyRec = Record<string, unknown>;

export const METHOD_FIELDS =
  "id, region, method_type, label_ja, label_en, bank_name, bank_branch, account_type, " +
  "account_number, account_holder, wallet_number, wallet_name, note_ja, note_en, sort_order";

export const txt = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};

/**
 * Which set of accounts a currency is paid into. This is what `transfer_region`
 * on the wire has always meant — "which accounts is this paid into" — so it is
 * derived from the currency, exactly like the methods sent beside it. Deriving
 * it from the shipping address instead is what let a response carry a yen-only
 * Rakuten account under a peso plan (fixed 2026-09-15).
 *
 * There is deliberately no regionForCountry() companion any more. Every call
 * site the old one had was either the bank lookup or this label that describes
 * it; shipping goes through shippingFor(), which reads shipping_rates by
 * country directly and never consulted a region. Keeping a country->region
 * helper alive would only invite the two questions to be confused again.
 */
export function regionForCurrency(currency: string): "JP" | "OVERSEAS" {
  return String(currency ?? "").trim().toUpperCase() === "PHP" ? "OVERSEAS" : "JP";
}

/**
 * Is this row actually usable by a customer? Completeness is per method type,
 * because a half-filled method is worse than none — it looks like an account
 * and the money goes nowhere:
 *   bank         — bank name + account number + holder (branch/type are extra)
 *   gcash, maya  — wallet number + wallet name
 *   other        — a label, plus at least one detail to act on
 * This rule is mirrored in the Hub editor's status badge. If the two ever
 * disagree, an admin sees "live" while checkout hides the method, so they must
 * be changed together.
 */
export function methodIsComplete(row: AnyRec): boolean {
  switch (String(row.method_type)) {
    case "bank":
      return !!(txt(row.bank_name) && txt(row.account_number) && txt(row.account_holder));
    case "gcash":
    case "maya":
      return !!(txt(row.wallet_number) && txt(row.wallet_name));
    case "other":
      return !!(
        (txt(row.label_ja) || txt(row.label_en)) &&
        (txt(row.note_ja) || txt(row.note_en) || txt(row.account_number) || txt(row.wallet_number))
      );
    default:
      return false;
  }
}

export const DEFAULT_LABELS: Record<string, { ja: string; en: string }> = {
  bank: { ja: "銀行振込", en: "Bank transfer" },
  gcash: { ja: "GCash", en: "GCash" },
  maya: { ja: "Maya", en: "Maya" },
  other: { ja: "お支払い方法", en: "Payment method" },
};

/**
 * Active, complete transfer methods for a SETTLEMENT CURRENCY, in the admin's
 * order, read at request time — a correction made in the Hub is live on the
 * next page load with no deploy.
 *
 * Keyed on currency, not on the shipping country (changed 2026-09-15). The
 * account a customer pays into has to be able to RECEIVE what they chose to pay
 * in: Rakuten takes yen, Metrobank takes pesos, and a Japan-resident customer
 * settling a plan in pesos must be shown the peso account. Selecting by
 * destination showed them Rakuten and left the plan unpayable.
 *
 * Returns [] when no active, complete method accepts that currency. That empty
 * array is what makes checkout refuse the currency rather than print an account
 * the money cannot reach: the old free-text design could not tell a real
 * account from a placeholder paragraph, so it had no way to know.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function transferMethods(supabase: any, currency: string): Promise<AnyRec[]> {
  const cur = String(currency ?? "").trim().toUpperCase() === "PHP" ? "PHP" : "JPY";
  const { data, error } = await supabase
    .from("transfer_payment_methods")
    .select(METHOD_FIELDS)
    .eq("currency", cur)
    .eq("is_active", true)
    // created_at breaks sort_order ties so the order never shuffles between reads.
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;

  return ((data ?? []) as AnyRec[]).filter(methodIsComplete).map((row) => {
    const type = String(row.method_type);
    const fallback = DEFAULT_LABELS[type] ?? DEFAULT_LABELS.other;
    const bankName = txt(row.bank_name);
    const wallet = txt(row.wallet_number);
    return {
      id: row.id,
      method_type: type,
      label_ja: txt(row.label_ja) ?? fallback.ja,
      label_en: txt(row.label_en) ?? fallback.en,
      // Only the block this method actually uses is sent; the storefront renders
      // whichever is present rather than guessing from the type.
      bank: bankName
        ? {
          name: bankName,
          branch: txt(row.bank_branch),
          account_type: txt(row.account_type),
          account_number: txt(row.account_number),
          account_holder: txt(row.account_holder),
        }
        : null,
      wallet: wallet ? { number: wallet, name: txt(row.wallet_name) } : null,
      note_ja: txt(row.note_ja),
      note_en: txt(row.note_en),
    };
  });
}
