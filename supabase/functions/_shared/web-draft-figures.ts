// web-draft-figures — the money on the website-order review screen (website
// orders PR 4; docs/WEB-ORDER-DRAFTS.md). Used by confirm-web-draft for BOTH
// the preview and the confirm, so what staff see is what is written. Pure
// apart from three reads through the given client (loyalty tier, the
// customer's deadline rule, layaway_quote); tested with a fake client in
// src/test/web-draft-figures.test.ts.

type AnyRec = Record<string, unknown>;


function wholeNumber(v: unknown, field: string, errors: string[], opts: { allowNull?: boolean } = {}): number | null {
  if (v === null || v === undefined || v === "") {
    if (opts.allowNull) return null;
    return 0;
  }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    errors.push(`${field}_invalid`);
    return null;
  }
  return n;
}

export function phtToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
}

// deno-lint-ignore no-explicit-any
export async function computeWebDraftFigures(supabase: any, draft: AnyRec, body: AnyRec) {
  const errors: string[] = [];
  const currency = String(draft.settlement_currency ?? "JPY");
  const rate = draft.fx_rate == null ? null : Number(draft.fx_rate);
  const products = Number(draft.subtotal ?? 0);

  // Shipping: what the staff typed; else what checkout carried (JP rate card).
  // A draft whose shipping was left for confirmation must get a figure here.
  const typedShipping = wholeNumber(body.shipping, "shipping", errors, { allowNull: true });
  const shipping = typedShipping ?? (draft.shipping == null ? null : Number(draft.shipping));
  if (shipping === null) errors.push("shipping_required");

  const discount = wholeNumber(body.discount, "discount", errors) ?? 0;

  const rawLines = Array.isArray(body.service_lines) ? (body.service_lines as AnyRec[]) : [];
  const serviceLines: { title: string; amount: number }[] = [];
  rawLines.forEach((l, i) => {
    const title = String(l?.title ?? "").trim();
    const amount = wholeNumber(l?.amount, `service_lines[${i}].amount`, errors);
    if (!title) errors.push(`service_lines[${i}].title_required`);
    if (title && amount !== null) serviceLines.push({ title, amount });
  });
  const services = serviceLines.reduce((s, l) => s + l.amount, 0);

  if (discount > products) errors.push("discount_exceeds_products");
  const total = products + (shipping ?? 0) + services - discount;

  // Loyalty basis: PRODUCT lines − discount, in YEN (never shipping or services).
  const discountJpy = currency === "PHP" && rate ? Math.round(discount / rate) : discount;
  const defaultLoyalty = Math.max(0, Number(draft.subtotal_jpy ?? 0) - discountJpy);
  const typedLoyalty = wholeNumber(body.loyalty_jpy_amount, "loyalty_jpy_amount", errors, { allowNull: true });
  const loyaltyJpy = typedLoyalty ?? defaultLoyalty;

  const { data: member } = await supabase
    .from("loyalty_members")
    .select("current_tier_id, current_tier:current_tier_id(name)")
    .eq("customer_id", draft.customer_id)
    .maybeSingle();
  const loyaltyTier = (member as AnyRec | null)?.current_tier_id != null
    ? String(((member as AnyRec).current_tier as AnyRec | null)?.name ?? "loyalty")
    : null;
  if (loyaltyTier && loyaltyJpy <= 0) errors.push("LOYALTY_AMOUNT_REQUIRED");

  // Cash on delivery (owner plan 2026-10-10): NO payment deadline — the courier
  // collects on delivery. Deadline: typed, else the customer's rule (24h first
  // order / 72h returning).
  const isCod = String(draft.payment_method ?? "transfer") === "cod";
  let deadlineHours: number | null = null;
  let transferDueAt: string | null = null;
  if (isCod) {
    // nothing: materialize_web_draft_atomic writes no deadline for COD
  } else if (body.transfer_due_at) {
    const d = new Date(String(body.transfer_due_at));
    if (Number.isNaN(d.getTime())) errors.push("transfer_due_at_invalid");
    else transferDueAt = d.toISOString();
  } else {
    const { data: hours, error: hErr } = await supabase.rpc("web_deposit_deadline_hours", {
      p_customer_id: draft.customer_id,
      p_exclude_order: null,
    });
    if (hErr) throw hErr;
    deadlineHours = Number(hours);
    if (Number.isFinite(deadlineHours)) transferDueAt = new Date(Date.now() + deadlineHours * 3_600_000).toISOString();
  }

  const orderDate = phtToday();
  let layaway: AnyRec | null = null;
  if (draft.mode === "layaway") {
    const { data: q, error: qErr } = await supabase.rpc("layaway_quote", {
      p_price: products - discount,
      p_term_months: Number(draft.term_months),
      p_currency: currency,
      p_order_date: orderDate,
      p_shipping: shipping ?? 0,
      p_services: services,
    });
    if (qErr) throw qErr;
    const quote = (q ?? {}) as AnyRec;
    if (quote.eligible !== true || quote.term_downgraded === true) errors.push("below_plan_minimum");
    if (quote.total != null && Number(quote.total) !== total) errors.push("quote_total_mismatch");
    layaway = {
      term_months: Number(draft.term_months),
      deposit: quote.deposit ?? null,
      schedule: quote.schedule ?? [],
      max_term_months: quote.max_term_months ?? null,
      eligible: quote.eligible === true && quote.term_downgraded !== true,
    };
  }

  // CHECKOUT POINTS (2026-10-05, owner C3–C5): held by the draft, approved by
  // the Confirm in the same transaction. They are a discount in the order's
  // currency; never on shipping (full payment) and never more than the
  // deposit (layaway — the whole deposit is allowed). A Confirm that would
  // break either is refused here and again in materialize_web_draft_atomic.
  const pointsValue = Math.max(0, Number(draft.points_value ?? 0));
  const deposit = layaway ? Number(layaway.deposit ?? 0) : null;
  if (pointsValue > 0) {
    if (draft.mode === "layaway" && deposit !== null && pointsValue > deposit) errors.push("points_exceed_deposit");
    if (draft.mode !== "layaway" && pointsValue > total - (shipping ?? 0)) errors.push("points_exceed_total");
  }

  // CASH ON DELIVERY: the fee is re-bracketed on what the courier collects
  // after the staff's edits (pieces − discount + shipping + services − points),
  // by THE SQL rule (public.cod_fee_jpy), and added to the total as its own
  // line. Never in the loyalty basis, never paid by points (the points check
  // above runs on the total before the fee).
  let codFee = 0;
  if (isCod) {
    const collected = total - pointsValue;
    const { data: fee, error: feeErr } = await supabase.rpc("cod_fee_jpy", { p_collected: collected });
    if (feeErr) throw feeErr;
    if (fee === null || fee === undefined) errors.push(collected <= 0 ? "cod_nothing_to_collect" : "over_cod_limit");
    else codFee = Number(fee);
  }

  return {
    errors,
    currency,
    // C1: the method the customer chose (transfer | paidy | square | cod).
    payment_method: String(draft.payment_method ?? "transfer"),
    points: Math.max(0, Number(draft.points ?? 0)),
    points_value: pointsValue,
    // What the customer will owe after Confirm: the total (full) or the
    // deposit (layaway) less the points.
    due_now: draft.mode === "layaway" ? Math.max(0, Number(deposit ?? 0) - pointsValue) : total + codFee - pointsValue,
    // Cash on delivery fee (0 for every other method), included in `total`.
    cod_fee: codFee,
    fx_rate: rate,
    order_date: orderDate,
    products,
    shipping,
    shipping_from_checkout: typedShipping === null && draft.shipping != null,
    services,
    service_lines: serviceLines,
    discount,
    total: total + codFee,
    loyalty_jpy_amount: loyaltyJpy,
    loyalty_default_jpy: defaultLoyalty,
    loyalty_tier: loyaltyTier,
    deadline_hours: deadlineHours,
    transfer_due_at: transferDueAt,
    layaway,
  };
}
