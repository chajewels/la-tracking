import { useEffect, useState } from 'react';

const BOOTED = (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '')
  .split('·').pop()?.trim() ?? '';

export function useVersionCheck(intervalMs = 60_000) {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    if (!BOOTED) return;
    let cancelled = false;

    const check = async () => {
      try {
        const res = await fetch('/version.json', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const served = String(data?.version ?? '').trim();
        if (!cancelled && served && served !== BOOTED) {
          setUpdateAvailable(true);
        }
      } catch {
        // network blip — stay silent
      }
    };

    check();
    const id = window.setInterval(check, intervalMs);
    const onFocus = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onFocus);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [intervalMs]);

  return updateAvailable;
}
