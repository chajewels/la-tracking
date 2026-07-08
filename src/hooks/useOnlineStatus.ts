import { useEffect, useState } from 'react';

/**
 * Tracks browser online/offline state via the standard online/offline
 * window events. `navigator.onLine` is read for the initial value (best-
 * effort — some browsers report true even on a captive portal/no real
 * connectivity, but it's the only synchronous signal available without a
 * network probe).
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
