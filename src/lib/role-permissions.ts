import { type ReactNode } from 'react';

export type AppRole = 'admin' | 'staff' | 'finance' | 'csr';

// ── Page-level access ──
const PAGE_ACCESS: Record<string, AppRole[]> = {
  '/':                    ['admin', 'staff', 'finance', 'csr'],
  '/accounts':            ['admin', 'staff', 'finance'],
  '/accounts/new':        ['admin', 'staff'],
  '/accounts/:id':        ['admin', 'staff', 'finance'],
  '/customers':           ['admin', 'staff', 'csr'],
  '/customers/:customerId': ['admin', 'staff', 'csr'],
  '/monitoring':          ['admin', 'staff', 'csr'],
  '/reminders':           ['admin', 'staff', 'csr'],
  '/collections':         ['admin', 'finance'],
  '/finance':             ['admin', 'finance'],
  '/payment-submissions': ['admin', 'finance'],
  '/waivers':             ['admin', 'finance'],
  '/analytics':           ['admin', 'finance'],
  '/admin-audit':         ['admin'],
  '/settings':            ['admin'],
};

// ── Sidebar items that each role can see ──
export const SIDEBAR_ACCESS: Record<string, AppRole[]> = {
  '/':                    ['admin', 'staff', 'finance', 'csr'],
  '/accounts':            ['admin', 'staff', 'finance'],
  '/customers':           ['admin', 'staff', 'csr'],
  '/monitoring':          ['admin', 'staff', 'csr'],
  '/reminders':           ['admin', 'staff', 'csr'],
  '/collections':         ['admin', 'finance'],
  '/finance':             ['admin', 'finance'],
  '/payment-submissions': ['admin', 'finance'],
  '/waivers':             ['admin', 'finance'],
  '/analytics':           ['admin', 'finance'],
  '/admin-audit':         ['admin'],
  '/settings':            ['admin'],
};

// ── Action-level permissions ──
export type ActionKey =
  | 'run_reconciliation'
  | 'recalculate_balance'
  | 'apply_cap_fix'
  | 'waive_penalty'
  | 'confirm_payment'
  | 'reject_submission'
  | 'revoke_token'
  | 'regenerate_token'
  | 'admin_settings'
  | 'void_payment'
  | 'restore_payment'
  | 'delete_account'
  | 'forfeit_account'
  | 'reactivate_account'
  | 'add_penalty'
  | 'add_service'
  | 'edit_schedule'
  | 'edit_invoice'
  | 'record_payment'
  | 'create_account'
  | 'edit_customer'
  | 'delete_customer'
  | 'manage_team'
  | 'reassign_owner'
  | 'send_reminder'
  | 'review_submission'
  | 'view_audit_logs'
  | 'system_health';

const ACTION_ROLES: Record<ActionKey, AppRole[]> = {
  run_reconciliation:    ['admin'],
  recalculate_balance:   ['admin'],
  apply_cap_fix:         ['admin'],
  waive_penalty:         ['admin', 'finance'],
  confirm_payment:       ['admin', 'finance', 'staff'],
  reject_submission:     ['admin', 'finance'],
  revoke_token:          ['admin'],
  regenerate_token:      ['admin', 'staff'],
  admin_settings:        ['admin'],
  void_payment:          ['admin'],
  restore_payment:       ['admin'],
  delete_account:        ['admin'],
  forfeit_account:       ['admin'],
  reactivate_account:    ['admin'],
  add_penalty:           ['admin', 'staff'],
  add_service:           ['admin', 'staff'],
  edit_schedule:         ['admin'],
  edit_invoice:          ['admin'],
  record_payment:        ['admin', 'staff', 'finance'],
  create_account:        ['admin', 'staff'],
  edit_customer:         ['admin', 'staff', 'csr'],
  delete_customer:       ['admin'],
  manage_team:           ['admin'],
  reassign_owner:        ['admin'],
  send_reminder:         ['admin', 'staff', 'csr'],
  review_submission:     ['admin', 'finance'],
  view_audit_logs:       ['admin'],
  system_health:         ['admin'],
};

// ── Dashboard section visibility ──
export type DashboardSection =
  | 'system_health'
  | 'operations_panel'
  | 'ai_risk'
  | 'live_collection'
  | 'overdue_alerts'
  | 'geo_breakdown'
  | 'aging_buckets';

const DASHBOARD_SECTION_ROLES: Record<DashboardSection, AppRole[]> = {
  system_health:      ['admin'],
  operations_panel:   ['admin', 'staff'],
  ai_risk:            ['admin', 'finance'],
  live_collection:    ['admin', 'finance', 'staff'],
  overdue_alerts:     ['admin', 'staff', 'csr'],
  geo_breakdown:      ['admin', 'finance'],
  aging_buckets:      ['admin', 'finance'],
};

// ── Helper functions ──

export function hasPageAccess(roles: AppRole[], path: string): boolean {
  // Match dynamic routes
  let matched = PAGE_ACCESS[path];
  if (!matched) {
    // Try pattern matching for dynamic segments
    for (const [pattern, allowedRoles] of Object.entries(PAGE_ACCESS)) {
      if (pattern.includes(':')) {
        const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, '[^/]+') + '$');
        if (regex.test(path)) {
          matched = allowedRoles;
          break;
        }
      }
    }
  }
  if (!matched) return false;
  return roles.some(r => matched!.includes(r));
}

export function canSeeNavItem(roles: AppRole[], path: string): boolean {
  const allowed = SIDEBAR_ACCESS[path];
  if (!allowed) return false;
  return roles.some(r => allowed.includes(r));
}

export function canPerformAction(roles: AppRole[], action: ActionKey): boolean {
  const allowed = ACTION_ROLES[action];
  if (!allowed) return false;
  return roles.some(r => allowed.includes(r));
}

export function canSeeDashboardSection(roles: AppRole[], section: DashboardSection): boolean {
  const allowed = DASHBOARD_SECTION_ROLES[section];
  if (!allowed) return false;
  return roles.some(r => allowed.includes(r));
}

export function isAdmin(roles: AppRole[]): boolean {
  return roles.includes('admin');
}
