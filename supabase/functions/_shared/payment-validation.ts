// supabase/functions/_shared/payment-validation.ts
//
// Shared, PURE payment-allocation validation (audit F04).
//
// Deliberately free of Deno globals, Supabase clients and network access so
// that vitest can import it directly from src/test/. Nothing here reads the
// environment or performs I/O — give it rows and it either returns or throws.
//
// WIRE FORMAT IS UNCHANGED: amounts are DECIMAL money values (12.34), not minor
// units. No caller contract moves in this step. Integer cents are used only
// INTERNALLY, for summation, exactly as src/lib/business-rules.ts does.
//
// ── Why the ±1 tolerance is gone ────────────────────────────────────────────
// record-multi-payment previously accepted a batch when
//   Math.abs(totalAllocated - total_amount_paid) > 1
// was false — a ±1.00 window, in whatever currency. That is not a rounding
// tolerance, it is a whole peso or a whole yen: a batch could be off by 99
// centavos and still be booked, silently, against the customer's ledger.
// CLAUDE.md DECIMAL RULES is explicit — "Money equality: always use
// moneyEqual() with EPSILON tolerance" — and MONEY_EPSILON is 0.01, three
// orders of magnitude tighter. The ±1 window also masked the F04 finding: a
// +100 / -50 pair sums to 50 and "matched" a 50 total, after which the
// negative leg was silently dropped downstream and 100 was actually submitted.
//
// EPSILON semantics are MIRRORED from src/lib/business-rules.ts rather than
// imported: edge functions run in Deno off supabase/functions/ and must never
// reach across into src/, which is bundled for the browser. Keep the two in
// step — MONEY_EPSILON, toInt and moneyEqual below are copies by intent.

/** Mirrors MONEY_EPSILON in src/lib/business-rules.ts. Do not diverge. */
export const MONEY_EPSILON = 0.01;

/** Money amount → integer cents. Mirrors toInt() in business-rules.ts. */
const toInt = (amount: number): number => Math.round(amount * 100);

/** Integer cents → money amount. Mirrors fromInt() in business-rules.ts. */
const fromInt = (cents: number): number => cents / 100;

/** Equal within EPSILON. Mirrors moneyEqual() — strict `<`, so a gap of
 *  exactly 0.01 is NOT equal. */
const moneyEqual = (a: number, b: number): boolean =>
  Math.abs(a - b) < MONEY_EPSILON;

export interface AllocationRow {
  account_id: string;
  amount: number;
  /** Optional per-row currency. When present on more than one distinct value,
   *  the batch is mixed-currency and is rejected. */
  currency?: string | null;
}

/**
 * Is this a real, usable money number?
 *
 * typeof is checked FIRST and Number.isFinite SECOND, and both are required.
 * A bare comparison never catches NaN — `NaN <= 0` and `NaN > 0` are both
 * false, so a NaN amount slips past every ordering test and reaches the
 * ledger as a null-ish write. Infinity passes ordering tests too. Strings are
 * rejected outright, including numerically-shaped ones like "100": the wire
 * format is JSON numbers, and silently coercing text is how a typo becomes a
 * payment.
 */
const isUsableAmount = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * Does `amount` carry more precision than the currency allows?
 *
 * CLAUDE.md DECIMAL RULES: JPY is always whole yen; PHP is at most 2 decimals.
 * The PHP test is done on cents with a float-noise guard rather than on a
 * decimal string, so 0.1 + 0.2 = 0.30000000000000004 is accepted (it is 30
 * cents) while a genuine third decimal such as 10.555 is not.
 */
const violatesPrecision = (amount: number, currency: string): boolean => {
  const code = String(currency || "").toUpperCase();
  if (code === "JPY") return !Number.isInteger(amount);
  const cents = amount * 100;
  return Math.abs(cents - Math.round(cents)) > 1e-9;
};

/**
 * Validate a payment allocation batch before ANY write.
 *
 * Throws a plain Error with a caller-safe, specific message on the first
 * failure; returns silently when the batch is sound. Every check is a hard
 * rejection — nothing is skipped, repaired or rounded away, because silently
 * dropping a leg is precisely what produced the wrong total in F04.
 *
 * @param rows            allocation legs; decimal amounts
 * @param totalAmountPaid the batch total the caller claims; REQUIRED
 * @param currency        batch currency resolved from the fetched accounts
 */
export function validateAllocations(
  rows: AllocationRow[],
  totalAmountPaid: unknown,
  currency: string,
): void {
  // ── The list itself ──
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("At least one payment allocation is required");
  }

  // ── The claimed total. REQUIRED — never optional. ──
  // Previously this was `if (total_amount_paid && ...)`, so omitting it, or
  // sending 0, skipped the cross-check entirely and let the allocations sum to
  // whatever they liked.
  if (totalAmountPaid === undefined || totalAmountPaid === null) {
    throw new Error("total_amount_paid is required");
  }
  if (!isUsableAmount(totalAmountPaid)) {
    throw new Error("total_amount_paid must be a finite number");
  }
  if (totalAmountPaid <= 0) {
    throw new Error("total_amount_paid must be greater than 0");
  }

  const seen = new Set<string>();
  const currencies = new Set<string>();
  const batchCurrency = String(currency || "").toUpperCase();
  if (batchCurrency) currencies.add(batchCurrency);

  let cents = 0;

  for (const row of rows) {
    const label = row?.account_id ? `account ${row.account_id}` : "an allocation";

    // ── Amount must be a real number ──
    if (!isUsableAmount(row?.amount)) {
      throw new Error(
        `Allocation amount for ${label} must be a finite number ` +
          `(received ${JSON.stringify(row?.amount ?? null)})`,
      );
    }

    // ── Strictly positive. No negatives, no zero. ──
    // A +500 / -400 pair is rejected outright rather than netted or skipped:
    // the batch is not what the operator thinks it is, and the only safe
    // answer is to refuse the whole thing.
    if (row.amount <= 0) {
      throw new Error(
        `Allocation amount for ${label} must be greater than 0 ` +
          `(received ${row.amount})`,
      );
    }

    // ── Currency precision ──
    if (violatesPrecision(row.amount, batchCurrency)) {
      throw new Error(
        batchCurrency === "JPY"
          ? `Allocation amount for ${label} must be a whole number of yen (received ${row.amount})`
          : `Allocation amount for ${label} must have at most 2 decimal places (received ${row.amount})`,
      );
    }

    // ── Duplicate account in one batch ──
    // Defence in depth: record-multi-payment's account fetch already rejects a
    // count mismatch, but that guard is incidental and could be refactored
    // away. Two legs against one account is never a legitimate batch.
    if (!row.account_id || typeof row.account_id !== "string") {
      throw new Error("Every allocation must carry an account_id");
    }
    if (seen.has(row.account_id)) {
      throw new Error(`Duplicate allocation for account ${row.account_id}`);
    }
    seen.add(row.account_id);

    // ── Mixed-currency batch ──
    if (row.currency) currencies.add(String(row.currency).toUpperCase());

    cents += toInt(row.amount);
  }

  if (currencies.size > 1) {
    throw new Error(
      `All allocations must share one currency (found ${[...currencies].sort().join(", ")})`,
    );
  }

  // ── Sum must equal the claimed total, within MONEY_EPSILON ──
  const allocated = fromInt(cents);
  if (!moneyEqual(allocated, totalAmountPaid)) {
    throw new Error(
      `Allocation total ${allocated} does not match total_amount_paid ${totalAmountPaid}`,
    );
  }
}

/**
 * Single-amount validation for record-payment: the subset of the rules above
 * that applies when there is one amount and no batch to cross-check.
 * Finite, strictly positive, and correct precision for the currency.
 */
export function validateSingleAmount(
  amount: unknown,
  currency: string,
  fieldName = "amount_paid",
): void {
  if (amount === undefined || amount === null) {
    throw new Error(`${fieldName} is required`);
  }
  if (!isUsableAmount(amount)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  if (amount <= 0) {
    throw new Error(`${fieldName} must be greater than 0 (received ${amount})`);
  }
  const code = String(currency || "").toUpperCase();
  if (violatesPrecision(amount, code)) {
    throw new Error(
      code === "JPY"
        ? `${fieldName} must be a whole number of yen (received ${amount})`
        : `${fieldName} must have at most 2 decimal places (received ${amount})`,
    );
  }
}
