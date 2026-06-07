// Financial Documentation — combines Submissions, Proof of Payment, and Waivers
import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import AppLayout from '@/components/layout/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Wallet } from 'lucide-react';
import PaymentSubmissions from './PaymentSubmissions';
import PaymentProofs from './PaymentProofs';
import Waivers from './Waivers';
import { useWaiverRequestCount } from '@/hooks/useWaiverRequestCount';
import WorkspaceToolbar from '@/components/layout/WorkspaceToolbar';
import WorkspaceSplitButton from '@/components/layout/WorkspaceSplitButton';

type TabKey = 'submissions' | 'proofs' | 'waivers';

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
            <h1 className="text-2xl font-bold font-display text-foreground tracking-tight flex items-center gap-2">
              <Wallet className="h-6 w-6 text-primary" />
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
          <TabsList className="grid grid-cols-3 w-full max-w-md">
            <TabsTrigger value="submissions">Submissions</TabsTrigger>
            <TabsTrigger value="proofs">Proof of Payment</TabsTrigger>
            <TabsTrigger value="waivers">
              Waivers
              {pendingWaivers > 0 && (
                <span
                  className="ml-2 inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                  style={{
                    background: 'rgba(245, 158, 11, 0.18)',
                    color: '#B45309',
                    border: '1px solid rgba(245, 158, 11, 0.35)',
                  }}
                >
                  {pendingWaivers}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="submissions" className="mt-5" tabIndex={-1}>
            <PaymentSubmissions embedded searchValue={search} />
          </TabsContent>

          <TabsContent value="proofs" className="mt-5" tabIndex={-1}>
            <PaymentProofs embedded />
          </TabsContent>

          <TabsContent value="waivers" className="mt-5" tabIndex={-1}>
            <Waivers embedded />
          </TabsContent>
        </Tabs>
      </div>
    </Wrapper>
  );
}
