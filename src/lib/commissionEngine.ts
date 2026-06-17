/**
 * Sales Commission engine — pure computation, no I/O.
 *
 * Replicates the Google Apps Script algorithm that previously computed
 * commissions from the sales sheet. Grouped by YYYY-MM of sale_date.
 *
 * Rules (per spec, locked):
 *   1. Resolve split: exact month match, else inherit latest split with
 *      month <= target.
 *   2. Pool = eligibleCount × pool_per_item_php.
 *   3. Role list is derived from the month's split row + its merge_groups:
 *        - Canonical role order: closer, processor, coordinator, support,
 *          verifier.
 *        - Each merge group (e.g. ["support","verifier"]) becomes ONE
 *          combined role: pct = sum of members, label = abbreviated
 *          member names joined with '+'. List position = position of
 *          the earliest member in canonical order.
 *        - Roles not in any group remain individual entries in canonical
 *          order.
 *        - After assembly, drop any entry whose pct is 0 (handles Jan/Dec
 *          "no coordinator" without special-casing).
 *   4. Role counts/amounts: for each eligible row, for each role in the
 *      role list, iterate its member columns; the named agent gets +1
 *      count and += item_amount on that role key.
 *   5. Winner-take-all in role-list order. Highest count wins; tie
 *      (count>0) breaks by higher per-role amount. Winner excluded from
 *      later roles. earn += round(pool × pct/100).
 *   6. tiedRole: any non-winning agent whose count in some role equals
 *      that role's winner's count gets a display-only tiedRole flag.
 *   7. Top Sales bonus: most CLOSER-COLUMN appearances (independent of
 *      any merging), tie on closer-column amount. bonus = round(
 *      pool × top_sales_pct/100). May overlap a role win. Skipped when
 *      top_sales_pct = 0.
 *   8. total = earn + bonus.
 *   9. Defensive: missing/null merge_groups → []; a role appears in at
 *      most one group; malformed group entries (< 2 valid members) are
 *      ignored and their members stay as standalone roles.
 */

export interface SaleRow {
  id: string;
  sale_date: string; // YYYY-MM-DD
  item_code: string | null;
  invoice_number: string | null;
  item_amount: number;
  client_name: string | null;
  closer: string | null;
  processor: string | null;
  coordinator: string | null;
  support: string | null;
  verifier: string | null;
  status: string;
  channel: string | null;
  source: string | null;
  opened_in_chat: boolean;
  closed_in_chat: boolean;
  eligible: boolean;
  notes: string | null;
}

export interface CommissionAgent {
  id: string;
  name: string;
  color: string | null;
  active: boolean;
  start_month: string | null;
  sort_order: number | null;
}

export interface CommissionSplit {
  month: string; // YYYY-MM-DD first-of-month
  closer_pct: number;
  processor_pct: number;
  coordinator_pct: number;
  support_pct: number;
  verifier_pct: number;
  top_sales_pct: number;
  merge_groups: string[][] | null; // [] or [["support","verifier"]] etc.
  pool_per_item_php: number;
}

export interface RoleDefinition {
  key: string;             // 'closer' | 'processor' | ... | 'closer+processor' | 'support+verifier' etc.
  label: string;           // display label, e.g. 'Closer', 'Sup+Ver'
  pct: number;             // sum of member pcts for groups, single pct for standalone
  members: CanonicalRole[]; // contributing canonical columns
}

export interface AgentMonthResult {
  name: string;          // display name (trimmed)
  canonicalKey: string;  // lowercased trimmed
  counts: Record<string, number>;
  amounts: Record<string, number>;
  wonRole: string | null;
  tiedRole: string | null;
  isTopSales: boolean;
  earn: number;
  bonus: number;
  total: number;
}

export interface MonthlyComputation {
  monthKey: string;   // YYYY-MM
  monthLabel: string; // e.g. "Jan 2026"
  split: CommissionSplit | null;
  rows: SaleRow[];
  eligibleRows: SaleRow[];
  pool: number;
  salesAmt: number;
  cancelledCount: number;
  pendingCount: number;
  distinctClients: number;
  distinctItems: number;
  roles: RoleDefinition[];
  agents: AgentMonthResult[];
  topSalesWinner: string | null; // canonical (display) name
  topSalesBonus: number;
}

export const CANONICAL_ROLES = ['closer', 'processor', 'coordinator', 'support', 'verifier'] as const;
export type CanonicalRole = typeof CANONICAL_ROLES[number];

export const ROLE_LABEL_FULL: Record<CanonicalRole, string> = {
  closer: 'Closer',
  processor: 'Processor',
  coordinator: 'Coord',
  support: 'Support',
  verifier: 'Verifier',
};

export const ROLE_LABEL_ABBREV: Record<CanonicalRole, string> = {
  closer: 'Cls',
  processor: 'Proc',
  coordinator: 'Coord',
  support: 'Sup',
  verifier: 'Ver',
};

function isCanonicalRole(s: unknown): s is CanonicalRole {
  return typeof s === 'string' && (CANONICAL_ROLES as readonly string[]).includes(s.toLowerCase());
}

export function monthKeyFromDate(iso: string | null | undefined): string | null {
  if (!iso || iso.length < 7) return null;
  return iso.slice(0, 7);
}

export function monthKeyToFirstOfMonth(monthKey: string): string {
  return `${monthKey}-01`;
}

export function monthLabelFromKey(monthKey: string): string {
  const [yearStr, monthStr] = monthKey.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return monthKey;
  return new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

export function resolveSplit(monthKey: string, splits: CommissionSplit[]): CommissionSplit | null {
  const target = monthKeyToFirstOfMonth(monthKey);
  const exact = splits.find(s => s.month === target);
  if (exact) return exact;
  const eligible = splits.filter(s => s.month <= target).sort((a, b) => b.month.localeCompare(a.month));
  return eligible[0] ?? null;
}

/** Normalize a raw merge_groups jsonb value into canonical-role tuples.
 *  - Filters out non-canonical role names.
 *  - Drops duplicates within a group.
 *  - Drops groups with < 2 valid members (their members stay standalone).
 *  - Ensures each canonical role appears in at most one group; later
 *    duplicates are silently dropped from subsequent groups. */
export function normalizeMergeGroups(raw: unknown): CanonicalRole[][] {
  if (!Array.isArray(raw)) return [];
  const result: CanonicalRole[][] = [];
  const used = new Set<CanonicalRole>();
  for (const g of raw) {
    if (!Array.isArray(g)) continue;
    const seenInGroup = new Set<CanonicalRole>();
    const valid: CanonicalRole[] = [];
    for (const r of g) {
      if (!isCanonicalRole(r)) continue;
      const lc = (r as string).toLowerCase() as CanonicalRole;
      if (used.has(lc) || seenInGroup.has(lc)) continue;
      seenInGroup.add(lc);
      valid.push(lc);
    }
    if (valid.length >= 2) {
      valid.sort((a, b) => CANONICAL_ROLES.indexOf(a) - CANONICAL_ROLES.indexOf(b));
      for (const r of valid) used.add(r);
      result.push(valid);
    }
    // Invalid groups (< 2 valid members) dropped without consuming role slots.
  }
  return result;
}

export function buildRoles(split: CommissionSplit): RoleDefinition[] {
  const pctMap: Record<CanonicalRole, number> = {
    closer: Number(split.closer_pct) || 0,
    processor: Number(split.processor_pct) || 0,
    coordinator: Number(split.coordinator_pct) || 0,
    support: Number(split.support_pct) || 0,
    verifier: Number(split.verifier_pct) || 0,
  };
  const groups = normalizeMergeGroups(split.merge_groups);
  const roleToGroup = new Map<CanonicalRole, CanonicalRole[]>();
  for (const g of groups) {
    for (const r of g) roleToGroup.set(r, g);
  }

  const emitted = new Set<string>();
  const out: RoleDefinition[] = [];
  for (const r of CANONICAL_ROLES) {
    const group = roleToGroup.get(r);
    if (group) {
      const key = group.join('+');
      if (emitted.has(key)) continue;
      emitted.add(key);
      const pct = group.reduce((s, m) => s + pctMap[m], 0);
      const label = group.map(m => ROLE_LABEL_ABBREV[m]).join('+');
      out.push({ key, label, pct, members: [...group] });
    } else {
      out.push({ key: r, label: ROLE_LABEL_FULL[r], pct: pctMap[r], members: [r] });
    }
  }
  return out.filter(role => role.pct > 0);
}

function bumpAgent(
  map: Map<string, AgentMonthResult>,
  name: string | null | undefined,
  roleKey: string,
  amt: number,
): void {
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const key = trimmed.toLowerCase();
  let agent = map.get(key);
  if (!agent) {
    agent = {
      name: trimmed,
      canonicalKey: key,
      counts: {},
      amounts: {},
      wonRole: null,
      tiedRole: null,
      isTopSales: false,
      earn: 0,
      bonus: 0,
      total: 0,
    };
    map.set(key, agent);
  }
  agent.counts[roleKey] = (agent.counts[roleKey] ?? 0) + 1;
  agent.amounts[roleKey] = (agent.amounts[roleKey] ?? 0) + amt;
}

export function computeMonth(
  monthKey: string,
  allRows: SaleRow[],
  splits: CommissionSplit[],
): MonthlyComputation {
  const split = resolveSplit(monthKey, splits);
  const monthRows = allRows.filter(r => monthKeyFromDate(r.sale_date) === monthKey);
  const eligibleRows = monthRows.filter(r => r.eligible === true);
  const poolPer = split ? Number(split.pool_per_item_php) || 0 : 0;
  const pool = eligibleRows.length * poolPer;
  const salesAmt = eligibleRows.reduce((s, r) => s + (Number(r.item_amount) || 0), 0);
  const cancelledCount = monthRows.filter(r => r.status === 'Cancelled').length;
  const pendingCount = monthRows.filter(r => r.status === 'Pending').length;
  const distinctClients = new Set(
    eligibleRows.map(r => (r.client_name ?? '').trim().toLowerCase()).filter(Boolean)
  ).size;
  const distinctItems = new Set(
    eligibleRows.map(r => (r.item_code ?? '').trim().toLowerCase()).filter(Boolean)
  ).size;

  const roles = split ? buildRoles(split) : [];
  const agentMap = new Map<string, AgentMonthResult>();

  // Closer-column accumulator, kept independent of role merging — Top Sales
  // is keyed on the CLOSER COLUMN, not the (possibly merged) closer role.
  const closerCol = new Map<string, { name: string; count: number; amount: number }>();

  for (const r of eligibleRows) {
    const amt = Number(r.item_amount) || 0;

    if (r.closer) {
      const trimmed = r.closer.trim();
      if (trimmed) {
        const key = trimmed.toLowerCase();
        const entry = closerCol.get(key) ?? { name: trimmed, count: 0, amount: 0 };
        entry.count += 1;
        entry.amount += amt;
        closerCol.set(key, entry);
      }
    }

    for (const role of roles) {
      for (const member of role.members) {
        const value = (r as unknown as Record<string, string | null | undefined>)[member];
        bumpAgent(agentMap, value, role.key, amt);
      }
    }
  }

  // Winner-take-all in role-list order.
  const assigned = new Set<string>();
  for (const role of roles) {
    let winner: AgentMonthResult | null = null;
    for (const agent of agentMap.values()) {
      if (assigned.has(agent.canonicalKey)) continue;
      const c = agent.counts[role.key] ?? 0;
      if (c <= 0) continue;
      if (!winner) {
        winner = agent;
        continue;
      }
      const winnerC = winner.counts[role.key] ?? 0;
      const winnerA = winner.amounts[role.key] ?? 0;
      const agentA = agent.amounts[role.key] ?? 0;
      if (c > winnerC) {
        winner = agent;
      } else if (c === winnerC && agentA > winnerA) {
        winner = agent;
      }
    }
    if (winner) {
      winner.wonRole = role.key;
      assigned.add(winner.canonicalKey);
      winner.earn += Math.round(pool * role.pct / 100);
    }
  }

  // ⚖ Tied display flag.
  for (const agent of agentMap.values()) {
    if (agent.wonRole) continue;
    for (const role of roles) {
      const c = agent.counts[role.key] ?? 0;
      if (c <= 0) continue;
      let winnerAgent: AgentMonthResult | null = null;
      for (const a of agentMap.values()) {
        if (a.wonRole === role.key) {
          winnerAgent = a;
          break;
        }
      }
      if (winnerAgent && (winnerAgent.counts[role.key] ?? 0) === c) {
        agent.tiedRole = role.key;
        break;
      }
    }
  }

  // Top Sales — pure closer-column basis.
  let topSalesWinnerName: string | null = null;
  const topPct = split ? Number(split.top_sales_pct) || 0 : 0;
  let topSalesBonus = 0;
  if (topPct > 0 && closerCol.size > 0) {
    let bestKey: string | null = null;
    let best: { name: string; count: number; amount: number } | null = null;
    for (const [key, entry] of closerCol) {
      if (entry.count <= 0) continue;
      if (!best || entry.count > best.count || (entry.count === best.count && entry.amount > best.amount)) {
        bestKey = key;
        best = entry;
      }
    }
    if (best && bestKey) {
      topSalesBonus = Math.round(pool * topPct / 100);
      topSalesWinnerName = best.name;
      let agent = agentMap.get(bestKey);
      if (!agent) {
        agent = {
          name: best.name,
          canonicalKey: bestKey,
          counts: {},
          amounts: {},
          wonRole: null,
          tiedRole: null,
          isTopSales: false,
          earn: 0,
          bonus: 0,
          total: 0,
        };
        agentMap.set(bestKey, agent);
      }
      agent.isTopSales = true;
      agent.bonus += topSalesBonus;
    }
  }

  for (const agent of agentMap.values()) {
    agent.total = agent.earn + agent.bonus;
  }

  const agents = Array.from(agentMap.values()).sort((a, b) => a.name.localeCompare(b.name));

  return {
    monthKey,
    monthLabel: monthLabelFromKey(monthKey),
    split,
    rows: monthRows,
    eligibleRows,
    pool,
    salesAmt,
    cancelledCount,
    pendingCount,
    distinctClients,
    distinctItems,
    roles,
    agents,
    topSalesWinner: topSalesWinnerName,
    topSalesBonus,
  };
}

export function listMonthKeys(rows: SaleRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const k = monthKeyFromDate(r.sale_date);
    if (k) set.add(k);
  }
  return Array.from(set).sort();
}

export function computeAllMonths(
  rows: SaleRow[],
  splits: CommissionSplit[],
): MonthlyComputation[] {
  const keys = listMonthKeys(rows);
  return keys.map(k => computeMonth(k, rows, splits));
}

/** Default the `eligible` flag on a sales-log row: true when status='Paid'
 *  AND channel ≠ 'Live'; false otherwise. The UI uses this as the
 *  auto-default, but the user can always override it. */
export function defaultEligible(status: string | null, channel: string | null): boolean {
  return status === 'Paid' && channel !== 'Live';
}

export function formatPHP(n: number): string {
  return `₱${Math.round(n).toLocaleString('en-US')}`;
}

export function formatJPY(n: number): string {
  return `¥${Math.round(n).toLocaleString('en-US')}`;
}

/** Stable color for an agent: prefer commission_agents.color, else fall
 *  back to a deterministic gold-ish gradient using a hash of the name. */
export function agentColor(
  name: string,
  agents: CommissionAgent[],
  fallback = '#1756A8',
): string {
  const trimmed = (name ?? '').trim().toLowerCase();
  const match = agents.find(a => (a.name ?? '').trim().toLowerCase() === trimmed);
  if (match?.color) return match.color;
  return fallback;
}
