// Financial Documentation — combines Submissions, Proof of Payment, and Waivers
import { useEffect, useState, type ReactNode, type FC } from 'react';
import { useSearchParams } from 'react-router-dom';
import AppLayout from '@/components/layout/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Wallet } from 'lucide-react';
import PaymentSubmissionsImpl from './PaymentSubmissions';
import PaymentProofsImpl from './PaymentProofs';
import Waivers from './Waivers';

// Typed re-exports: the memo() wrappers on these components widen their inferred
// props to `object`; re-point each import at its real prop interface.
const PaymentSubmissions = PaymentSubmissionsImpl as FC<{ embedded?: boolean; searchValue?: string }>;
const PaymentProofs = PaymentProofsImpl as FC<{ embedded?: boolean; searchValue?: string }>;
import { useWaiverRequestCount } from '@/hooks/useWaiverRequestCount';
import WorkspaceToolbar from '@/components/layout/WorkspaceToolbar';
import WorkspaceSplitButton from '@/components/layout/WorkspaceSplitButton';

type TabKey = 'submissions' | 'proofs' | 'waivers';

const SUBTAB =
  'rounded-none px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none';

interface PaymentsHubProps {
  embedded?: boolean;
  searchValue?: string;
}

export default function PaymentsHub({ embedded = false, searchValue }: PaymentsHubProps = {}) {
  const { count: pendingWaivers } = useWaiverRequestCount();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab: TabKey = (['proofs', 'waivers'].includes(searchParams.get('tab') || '') ? searchParams.get('tab') as TabKey : 'submissions');
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [search, setSearch] = useState('');

  // When embedded, mirror the parent's search value into the local
  // search state so PaymentSubmissions sees the same query.
  useEffect(() => {
    if (embedded && searchValue !== undefined) {
      setSearch(searchValue);
    }
  }, [embedded, searchValue]);

  useEffect(() => {
    if (embedded) return;
    const current = searchParams.get('tab');
    const desired = tab !== 'submissions' ? tab : null;
    if (current !== desired) {
      const next = new URLSearchParams(searchParams);
      if (desired) next.set('tab', desired);
      else next.delete('tab');
      setSearchParams(next, { replace: true });
    }
  }, [tab, searchParams, setSearchParams, embedded]);

  useEffect(() => {
    if (embedded) return;
    const urlTab = searchParams.get('tab') as TabKey | null;
    const resolved: TabKey = urlTab && ['proofs', 'waivers'].includes(urlTab) ? urlTab : 'submissions';
    if (resolved !== tab) setTab(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, embedded]);

  const Wrapper = embedded ? ({ children }: { children: ReactNode }) => <>{children}</> : AppLayout;

  return (
    <Wrapper>
      <div className={embedded ? 'space-y-5' : 'p-4 sm:p-6 space-y-5 max-w-6xl mx-auto'}>
        {!embedded && (
          <div>
            <h1 className="font-deco text-3xl font-semibold tracking-tight text-champagne flex items-center gap-2">
              <Wallet className="h-6 w-6 text-gold-300" />
              Financial Documentation
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Review submissions, browse proofs, and manage penalty waivers.
            </p>
          </div>
        )}

        {!embedded && (
          <WorkspaceToolbar
            searchValue={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search payments..."
            splitButton={<WorkspaceSplitButton />}
          />
        )}

        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="w-full">
          {/* Same underline strip as the Cash / Layaway status tabs, so the
              four Sales tabs read as one design. */}
          <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-b border-border bg-transparent p-0">
            <TabsTrigger value="submissions" className={SUBTAB}>Submissions</TabsTrigger>
            <TabsTrigger value="proofs" className={SUBTAB}>Proof of Payment</TabsTrigger>
            <TabsTrigger value="waivers" className={SUBTAB}>
              Waivers
              {pendingWaivers > 0 && (
                <span className="ml-1.5 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning tabular-nums">
                  {pendingWaivers}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="submissions" className="mt-5" tabIndex={-1}>
            <PaymentSubmissions embedded searchValue={search} />
          </TabsContent>

          <TabsContent value="proofs" className="mt-5" tabIndex={-1}>
            <PaymentProofs embedded searchValue={search} />
          </TabsContent>

          <TabsContent value="waivers" className="mt-5" tabIndex={-1}>
            <Waivers embedded search={search} />
          </TabsContent>
        </Tabs>
      </div>
    </Wrapper>
  );
}
