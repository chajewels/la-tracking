import { useCallback, useEffect, useRef, useState, memo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ShoppingBag } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import WorkspaceToolbar from '@/components/layout/WorkspaceToolbar';
import WorkspaceSplitButton from '@/components/layout/WorkspaceSplitButton';
import CashOrdersList from '@/components/customers/CashOrdersList';
import AccountList from './AccountList';
import PaymentsHub from './PaymentsHub';
import Waivers from './Waivers';

const MemoCashOrdersList = memo(CashOrdersList);
const MemoAccountList = memo(AccountList);
const MemoPaymentsHub = memo(PaymentsHub);
const MemoWaivers = memo(Waivers);

type SalesTabKey = 'cash' | 'layaway' | 'payments' | 'waivers';
const VALID_TABS: SalesTabKey[] = ['cash', 'layaway', 'payments', 'waivers'];
const DEFAULT_TAB: SalesTabKey = 'cash';

interface SalesProps {
  embedded?: boolean;
}

export default function Sales({ embedded = false }: SalesProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTabState] = useState<SalesTabKey>(() => {
    const urlTab = searchParams.get('tab') as SalesTabKey | null;
    return urlTab && VALID_TABS.includes(urlTab) ? urlTab : DEFAULT_TAB;
  });
  const [search, setSearch] = useState('');

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

  const setTab = (next: SalesTabKey) => {
    setTabState(next);
    setSearch('');
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  const Wrapper = embedded
    ? ({ children }: { children: React.ReactNode }) => <>{children}</>
    : AppLayout;

  return (
    <Wrapper>
      <div className={embedded ? 'space-y-5' : 'p-4 sm:p-6 space-y-5'}>
        {!embedded && (
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl gold-gradient">
              <ShoppingBag className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-foreground font-display">
                Sales
              </h1>
              <p className="text-sm text-muted-foreground">
                Cash orders, layaway accounts, payments, and waivers
              </p>
            </div>
          </div>
        )}

        <WorkspaceToolbar
          searchValue={search}
          onSearchChange={setSearch}
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
        />

        <Tabs value={tab} onValueChange={(v) => setTab(v as SalesTabKey)} className="w-full">
          <TabsContent value="cash" className="mt-5">
            <MemoCashOrdersList embedded searchValue={tab === 'cash' ? search : ''} exportRef={cashExportRef} />
          </TabsContent>
          <TabsContent value="layaway" className="mt-5">
            <MemoAccountList embedded searchValue={tab === 'layaway' ? search : ''} exportRef={layawayExportRef} />
          </TabsContent>
          <TabsContent value="payments" className="mt-5">
            <MemoPaymentsHub embedded searchValue={tab === 'payments' ? search : ''} />
          </TabsContent>
          <TabsContent value="waivers" className="mt-5">
            <MemoWaivers embedded />
          </TabsContent>
        </Tabs>
      </div>
    </Wrapper>
  );
}
