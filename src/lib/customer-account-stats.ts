/**
 * How many of a customer's orders are "active" and how many are "done" — the
 * ONE definition used by the Customers directory row (table + phone card) and
 * the customer page header badge (2026-09-24: the header counted every
 * non-cancelled, non-forfeited layaway as active, so a customer with 1 open
 * plan and 7 finished ones read "8 active accounts").
 *
 * Layaway: cancelled → not counted; completed OR nothing left to pay → done;
 *          forfeited / final_forfeited → not counted; anything else → active.
 * Cash:    cancelled / expired → not counted; completed → done; else (pending) → active.
 * Cash orders are first-class accounts (CLAUDE.md ACCOUNT-SCOPE COVERAGE).
 */
export type OrderBucket = 'active' | 'completed' | null;

export interface OrderCounts { active: number; completed: number }

export function classifyLayaway(a: { status: string; remaining_balance: number | string | null }): OrderBucket {
  if (a.status === 'cancelled') return null;
  if (a.status === 'completed' || Number(a.remaining_balance) <= 0) return 'completed';
  if (a.status === 'forfeited' || a.status === 'final_forfeited') return null;
  return 'active';
}

export function classifyCashOrder(o: { status: string }): OrderBucket {
  if (o.status === 'cancelled' || o.status === 'expired') return null;
  return o.status === 'completed' ? 'completed' : 'active';
}

export function tallyCustomerOrders(
  layaways: ReadonlyArray<{ status: string; remaining_balance: number | string | null }> = [],
  cashOrders: ReadonlyArray<{ status: string }> = [],
): OrderCounts {
  const out: OrderCounts = { active: 0, completed: 0 };
  for (const a of layaways) { const b = classifyLayaway(a); if (b) out[b]++; }
  for (const o of cashOrders) { const b = classifyCashOrder(o); if (b) out[b]++; }
  return out;
}

/** Per-customer counts for the directory, from the whole account lists. */
export function buildAccountStatsMap(
  layaways: ReadonlyArray<{ customer_id: string; status: string; remaining_balance: number | string | null }> = [],
  cashOrders: ReadonlyArray<{ customer_id: string; status: string }> = [],
): Map<string, OrderCounts> {
  const map = new Map<string, OrderCounts>();
  const bump = (id: string, b: OrderBucket) => {
    if (!b) return;
    const s = map.get(id) ?? { active: 0, completed: 0 };
    s[b]++;
    map.set(id, s);
  };
  for (const a of layaways) bump(a.customer_id, classifyLayaway(a));
  for (const o of cashOrders) bump(o.customer_id, classifyCashOrder(o));
  return map;
}

/** "1 active · 7 done", "3 active", "2 done", or "No accounts". */
export function orderCountsLabel({ active, completed }: OrderCounts): string {
  const parts: string[] = [];
  if (active > 0) parts.push(`${active} active`);
  if (completed > 0) parts.push(`${completed} done`);
  return parts.length ? parts.join(' · ') : 'No accounts';
}

/**
 * "903 customers (1 test)" — the directory's count. Test customers stay in the
 * directory (findable) but the label says how many of them are tests, so the
 * figure reconciles with the Dashboard, which excludes them.
 */
export function customerCountLabel(list: ReadonlyArray<{ is_test?: boolean | null }>): string {
  const n = list.length;
  const tests = list.filter((c) => c.is_test === true).length;
  return `${n} customer${n === 1 ? '' : 's'}${tests > 0 ? ` (${tests} test)` : ''}`;
}
