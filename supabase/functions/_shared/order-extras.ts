/**
 * order-extras — the line items, the opening note, and the discount/shipping
 * columns, written INSIDE the creating edge function's own call.
 *
 * WHY THIS EXISTS. Until now these three writes lived in the browser, after
 * create-layaway-account / create-cash-order had already returned. Each was
 * wrapped in its own try/catch that swallowed the failure into a yellow toast:
 *
 *     } catch {
 *       toast.warning('Account created, but item details could not be saved. …');
 *     }
 *
 * They ran as the CSR's own JWT through PostgREST, so an RLS rule or a column
 * mismatch silently lost every line on an order the CSR had just been told was
 * "created successfully". A human typing the lines might notice; an IMPORT
 * cannot — nobody typed them, so nobody knows what is missing. Moving the
 * writes inside the function puts them on the service-role client, in the same
 * call that created the order, where a failure is a failure.
 *
 * NOT A BEHAVIOUR CHANGE FOR EXISTING CALLERS. Every field is optional. A
 * caller that sends none of them gets exactly what it got before, byte for
 * byte. NewAccount.tsx and NewCashOrder.tsx keep their own post-RPC writes
 * until they are moved over; nothing here fires for them.
 *
 * THE LINE COLUMNS ARE YEN, DELIBERATELY. cash_order_items and
 * layaway_account_items name their money columns unit_price_jpy and
 * line_total_jpy. Page365 invoices are JPY, and the catalogue the manual pages
 * pick from is JPY, so lines stay in yen whatever currency the ACCOUNT is in.
 * Converting them would make the column names lie and would corrupt the
 * loyalty basis, which is the product amount in yen (INVARIANT 10).
 * Account-currency money — total_amount, shipping_fee, discount_amount — is the
 * caller's to convert and is written as given.
 */

export interface OrderExtraItem {
  product_id?: string | null;
  website_product_id?: string | null;
  variant_id?: string | null;
  title: string;
  sku?: string | null;
  quantity: number;
  unit_price_jpy: number;
  line_total_jpy: number;
  image_url?: string | null;
}

export interface OrderExtras {
  items?: OrderExtraItem[];
  /** Opening note for the account timeline. Layaway only — cash notes are a
   *  column on the order and are already part of the creation payload. */
  initial_note?: string | null;
  discount?: {
    amount?: number | null;
    /** 'amount' | 'percent' — stored verbatim, as the manual pages store it. */
    type?: string | null;
    value?: number | null;
  } | null;
  shipping_fee?: number | null;
  /** Page365 provenance. Stamped on the order row alongside the rest. */
  page365_no?: number | null;
  page365_slug?: string | null;
}

export interface WriteOrderExtrasResult {
  items_written: number;
  note_written: boolean;
  columns_written: string[];
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Write the optional extras for a freshly-created order.
 *
 * THROWS on failure. The caller decides what that means — for the layaway
 * function it means rolling the account back, because an account whose lines
 * did not save is exactly the half-created state this change exists to remove.
 *
 * @param kind  which table the order lives in
 * @param orderId  the row just inserted
 */
export async function writeOrderExtras(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  kind: "layaway" | "cash",
  orderId: string,
  extras: OrderExtras,
  actor: { id: string; name?: string | null },
): Promise<WriteOrderExtrasResult> {
  const isLayaway = kind === "layaway";
  const itemsTable = isLayaway ? "layaway_account_items" : "cash_order_items";
  const fkColumn = isLayaway ? "account_id" : "cash_order_id";
  const orderTable = isLayaway ? "layaway_accounts" : "cash_orders";

  const result: WriteOrderExtrasResult = { items_written: 0, note_written: false, columns_written: [] };

  // ── 1. Line items ───────────────────────────────────────────────────────
  const items = Array.isArray(extras.items) ? extras.items : [];
  if (items.length > 0) {
    const rows = items.map((li, idx) => {
      const qty = num(li.quantity);
      const unit = num(li.unit_price_jpy);
      const lineTotal = num(li.line_total_jpy);
      if (!li.title || !String(li.title).trim()) throw new Error(`items[${idx}] is missing a title`);
      if (qty === null || !Number.isInteger(qty) || qty <= 0) throw new Error(`items[${idx}] has an unusable quantity`);
      if (unit === null || unit < 0) throw new Error(`items[${idx}] has an unusable unit_price_jpy`);
      if (lineTotal === null || lineTotal < 0) throw new Error(`items[${idx}] has an unusable line_total_jpy`);
      return {
        [fkColumn]: orderId,
        product_id: li.product_id ?? null,
        website_product_id: li.website_product_id ?? null,
        variant_id: li.variant_id ?? null,
        title: String(li.title).trim(),
        sku: li.sku ?? null,
        quantity: qty,
        unit_price_jpy: unit,
        line_total_jpy: lineTotal,
        image_url: li.image_url ?? null,
      };
    });
    const { error } = await supabase.from(itemsTable).insert(rows);
    if (error) throw new Error(`Could not save item lines: ${error.message}`);
    result.items_written = rows.length;
  }

  // ── 2. Discount / shipping / provenance, one UPDATE ──────────────────────
  // These are informational columns; total_amount is already authoritative and
  // is never touched here (INVARIANT 9 — total_amount is admin-only and is set
  // by the insert above, not by this function).
  const patch: Record<string, unknown> = {};
  if (extras.discount !== undefined && extras.discount !== null) {
    patch.discount_amount = num(extras.discount.amount) ?? 0;
    patch.discount_type = extras.discount.type ?? null;
    patch.discount_value = num(extras.discount.value);
  }
  if (extras.shipping_fee !== undefined && extras.shipping_fee !== null) {
    patch.shipping_fee = num(extras.shipping_fee) ?? 0;
  }
  if (extras.page365_no !== undefined && extras.page365_no !== null) {
    patch.page365_no = extras.page365_no;
    patch.page365_slug = extras.page365_slug ?? null;
  }
  if (Object.keys(patch).length > 0) {
    const { error } = await supabase.from(orderTable).update(patch).eq("id", orderId);
    if (error) throw new Error(`Could not save discount/shipping: ${error.message}`);
    result.columns_written = Object.keys(patch);
  }

  // ── 3. Opening note (layaway only) ──────────────────────────────────────
  if (isLayaway && extras.initial_note && String(extras.initial_note).trim()) {
    const { error } = await supabase.from("account_notes").insert({
      account_id: orderId,
      note_text: String(extras.initial_note).trim(),
      created_by_user_id: actor.id,
      created_by_name: actor.name ?? "Unknown",
    });
    if (error) throw new Error(`Could not save the opening note: ${error.message}`);
    result.note_written = true;
  }

  return result;
}
