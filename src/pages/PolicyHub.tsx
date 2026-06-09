import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { cn } from '@/lib/utils';

const POLICY_TABS = [
  { key: 'overview', label: 'Overview', url: 'https://cha-jewels-privacy.web.app/index.html' },
  { key: 'return', label: 'Return Policy', url: 'https://cha-jewels-privacy.web.app/return.html' },
  { key: 'refund', label: 'Refund Policy', url: 'https://cha-jewels-privacy.web.app/refund.html' },
  { key: 'cancellation', label: 'Cancellation Policy', url: 'https://cha-jewels-privacy.web.app/cancellation.html' },
  { key: 'flow', label: 'Return & Refund Flow', url: 'https://cha-jewels-privacy.web.app/flow.html' },
  { key: 'privacy', label: 'Privacy Policy', url: 'https://cha-jewels-privacy.web.app/privacy.html' },
  { key: 'layaway-agreement', label: 'Layaway Agreement', url: 'https://agreement.chajewelsjp.com/' },
  { key: 'trade', label: 'Trade Program', url: 'https://chajewelstrade.chajewelsjp.com/' },
] as const;

type TabKey = typeof POLICY_TABS[number]['key'];

const DEFAULT_TAB: TabKey = 'overview';

function isTabKey(value: string | null): value is TabKey {
  return !!value && POLICY_TABS.some((t) => t.key === value);
}

export default function PolicyHub() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initial = searchParams.get('tab');
  const [tab, setTabState] = useState<TabKey>(isTabKey(initial) ? initial : DEFAULT_TAB);

  useEffect(() => {
    const next = searchParams.get('tab');
    if (isTabKey(next) && next !== tab) {
      setTabState(next);
    }
  }, [searchParams, tab]);

  const setTab = (next: TabKey) => {
    setTabState(next);
    const sp = new URLSearchParams(searchParams);
    sp.set('tab', next);
    setSearchParams(sp, { replace: true });
  };

  const active = POLICY_TABS.find((t) => t.key === tab) ?? POLICY_TABS[0];

  return (
    <AppLayout>
      <div className="p-4 sm:p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl gold-gradient">
            <BookOpen className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground font-display">
              Policy Hub
            </h1>
            <p className="text-sm text-muted-foreground">
              Cha Jewels policies, agreements, and guidelines
            </p>
          </div>
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1 border-b border-border">
          {POLICY_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'whitespace-nowrap px-3 py-1.5 text-sm rounded-md transition-colors',
                tab === t.key
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <iframe
          key={tab}
          src={active.url}
          className="w-full rounded-lg border border-border"
          style={{ height: 'calc(100vh - 220px)' }}
          title={active.label}
        />
      </div>
    </AppLayout>
  );
}
