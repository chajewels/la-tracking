import { useCallback, useEffect, useRef, useState, memo, type FC, type MutableRefObject } from 'react';
import { useSearchParams } from 'react-router-dom';
import AppLayout from '@/components/layout/AppLayout';
import PageHeaderBand from '@/components/layout/PageHeaderBand';
import { ROUTES } from '@/constants/routes';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import WorkspaceToolbar from '@/components/layout/WorkspaceToolbar';
import WorkspaceSplitButton from '@/components/layout/WorkspaceSplitButton';
import CashOrdersList from '@/components/customers/CashOrdersList';
import AccountList from './AccountList';
import PaymentsHub from './PaymentsHub';
import Waivers from './Waivers';
import Page365ImportDialog from '@/components/page365/Page365ImportDialog';

const MemoCashOrdersList = memo(CashOrdersList) as FC<{ embedded?: boolean; searchValue?: string; exportRef?: MutableRefObject<(() => void) | null> }>;
const MemoAccountList = memo(AccountList) as FC<{ embedded?: boolean; searchValue?: string; exportRef?: MutableRefObject<(() => void) | null> }>;
const MemoPaymentsHub = memo(PaymentsHub) as FC<{ embedded?: boolean; searchValue?: string }>;
const MemoWaivers = memo(Waivers);

type SalesTabKey = 'cash' | 'layaway' | 'payments' | 'waivers';
const VALID_TABS: SalesTabKey[] = ['cash', 'layaway', 'payments', 'waivers'];
const DEFAULT_TAB: SalesTabKey = 'cash';
const TAB_LABEL: Record<SalesTabKey, string> = { cash: 'Cash', layaway: 'Layaway', payments: 'Payments', waivers: 'Waivers' };

interface SalesProps {
  embedded?: boolean;
}

export default function Sales({ embedded = false }: SalesProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTabState] = useState<SalesTabKey>(() => {
    const urlTab = searchParams.get('tab') as SalesTabKey | null;
    return urlTab && VALID_TABS.includes(urlTab) ? urlTab : DEFAULT_TAB;
  });
  // One search state per tab so a query typed on Cash doesn't bleed
  // into Layaway / Payments / Waivers when the user switches tabs.
  const [cashSearch, setCashSearch] = useState('');
  const [layawaySearch, setLayawaySearch] = useState('');
  const [paymentsSearch, setPaymentsSearch] = useState('');
  const [waiversSearch, setWaiversSearch] = useState('');
  // The "From Page365" split-button item lives in WorkspaceSplitButton, which is
  // rendered inside the toolbar and has no path back here. The repo's existing
  // convention for that (open-new-customer-dialog, open-trade-in-dialog) is a
  // window CustomEvent, so this follows it rather than inventing a second way.
  const [page365Open, setPage365Open] = useState(false);

  // Refs hold each child's exported CSV download handler. The active tab's
  // ref is invoked when the workspace toolbar export button is clicked.
  const cashExportRef = useRef<(() => void) | null>(null);
  const layawayExportRef = useRef<(() => void) | null>(null);

  const handleExport = useCallback(() => {
    if (tab === 'cash') cashExportRef.current?.();
    else if (tab === 'layaway') layawayExportRef.current?.();
  }, [tab]);

  useEffect(() => {
    const urlTab = searchParams.get('tab') as SalesTabKey | null;
    if (urlTab && VALID_TABS.includes(urlTab) && urlTab !== tab) {
      setTabState(urlTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    const open = () => setPage365Open(true);
    window.addEventListener('open-page365-import', open);
    return () => window.removeEventListener('open-page365-import', open);
  }, []);

  const setTab = (next: SalesTabKey) => {
    setTabState(next);
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  const Wrapper = embedded
    ? ({ children }: { children: React.ReactNode }) => <>{children}</>
    : AppLayout;

  return (
    <Wrapper>
      <div className="space-y-5">
        {!embedded && (
          <PageHeaderBand
            crumbs={[{ label: 'Hub', to: ROUTES.DASHBOARD }, { label: 'Sales', to: ROUTES.SALES }, { label: TAB_LABEL[tab] }]}
            title="Sales"
            subtitle="Cash orders, layaway accounts, payments, and waivers"
          />
        )}

        <WorkspaceToolbar
          searchValue={
            tab === 'cash' ? cashSearch :
            tab === 'layaway' ? layawaySearch :
            tab === 'payments' ? paymentsSearch :
            tab === 'waivers' ? waiversSearch :
            ''
          }
          onSearchChange={
            tab === 'cash' ? setCashSearch :
            tab === 'layaway' ? setLayawaySearch :
            tab === 'payments' ? setPaymentsSearch :
            tab === 'waivers' ? setWaiversSearch :
            () => {}
          }
          searchPlaceholder={
            tab === 'cash' ? 'Search cash orders...' :
            tab === 'layaway' ? 'Search layaway accounts...' :
            tab === 'payments' ? 'Search payments...' :
            tab === 'waivers' ? 'Search waivers...' :
            'Search...'
          }
          onExport={handleExport}
          showExport={tab === 'cash' || tab === 'layaway'}
          splitButton={<WorkspaceSplitButton />}
          // Wraps the action button onto its own line on phones instead of
          // pushing it off-screen (pre-existing overflow at 375px).
          className="flex-wrap"
        />

        <Tabs value={tab} onValueChange={(v) => setTab(v as SalesTabKey)} className="w-full">
          <TabsContent value="cash" className="mt-5">
            <MemoCashOrdersList embedded searchValue={cashSearch} exportRef={cashExportRef} />
          </TabsContent>
          <TabsContent value="layaway" className="mt-5">
            <MemoAccountList embedded searchValue={layawaySearch} exportRef={layawayExportRef} />
          </TabsContent>
          <TabsContent value="payments" className="mt-5">
            <MemoPaymentsHub embedded searchValue={paymentsSearch} />
          </TabsContent>
          <TabsContent value="waivers" className="mt-5">
            <MemoWaivers embedded search={waiversSearch} />
          </TabsContent>
        </Tabs>

        <Page365ImportDialog open={page365Open} onOpenChange={setPage365Open} />
      </div>
    </Wrapper>
  );
}
