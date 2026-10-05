/**
 * The customer's own payment-method switch on a website cash order
 * (payment lifecycle, 2026-10-05; owner rule C1).
 *
 * C1 stays: the method chosen at checkout is locked for the customer. The one
 * exception is after her latest payment was REJECTED and nothing is in
 * progress — then she may pick another way to pay. needs_clarification is not
 * a rejection.
 *
 * This is a mirror for display and early refusal only. The writer is
 * public.switch_web_payment_method_by_customer_atomic (migration
 * 20261111100000_payment_lifecycle.sql), which re-checks everything under a
 * row lock. The refusal order here MUST equal the SQL order:
 *   not_web_order, not_payable, payment_in_progress, not_rejected,
 *   already_switched, bad_method, unchanged, method_requires_yen
 * already_switched (H6 fix round 1): ONE customer switch per rejection — a
 * customer switch audited after the deciding rejection spends it.
 * (not_found — wrong order id or another customer's order — exists only in SQL.)
 * Change one, change the other.
 */

export const CUSTOMER_METHODS = ['transfer', 'paidy', 'square'] as const
export type CustomerMethod = typeof CUSTOMER_METHODS[number]

export interface SwitchInput {
  /** cash_orders.status */
  status: string
  /** cash_orders.payment_status */
  paymentStatus: string | null
  /** cash_orders.source_channel */
  sourceChannel: string | null
  /** public.cash_order_payment_lock(order) — null when nothing is in progress */
  lock: string | null
  /**
   * Latest decision = newest by updated_at (decision time) among rejected /
   * needs_clarification / confirmed submissions. Only 'rejected' allows a switch.
   */
  latestDecision: 'rejected' | 'needs_clarification' | 'confirmed' | null
  /**
   * A customer switch (audit_logs payment_method_changed, actor customer) was
   * recorded after the deciding rejection (its updated_at, else created_at).
   */
  switchedSinceDecision: boolean
  /** cash_orders.currency */
  currency: string
  /** the stored method (null on the order reads as 'transfer', as in SQL) */
  from: string | null
  /** the method she asks for */
  to: CustomerMethod
}

export type SwitchVerdict = { ok: true } | { ok: false; error: string }

export function canCustomerSwitch(input: SwitchInput): SwitchVerdict {
  if (input.sourceChannel !== 'web') return { ok: false, error: 'not_web_order' }
  if (input.status !== 'pending' || (input.paymentStatus ?? '') !== 'pending_transfer') {
    return { ok: false, error: 'not_payable' }
  }
  if (input.lock !== null && input.lock !== undefined) return { ok: false, error: 'payment_in_progress' }
  if (input.latestDecision !== 'rejected') return { ok: false, error: 'not_rejected' }
  if (input.switchedSinceDecision) return { ok: false, error: 'already_switched' }
  if (!(CUSTOMER_METHODS as readonly string[]).includes(input.to)) return { ok: false, error: 'bad_method' }
  if ((input.from ?? 'transfer') === input.to) return { ok: false, error: 'unchanged' }
  if (input.to !== 'transfer' && input.currency !== 'JPY') return { ok: false, error: 'method_requires_yen' }
  return { ok: true }
}

/**
 * The methods (stored names) she may switch to right now by the rules alone,
 * in CUSTOMER_METHODS order. Whether Paidy / card are currently OFFERED on the
 * order is a separate check (website: paidyOffer / cardOffer) — the caller
 * filters this list by it. Empty = no switch.
 */
export function switchTargets(base: Omit<SwitchInput, 'to'>): CustomerMethod[] {
  return CUSTOMER_METHODS.filter((to) => canCustomerSwitch({ ...base, to }).ok)
}

/**
 * The idempotency key of the order-method-changed email sent after the
 * CUSTOMER's own switch (H6 fix round 1): one email per (order, deciding
 * rejection, new stored method), so a repeated request never sends twice.
 * The staff path (change-payment-method) keeps its own keys.
 */
export function customerSwitchEmailKey(orderId: string, decisionId: string, method: string): string {
  return `order-method-changed-${orderId}-${decisionId}-${method}`
}
