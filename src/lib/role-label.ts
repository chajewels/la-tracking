/**
 * The ONE role label the Hub shows for the signed-in user — in the header and
 * in the sidebar footer alike (2026-09-24: the footer said "Admin" for every
 * user while the header said "Staff" for a staff member).
 *
 * user_roles can hold several rows for one user, and it has no ordering column,
 * so "the first row" is whatever Postgres returns. The label is therefore the
 * HIGHEST role the user holds, by this rank.
 */
const RANK = ['admin', 'finance', 'staff', 'csr', 'live_agent', 'customer'] as const;

const LABEL: Record<string, string> = {
  admin: 'Admin',
  finance: 'Finance',
  staff: 'Staff',
  csr: 'CSR',
  live_agent: 'Live Agent',
  customer: 'Customer',
};

export function highestRole(roles: readonly string[] | null | undefined): string | null {
  if (!roles || roles.length === 0) return null;
  for (const r of RANK) if (roles.includes(r)) return r;
  return [...roles].sort()[0];
}

export function roleLabel(roles: readonly string[] | null | undefined): string {
  const r = highestRole(roles);
  if (!r) return 'User';
  return LABEL[r] ?? r.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
