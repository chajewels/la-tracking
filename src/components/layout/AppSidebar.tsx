
import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { roleLabel } from '@/lib/role-label';
import { ROUTES } from "@/constants/routes";
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  LayoutDashboard,
  Wallet,
  Users,
  Bell,
  Settings,
  LogOut,
  Megaphone,
  BarChart3,
  Sparkles,
  ScrollText,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  HelpCircle,
  Wrench,
  ShoppingBag,
  BookOpen,
  Globe,
  Hourglass,
} from 'lucide-react';

import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { useLoyaltyPendingCount } from '@/hooks/useLoyaltyPendingCount';
import { usePendingSubmissionCount } from '@/hooks/use-pending-submissions';
import { useWaiverRequestCount } from '@/hooks/useWaiverRequestCount';
import { useExtensionRequestCount } from '@/hooks/useExtensionRequestCount';
import { useNewLayawayTodayCount } from '@/hooks/useNewLayawayTodayCount';
import { useNewCashOrdersTodayCount } from '@/hooks/useNewCashOrdersTodayCount';
import { useServiceRequestCount } from '@/hooks/useServiceRequestCount';
import { animate, useReducedMotion } from 'framer-motion';
import { useWebReservations } from '@/hooks/use-supabase-data';
import { cn } from '@/lib/utils';
import { transition } from '@/theme/motion';
import { EmailHealthPill } from '@/components/system/EmailHealthIndicator';
import { PortalTokenPill } from '@/components/system/PortalTokenIndicator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '@/components/ui/sidebar';

export type SubMenuItem = {
  label: string;
  tab: string;
  // Optional override: when set, the sub-item navigates to this absolute path
  // instead of `${parentPath}?tab=${tab}`. Used for sub-items that are real
  // routes rather than tab states (e.g. Inquiries under CSR Operations).
  path?: string;
  badgeKey?: 'finance_docs' | 'monitoring_extensions' | 'loyalty_redemptions' | 'sales_payments' | 'services_requests';
  permFilter?: (can: (key: string) => boolean) => boolean;
};

export type MenuItem = {
  label: string;
  icon: any;
  path?: string;
  parentPath?: string;
  children?: SubMenuItem[];
  adminOnly?: boolean;
  permPath?: string;
};

export type CategoryHeader = {
  type: 'category';
  label: string;
};

export const sidebarItems: (CategoryHeader | MenuItem)[] = [
  { label: 'Dashboard', icon: LayoutDashboard, path: ROUTES.DASHBOARD },
  { label: 'Executive Dashboard', icon: BarChart3, path: ROUTES.EXECUTIVE_DASHBOARD, adminOnly: true },

  { type: 'category', label: 'Business' },

  {
    label: 'Sales', icon: ShoppingBag, parentPath: ROUTES.SALES,
    children: [
      { label: 'Cash', tab: 'cash' },
      { label: 'Layaway', tab: 'layaway' },
      { label: 'Payments', tab: 'payments', badgeKey: 'sales_payments' },
      { label: 'Waivers', tab: 'waivers' },
    ],
  },
  {
    label: 'Services', icon: Wrench, parentPath: ROUTES.SERVICES, permPath: ROUTES.SERVICES,
    children: [
      { label: 'Service Jobs', tab: 'service-jobs' },
      { label: 'Trade-Ins', tab: 'trade-ins' },
      { label: 'Requests', tab: 'requests', badgeKey: 'services_requests' },
    ],
  },
  {
    label: 'Customers', icon: Users, parentPath: ROUTES.CUSTOMERS,
    children: [
      { label: 'Directory', tab: 'customers' },
    ],
  },
  {
    label: 'Promotions', icon: Megaphone, parentPath: ROUTES.PROMOTIONS,
    children: [
      { label: 'Promos', tab: 'promos' },
      { label: 'Categories', tab: 'categories' },
      { label: 'Announcements', tab: 'announcements' },
    ],
  },
  {
    // No permPath: /website resolves as manage_website_catalog OR
    // manage_website_content, and a single-key permPath would hide the whole
    // parent from someone who holds only the other one. The children carry the
    // split, and the parent disappears on its own when both are filtered out
    // (the .filter below drops a parent left with no children).
    label: 'Website', icon: Globe, parentPath: ROUTES.WEBSITE,
    children: [
      { label: 'Catalog', tab: 'catalog', permFilter: (can) => can('manage_website_catalog') },
      { label: 'Content', tab: 'content', permFilter: (can) => can('manage_website_content') },
      // Audience carries cards from BOTH keys — subscribers, wholesale and
      // contact messages on catalog, campaigns on content — so either key
      // opens it and the page renders only that key's cards.
      { label: 'Audience', tab: 'audience', permFilter: (can) => can('manage_website_catalog') || can('manage_website_content') },
      { label: 'Settings', tab: 'settings', permFilter: (can) => can('manage_website_content') },
      { label: 'Page365 stock', tab: 'page365-stock', permFilter: (can) => can('manage_website_catalog') },
      { label: 'Photos', tab: 'photos', permFilter: (can) => can('manage_website_catalog') },
    ],
  },

  {
    label: 'Loyalty', icon: Sparkles, parentPath: ROUTES.LOYALTY_ADMIN, permPath: ROUTES.LOYALTY_ADMIN,
    children: [
      { label: 'Dashboard', tab: 'dashboard' },
      { label: 'Members', tab: 'members' },
      { label: 'Tiers', tab: 'tiers' },
      { label: 'Rewards', tab: 'rewards' },
      { label: 'Promotions', tab: 'promotions' },
      { label: 'Redemptions', tab: 'redemptions', badgeKey: 'loyalty_redemptions' },
      { label: 'Transactions', tab: 'transactions' },
      { label: 'Banners', tab: 'banners' },
      { label: 'Beta Whitelist', tab: 'beta' },
      { label: 'Notifications', tab: 'notifications' },
      { label: 'Settings', tab: 'settings' },
      { label: 'Audit Log', tab: 'audit' },
    ],
  },

  { type: 'category', label: 'Accounting' },

  {
    label: 'Finance', icon: Wallet, parentPath: ROUTES.FINANCE,
    children: [
      { label: 'Overview', tab: 'overview' },
      { label: 'Analytics', tab: 'analytics', permFilter: (can) => can('view_analytics') },
      { label: 'Payment Tracking', tab: 'tracking', permFilter: (can) => can('admin_settings') },
      { label: 'Collections', tab: 'collections', permFilter: (can) => can('view_collections') },
      { label: 'Vault', tab: 'vault', permFilter: (can) => can('admin_settings') },
    ],
  },

  { type: 'category', label: 'System & Admin' },

  {
    label: 'CSR Operations', icon: Bell, parentPath: ROUTES.MONITORING,
    children: [
      { label: 'CSR Alerts', tab: 'alerts' },
      { label: 'Smart Reminders', tab: 'reminders' },
      { label: 'Extensions', tab: 'extensions', badgeKey: 'monitoring_extensions' },
      { label: 'Notifications', tab: 'notifications' },
      { label: 'Portal links', tab: 'portal-links' },
      { label: 'Audit', tab: 'audit' },
      { label: 'Inquiries', tab: 'inquiries', path: ROUTES.INQUIRIES, permFilter: (can) => can('view_inquiries') },
      { label: 'Commissions', tab: 'commissions', path: ROUTES.COMMISSIONS },
      { label: 'Timesheet', tab: 'timesheet', path: ROUTES.TIMESHEET },
    ],
  },
  {
    label: 'Settings', icon: Settings, parentPath: ROUTES.SETTINGS,
    children: [
      { label: 'General', tab: 'general' },
      { label: 'Team', tab: 'team' },
      { label: 'Roles', tab: 'roles' },
      { label: 'Matrix', tab: 'matrix' },
      { label: 'Features', tab: 'features' },
      { label: 'Store Credit', tab: 'store-credit' },
      { label: 'Payment Details', tab: 'payment-details' },
    ],
  },
  { label: 'Policy Hub', icon: BookOpen, path: ROUTES.POLICY_HUB },
  { label: 'Admin Audit', icon: ScrollText, path: ROUTES.ADMIN_ACTIVITY, adminOnly: true },
  { label: 'Help', icon: HelpCircle, path: '/help' },
];

export function isCategory(item: CategoryHeader | MenuItem): item is CategoryHeader {
  return (item as CategoryHeader).type === 'category';
}

/**
 * The sliding gold "active" pill. Every page mounts its own AppLayout, so the
 * sidebar REMOUNTS on each navigation and framer-motion's layoutId has no
 * previous element to animate from. Instead each pill records where it was
 * when it unmounts, and the next one to mount within a moment glides from
 * that spot to its own (a FLIP: translate + scale back to identity). Tab
 * changes inside one page mount a new pill too, so the same path covers them.
 * Reduced motion: no animation — the pill simply appears on its row.
 */
let lastPill: { rect: DOMRect; at: number } | null = null;
const PILL_HANDOFF_MS = 1500;

function ActivePill() {
  const ref = useRef<HTMLSpanElement>(null);
  const reduceMotion = useReducedMotion();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const to = el.getBoundingClientRect();
    const from = lastPill;
    const moved = from && (Math.abs(from.rect.top - to.top) > 1 || Math.abs(from.rect.left - to.left) > 1 || Math.abs(from.rect.width - to.width) > 1);
    let controls: { stop: () => void } | undefined;
    if (from && moved && !reduceMotion && performance.now() - from.at < PILL_HANDOFF_MS && to.width > 0 && to.height > 0) {
      const dx = from.rect.left - to.left;
      const dy = from.rect.top - to.top;
      const sx = from.rect.width / to.width;
      const sy = from.rect.height / to.height;
      // Paint the first frame at the old spot synchronously — otherwise the
      // pill flashes on its new row for one frame before the glide starts.
      el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
      controls = animate(
        el,
        { x: [dx, 0], y: [dy, 0], scaleX: [sx, 1], scaleY: [sy, 1] },
        transition.spatial,
      );
    }
    return () => {
      controls?.stop();
      // Still attached here: React runs these cleanups before removing the DOM.
      lastPill = { rect: el.getBoundingClientRect(), at: performance.now() };
    };
    // Mount-only: the glide happens once, when this row becomes active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <span
      ref={ref}
      aria-hidden
      style={{ transformOrigin: '0 0' }}
      className="absolute inset-0 rounded-md bg-gold-500/[0.13] shadow-[inset_0_0_0_1px_hsl(var(--gold-500)/0.35)] before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-full before:bg-gold-500 group-data-[collapsible=icon]:before:hidden"
    />
  );
}

export default function AppSidebar({ updateAvailable = false }: { updateAvailable?: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { profile, signOut, user, roles } = useAuth();
  const isExecAllowed = user?.email === 'sales@chajewelsjp.com';
  const { canSeeNav, can } = usePermissions();
  const { count: pendingRedemptions } = useLoyaltyPendingCount();
  const { data: pendingSubmissions } = usePendingSubmissionCount();
  const { count: pendingWaivers } = useWaiverRequestCount();
  const { count: pendingExtensions } = useExtensionRequestCount();
  const { count: newLayawayToday } = useNewLayawayTodayCount();
  const { count: newCashToday } = useNewCashOrdersTodayCount();
  const { count: openServiceRequests } = useServiceRequestCount();
  // Reserve-first (A2): web reservations nobody has confirmed. Shown on every
  // page, above the menu, to whoever can act on them — the bell alone is too
  // easy to miss for a customer who has been told nothing yet.
  const canConfirmReservations = can('confirm_web_order_ready');
  const { data: reservations } = useWebReservations(canConfirmReservations);
  const reservationCount = canConfirmReservations ? (reservations?.length ?? 0) : 0;

  const badgeCountByPath: Record<string, number> = {
    [ROUTES.LOYALTY_ADMIN]: pendingRedemptions ?? 0,
    [ROUTES.SALES]: (pendingSubmissions ?? 0) + (pendingWaivers ?? 0),
    [ROUTES.MONITORING]: pendingExtensions ?? 0,
    [ROUTES.DASHBOARD]: (newLayawayToday ?? 0) + (newCashToday ?? 0),
    [ROUTES.SERVICES]: openServiceRequests ?? 0,
  };

  const badgeBySubKey: Record<string, number> = {
    sales_payments: (pendingSubmissions ?? 0) + (pendingWaivers ?? 0),
    monitoring_extensions: pendingExtensions ?? 0,
    loyalty_redemptions: pendingRedemptions ?? 0,
    services_requests: openServiceRequests ?? 0,
  };

  const { state, isMobile, setOpen, toggleSidebar } = useSidebar();
  // Seeded from the current route on the FIRST render (not only in the
  // effect below): each page mounts its own AppLayout, so the sidebar
  // remounts on every navigation, and a one-frame "all collapsed" state let
  // whichever row slid under a stationary cursor grab the hover accordion.
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const match = sidebarItems.find(
      (m): m is MenuItem => !isCategory(m) && !!m.parentPath && location.pathname === m.parentPath,
    );
    return match ? { [match.label]: true } : {};
  });

  useEffect(() => {
    const match = sidebarItems.find(
      (m): m is MenuItem => !isCategory(m) && !!m.parentPath && location.pathname === m.parentPath,
    );
    if (match) {
      setExpanded({ [match.label]: true });
    } else {
      setExpanded({});
    }
  }, [location.pathname]);

  const initials = profile?.full_name
    ? profile.full_name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : 'CJ';

  const visibleItems: (CategoryHeader | MenuItem)[] = sidebarItems
    .filter(item => {
      if (isCategory(item)) return true;
      if (item.adminOnly && !isExecAllowed) return false;
      if (item.permPath && !canSeeNav(item.permPath)) return false;
      return true;
    })
    .map(item => {
      if (isCategory(item) || !item.children) return item;
      const visibleChildren = item.children.filter(c => !c.permFilter || c.permFilter(can));
      return { ...item, children: visibleChildren };
    })
    .filter(item => isCategory(item) || !(item as MenuItem).children || ((item as MenuItem).children!.length > 0));

  const collapsed = state === 'collapsed' && !isMobile;

  // Which row carries the sliding gold pill. A parent carries it only when
  // its sub-menu is closed (or the rail is icon-only); otherwise the active
  // child does. See ActivePill for how it glides between rows.
  const isChildActiveFor = (item: MenuItem, child: SubMenuItem) =>
    child.path
      ? location.pathname === child.path
      : location.pathname === item.parentPath &&
        (searchParams.get('tab') === child.tab ||
          (!searchParams.get('tab') && child.tab === item.children![0].tab));

  const CountBadge = ({ n, small = false }: { n: number; small?: boolean }) => (
    <span
      className={cn(
        'relative z-10 ml-auto inline-flex items-center justify-center rounded-full border border-warning/35 bg-warning/15 font-semibold text-warning tabular-nums group-data-[collapsible=icon]:hidden',
        small ? 'min-w-[1.1rem] px-1.5 py-0.5 text-[9px]' : 'min-w-[1.25rem] px-1.5 py-0.5 text-[10px]',
      )}
    >
      {n}
    </span>
  );

  /** Icon-rail badge: a dot on the icon's corner instead of the count. */
  const RailDot = ({ show }: { show: boolean }) =>
    show ? (
      <span aria-hidden className="absolute right-1 top-1 z-10 hidden h-1.5 w-1.5 rounded-full bg-warning group-data-[collapsible=icon]:block" />
    ) : null;

  return (
    <Sidebar
      collapsible="icon"
      className="text-white"
      style={{
        background: 'hsl(var(--sidebar-background))',
        borderRight: '1px solid hsl(var(--gold-500) / 0.12)',
      }}
    >
      <SidebarHeader
        className="px-4 py-4 group-data-[collapsible=icon]:px-2"
        style={{
          background: 'hsl(var(--surface-0))',
          borderBottom: '1px solid hsl(var(--gold-500) / 0.1)',
        }}
      >
        <div className="flex items-center gap-3 group-data-[collapsible=icon]:justify-center">
          <img src="https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/brand-assets/cha-jewels-logo.jpeg" alt="Cha Jewels" className="h-9 w-9 rounded-full object-contain shrink-0 ring-1 ring-gold-500/40 group-data-[collapsible=icon]:h-8 group-data-[collapsible=icon]:w-8" />
          <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
            <h1 className="font-deco text-xl font-semibold leading-none tracking-wide text-gold-300">
              Cha Jewels
            </h1>
            <p className="mt-1 text-[10px] uppercase tracking-[0.22em] text-ink-muted">Hub</p>
          </div>
          {!isMobile && (
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label="Collapse sidebar"
              title="Collapse sidebar (Ctrl/⌘ B)"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-white/40 transition-colors hover:bg-gold-500/10 hover:text-gold-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:hidden"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          )}
        </div>
        {collapsed && (
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label="Expand sidebar"
            title="Expand sidebar (Ctrl/⌘ B)"
            className="mx-auto mt-2 flex h-8 w-8 items-center justify-center rounded-md text-white/40 transition-colors hover:bg-gold-500/10 hover:text-gold-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        )}
      </SidebarHeader>

      <SidebarContent className="px-3 py-3 group-data-[collapsible=icon]:px-2" style={{ background: 'hsl(var(--sidebar-background))' }}>
        {/* Reserve-first (A2): web reservations to confirm, above the menu for
            whoever can act on them. Restyled to the sidebar system (serif
            label, warning tone, gold hairline below); on the icon rail it is
            the hourglass with a count badge, a tooltip and the same label. */}
        {reservationCount > 0 && (
          <div className="mb-1">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip={`To confirm · ${reservationCount}`}
                  onClick={() => navigate(`${ROUTES.DASHBOARD}#reservations`)}
                  aria-label={`${reservationCount} web reservation${reservationCount === 1 ? '' : 's'} to confirm`}
                  className="relative h-11 cursor-pointer rounded-md border border-warning/40 bg-warning/10 pl-3 pr-2 text-warning hover:bg-warning/20 hover:text-warning group-data-[collapsible=icon]:border-warning/50"
                >
                  <Hourglass className="h-4 w-4 shrink-0" />
                  <span className="flex-1 text-left font-deco text-[15px] font-semibold tracking-wide">To confirm</span>
                  <span className="inline-flex min-w-[1.4rem] items-center justify-center rounded-full border border-warning/40 bg-warning/20 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums group-data-[collapsible=icon]:hidden">
                    {reservationCount}
                  </span>
                  <span
                    aria-hidden
                    className="absolute right-0.5 top-0.5 hidden h-3.5 min-w-[0.875rem] items-center justify-center rounded-full bg-warning px-0.5 text-[8px] font-bold leading-none text-surface-0 tabular-nums group-data-[collapsible=icon]:flex"
                  >
                    {reservationCount > 99 ? '99+' : reservationCount}
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            <div aria-hidden className="mx-1 mt-3 mb-1 h-px bg-gradient-to-r from-gold-500/40 via-gold-500/15 to-transparent group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:w-6 group-data-[collapsible=icon]:bg-gold-500/30" />
          </div>
        )}
        <SidebarMenu className="gap-0.5">
          {visibleItems.map((item) => {
            // Section header — deco small caps with a trailing gold hairline;
            // on the icon rail it collapses to a short divider.
            if (isCategory(item)) {
              return (
                <li key={`cat-${item.label}`} className="list-none select-none" role="presentation">
                  <div className="mt-4 mb-1.5 flex items-center gap-2 px-3 group-data-[collapsible=icon]:hidden">
                    <span className="font-deco text-[13px] font-semibold uppercase tracking-[0.18em] text-gold-500/80">
                      {item.label}
                    </span>
                    <span aria-hidden className="h-px flex-1 bg-gradient-to-r from-gold-500/30 to-transparent" />
                  </div>
                  <div aria-hidden className="mx-auto my-2.5 hidden h-px w-6 bg-gold-500/30 group-data-[collapsible=icon]:block" />
                </li>
              );
            }

            const Icon = item.icon;

            // Leaf item (no children)
            if (!item.children) {
              const isActive = location.pathname === item.path;
              const badge = badgeCountByPath[item.path!] ?? 0;
              return (
                <SidebarMenuItem key={item.label} onMouseEnter={() => setExpanded({})}>
                  <SidebarMenuButton
                    tooltip={item.label}
                    onClick={() => navigate(item.path!)}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'relative h-10 rounded-md pl-3 pr-3 text-sm transition-colors duration-200 ease-out cursor-pointer hover:bg-transparent',
                      isActive
                        ? 'font-medium text-gold-300 hover:text-gold-300'
                        : 'text-white/55 hover:bg-gold-500/[0.06] hover:text-white/90'
                    )}
                  >
                    {isActive && <ActivePill />}
                    <Icon className={cn('relative z-10 h-4 w-4 flex-shrink-0', isActive ? 'text-gold-300' : 'opacity-60')} />
                    <span className="relative z-10 flex-1 text-left">{item.label}</span>
                    {badge > 0 && <CountBadge n={badge} />}
                    <RailDot show={badge > 0} />
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            }

            // Parent item with children — collapsible
            const isOnParent = location.pathname === item.parentPath
              || item.children.some(c => c.path && location.pathname === c.path);
            const isExpanded = !collapsed && !!expanded[item.label];
            const parentBadge = badgeCountByPath[item.parentPath!] ?? 0;
            const parentCarriesPill = isOnParent && !isExpanded;

            return (
              <SidebarMenuItem key={item.label} onMouseEnter={() => { if (!collapsed) setExpanded({ [item.label]: true }); }}>
                <SidebarMenuButton
                  tooltip={item.label}
                  aria-expanded={isExpanded}
                  onClick={() => {
                    if (collapsed) {
                      // Icon rail: open the full sidebar with this group expanded.
                      setOpen(true);
                      setExpanded({ [item.label]: true });
                      return;
                    }
                    setExpanded(prev => prev[item.label] ? {} : { [item.label]: true });
                  }}
                  className={cn(
                    'relative h-10 rounded-md pl-3 pr-3 text-sm transition-colors duration-200 ease-out cursor-pointer hover:bg-transparent',
                    parentCarriesPill
                      ? 'font-medium text-gold-300 hover:text-gold-300'
                      : isOnParent
                        ? 'text-white/85 hover:bg-gold-500/[0.06]'
                        : 'text-white/55 hover:bg-gold-500/[0.06] hover:text-white/90'
                  )}
                >
                  {parentCarriesPill && <ActivePill />}
                  <Icon className={cn('relative z-10 h-4 w-4', isOnParent ? 'text-gold-300' : 'opacity-60')} />
                  <span className="relative z-10 flex-1 text-left">{item.label}</span>
                  {parentBadge > 0 && <CountBadge n={parentBadge} />}
                  <RailDot show={parentBadge > 0} />
                  <ChevronRight
                    className={cn(
                      'relative z-10 h-3.5 w-3.5 opacity-60 transition-transform duration-200 group-data-[collapsible=icon]:hidden',
                      isExpanded && 'rotate-90',
                    )}
                  />
                </SidebarMenuButton>

                {isExpanded && (
                  <SidebarMenuSub className="ml-[1.35rem] mt-0.5 mb-1 border-l border-l-gold-500/20 pl-2">
                    {item.children.map((child) => {
                      const isChildActive = isChildActiveFor(item, child);
                      const subBadge = child.badgeKey ? (badgeBySubKey[child.badgeKey] ?? 0) : 0;
                      const target = child.path ?? `${item.parentPath}?tab=${child.tab}`;
                      return (
                        <SidebarMenuSubItem key={child.tab}>
                          <SidebarMenuSubButton
                            asChild
                            className={cn(
                              'relative h-8 rounded-md pl-3 pr-2 text-xs transition-colors duration-200 ease-out hover:bg-transparent',
                              isChildActive
                                ? 'font-medium text-gold-300 hover:text-gold-300'
                                : 'text-white/55 hover:bg-gold-500/[0.06] hover:text-white/90'
                            )}
                          >
                            <Link to={target} aria-current={isChildActive ? 'page' : undefined} className="flex w-full items-center gap-2">
                              {isChildActive && <ActivePill />}
                              <span className="relative z-10 flex-1">{child.label}</span>
                              {subBadge > 0 && <CountBadge n={subBadge} small />}
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      );
                    })}
                  </SidebarMenuSub>
                )}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarContent>

      <SidebarFooter
        className="p-4 group-data-[collapsible=icon]:p-2"
        style={{
          background: 'hsl(var(--sidebar-background))',
          borderTop: '1px solid hsl(var(--gold-500) / 0.1)',
        }}
      >
        <div className="mb-3 flex items-center gap-3 group-data-[collapsible=icon]:mb-1 group-data-[collapsible=icon]:justify-center">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full gold-gradient font-deco text-sm font-bold text-black group-data-[collapsible=icon]:h-8 group-data-[collapsible=icon]:w-8" title={profile?.full_name || 'Cha Jewels'}>
            {initials}
          </div>

          <div className="min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
            <div className="truncate text-sm font-medium text-white/80">
              {profile?.full_name || 'Cha Jewels'}
            </div>
            <div className="text-xs text-primary">{roleLabel(roles)}</div>
          </div>
        </div>

        <button
          onClick={signOut}
          aria-label="Logout"
          title="Logout"
          className="flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-sm text-white/40 transition-colors duration-200 hover:text-white/80"
        >
          <LogOut className="h-4 w-4" />
          <span className="group-data-[collapsible=icon]:hidden">Logout</span>
        </button>

        <div className="group-data-[collapsible=icon]:hidden">
          {updateAvailable ? (
            <p className="mt-1 text-center text-[10px] text-amber-400 select-none">
              v {__APP_VERSION__} · update pending
            </p>
          ) : (
            <p className="mt-1 text-center text-[10px] text-muted-foreground select-none">
              v {__APP_VERSION__}
            </p>
          )}
          <EmailHealthPill />
          <PortalTokenPill />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
