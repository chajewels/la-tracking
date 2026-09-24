import { MemoryRouter, Route, Routes, UNSAFE_LocationContext, UNSAFE_RouteContext, useLocation } from 'react-router-dom';
import AppLayout from '@/components/layout/AppLayout';
import Dashboard from '@/pages/Dashboard';
import AccountList from '@/pages/AccountList';
import AccountDetail from '@/pages/AccountDetail';
import Sales from '@/pages/Sales';
import CashOrderDetail from '@/pages/CashOrderDetail';
import Customers from '@/pages/Customers';
import CustomerDetail from '@/pages/CustomerDetail';
import PageHeaderBand from '@/components/layout/PageHeaderBand';
import IllustratedState from '@/components/shared/LedgerIllustration';
import { AuthContext } from '@/contexts/AuthContext';

/** A signed-in admin identity for the harness: several pages (e.g.
 *  CashOrderDetail) redirect users without a staff role. No session exists —
 *  every data read still comes from the seeded react-query cache. */
const FIXTURE_AUTH = {
  session: null,
  user: null,
  roles: ['admin'],
  profile: { full_name: 'Fixture Admin', email: null },
  loading: false,
  signOut: async () => {},
} as unknown as React.ContextType<typeof AuthContext>;

/**
 * DEV-only: renders the REAL Hub shell and pages at their REAL paths
 * (/, /accounts, /accounts/:id, /sales, /cash-orders/:id) inside an in-memory router, so the
 * sidebar's active state and navigation can be screenshotted and recorded
 * without a signed-in session. Reached via /__fixtures?view=hub&at=/ (default).
 *
 * React Router refuses a <Router> nested in another; resetting the outer
 * LocationContext to null is what lets the MemoryRouter mount here, and the
 * empty RouteContext stops its <Routes> resolving under /__fixtures/*. The
 * react-query cache is seeded by FixturePreview before this renders.
 */
function UnseededPage() {
  const { pathname, search } = useLocation();
  return (
    <AppLayout>
      <div className="space-y-6">
        <PageHeaderBand crumbs={[{ label: 'Hub' }, { label: 'Fixture' }]} title="Not in Phase 1" />
        <IllustratedState kind="gem" text={`${pathname}${search} is outside the three Phase 1 screens and isn't seeded in the fixture harness.`} />
      </div>
    </AppLayout>
  );
}

export default function HubRouteShim({ at, roles }: { at: string; roles?: string[] }) {
  // &roles=staff (or staff,admin) signs the harness in as that role mix, and
  // names the user after it, so the header / sidebar role label can be checked.
  const auth = roles && roles.length > 0
    ? ({ ...FIXTURE_AUTH, roles, profile: { full_name: 'Fixture ' + roles.join(' + '), email: null } } as typeof FIXTURE_AUTH)
    : FIXTURE_AUTH;
  return (
    <AuthContext.Provider value={auth}>
    <UNSAFE_LocationContext.Provider value={null as never}>
      <UNSAFE_RouteContext.Provider value={{ outlet: null, matches: [], isDataRoute: false }}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/accounts" element={<AccountList />} />
          <Route path="/accounts/:id" element={<AccountDetail />} />
          <Route path="/sales" element={<Sales />} />
          <Route path="/cash-orders/:id" element={<CashOrderDetail />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/customers/:customerId" element={<CustomerDetail />} />
          <Route path="*" element={<UnseededPage />} />
        </Routes>
      </MemoryRouter>
      </UNSAFE_RouteContext.Provider>
    </UNSAFE_LocationContext.Provider>
    </AuthContext.Provider>
  );
}
