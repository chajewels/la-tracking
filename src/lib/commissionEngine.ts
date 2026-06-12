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
 *   3. Role counts/amounts: per eligible row, increment the named agent
 *      in each of the 5 role columns. Case-insensitive canonical key.
 *      Includes inactive/historical agents.
 *   4. Role list:
 *        - merged_support_verifier=true → closer, processor,
 *          support+verifier (pct = support + verifier, count/amount
 *          aggregated)
 *        - else → closer, processor, coordinator (only if pct > 0),
 *          support, verifier
 *   5. Winner-take-all in role order. Highest count wins; tie (count>0)
 *      breaks by higher per-role amount. Winner excluded from later
 *      roles. earn += round(pool × pct / 100).
 *   6. tiedRole: any non-winning agent whose count in some role equals
 *      that role's winner's count gets a display-only tiedRole flag.
 *   7. Top Sales bonus: most CLOSER appearances, tie on closer amount.
 *      bonus = round(pool × top_sales_pct/100). May overlap a role win.
 *      Skipped when top_sales_pct = 0.
 *   8. total = earn + bonus.
 */

export interface SaleRow {
  id: string;
  sale_date: string; // YYYY-MM-DD
  item_code: string | null;
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
  merged_support_verifier: boolean;
  pool_per_item_php: number;
}

export interface RoleDefinition {
  key: string; // 'closer' | 'processor' | 'coordinator' | 'support' | 'verifier' | 'support+verifier'
  label: string;
  pct: number;
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

function buildRoles(split: CommissionSplit): RoleDefinition[] {
  if (split.merged_support_verifier) {
    return [
      { key: 'closer', label: 'Closer', pct: Number(split.closer_pct) || 0 },
      { key: 'processor', label: 'Processor', pct: Number(split.processor_pct) || 0 },
      { key: 'support+verifier', label: 'Sup+Ver', pct: (Number(split.support_pct) || 0) + (Number(split.verifier_pct) || 0) },
    ];
  }
  const out: RoleDefinition[] = [
    { key: 'closer', label: 'Closer', pct: Number(split.closer_pct) || 0 },
    { key: 'processor', label: 'Processor', pct: Number(split.processor_pct) || 0 },
  ];
  if ((Number(split.coordinator_pct) || 0) > 0) {
    out.push({ key: 'coordinator', label: 'Coordinator', pct: Number(split.coordinator_pct) || 0 });
  }
  out.push({ key: 'support', label: 'Support', pct: Number(split.support_pct) || 0 });
  out.push({ key: 'verifier', label: 'Verifier', pct: Number(split.verifier_pct) || 0 });
  return out;
}

function bumpAgent(
  map: Map<string, AgentMonthResult>,
  name: string | null,
  role: string,
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
  agent.counts[role] = (agent.counts[role] ?? 0) + 1;
  agent.amounts[role] = (agent.amounts[role] ?? 0) + amt;
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
    eligibleRows
      .map(r => (r.client_name ?? '').trim().toLowerCase())
      .filter(Boolean)
  ).size;
  const distinctItems = new Set(
    eligibleRows
      .map(r => (r.item_code ?? '').trim().toLowerCase())
      .filter(Boolean)
  ).size;

  const roles = split ? buildRoles(split) : [];
  const agentMap = new Map<string, AgentMonthResult>();

  for (const r of eligibleRows) {
    const amt = Number(r.item_amount) || 0;
    if (split?.merged_support_verifier) {
      bumpAgent(agentMap, r.closer, 'closer', amt);
      bumpAgent(agentMap, r.processor, 'processor', amt);
      bumpAgent(agentMap, r.support, 'support+verifier', amt);
      bumpAgent(agentMap, r.verifier, 'support+verifier', amt);
    } else {
      bumpAgent(agentMap, r.closer, 'closer', amt);
      bumpAgent(agentMap, r.processor, 'processor', amt);
      bumpAgent(agentMap, r.coordinator, 'coordinator', amt);
      bumpAgent(agentMap, r.support, 'support', amt);
      bumpAgent(agentMap, r.verifier, 'verifier', amt);
    }
  }

  // Also track closer counts/amounts for Top Sales when the role list
  // uses merged mode (still derives from the closer column).
  if (split?.merged_support_verifier) {
    // closer counts already populated above via the merged branch.
  }

  // Winner-take-all
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

  // Tied flag — display only
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

  // Top Sales — most CLOSER appearances; tie on closer amount.
  // Spec: may overlap a role win.
  let topSalesWinner: AgentMonthResult | null = null;
  const topPct = split ? Number(split.top_sales_pct) || 0 : 0;
  if (topPct > 0) {
    for (const agent of agentMap.values()) {
      const c = agent.counts['closer'] ?? 0;
      if (c <= 0) continue;
      if (!topSalesWinner) {
        topSalesWinner = agent;
        continue;
      }
      const winC = topSalesWinner.counts['closer'] ?? 0;
      const winA = topSalesWinner.amounts['closer'] ?? 0;
      const agentA = agent.amounts['closer'] ?? 0;
      if (c > winC) topSalesWinner = agent;
      else if (c === winC && agentA > winA) topSalesWinner = agent;
    }
  }
  const topSalesBonus = topSalesWinner ? Math.round(pool * topPct / 100) : 0;
  if (topSalesWinner) {
    topSalesWinner.isTopSales = true;
    topSalesWinner.bonus += topSalesBonus;
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
    topSalesWinner: topSalesWinner?.name ?? null,
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
