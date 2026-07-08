import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { pt } from '@/i18n/portal';

/**
 * Fixed top banner shown while the browser reports no network connection.
 * Read-only notice — the Portal has no offline data cache/queue, so this
 * exists to explain stale/failed-fetch behavior rather than promise
 * offline functionality.
 */
export default function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;

  return (
    <div
      role="status"
      className="maison-portal font-body fixed top-0 inset-x-0 z-[60] flex items-center justify-center gap-2 bg-secondary text-foreground text-[12px] py-2 px-4 border-b border-border"
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.5rem)' }}
    >
      <WifiOff className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span>{pt('offline.message')}</span>
    </div>
  );
}
