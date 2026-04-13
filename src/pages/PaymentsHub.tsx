// Payments Hub — combines Payment Submissions and Proof of Payment under one page
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import AppLayout from '@/components/layout/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Wallet } from 'lucide-react';
import PaymentSubmissions from './PaymentSubmissions';
import PaymentProofs from './PaymentProofs';

type TabKey = 'submissions' | 'proofs';

export default function PaymentsHub() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab: TabKey = searchParams.get('tab') === 'proofs' ? 'proofs' : 'submissions';
  const [tab, setTab] = useState<TabKey>(initialTab);

  // Keep URL in sync so deep links work and browser back/forward behave.
  useEffect(() => {
    const current = searchParams.get('tab');
    const desired = tab === 'proofs' ? 'proofs' : null;
    if (current !== desired) {
      const next = new URLSearchParams(searchParams);
      if (desired) next.set('tab', desired);
      else next.delete('tab');
      setSearchParams(next, { replace: true });
    }
  }, [tab, searchParams, setSearchParams]);

  // If the URL tab param changes (e.g. via external navigation), reflect it.
  useEffect(() => {
    const urlTab: TabKey = searchParams.get('tab') === 'proofs' ? 'proofs' : 'submissions';
    if (urlTab !== tab) setTab(urlTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return (
    <AppLayout>
      <div className="p-4 sm:p-6 space-y-5 max-w-6xl mx-auto">
        <div>
          <h1 className="text-2xl font-bold font-display text-foreground tracking-tight flex items-center gap-2">
            <Wallet className="h-6 w-6 text-primary" />
            Submissions &amp; Proofs
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Review customer payment submissions and browse all uploaded proofs in one place.
          </p>
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="w-full">
          <TabsList className="grid grid-cols-2 w-full max-w-md">
            <TabsTrigger value="submissions">Submissions</TabsTrigger>
            <TabsTrigger value="proofs">Proof of Payment</TabsTrigger>
          </TabsList>

          <TabsContent value="submissions" className="mt-5">
            <PaymentSubmissions embedded />
          </TabsContent>

          <TabsContent value="proofs" className="mt-5">
            <PaymentProofs embedded />
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
