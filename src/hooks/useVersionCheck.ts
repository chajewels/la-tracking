import { useEffect, useState } from 'react';

const BOOTED = (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '')
  .split('·').pop()?.trim() ?? '';

export function useVersionCheck(intervalMs = 60_000) {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    if (!BOOTED) return;
    let cancelled = false;
    let shown = false;
    let updateFoundAttached = false;

    const show = () => {
      if (cancelled || shown) return;
      shown = true;
      setUpdateAvailable(true);
    };

    // Only promote to "update available" when a worker is genuinely waiting to
    // activate (and a controller already exists, i.e. this is an update, not a
    // first install). That guarantees a single Reload click can skipWaiting it.
    const promoteIfReady = (reg: ServiceWorkerRegistration) => {
      if (reg.waiting && navigator.serviceWorker.controller) { show(); return true; }
      return false;
    };

    // version.json says a deploy happened. Convert that into an actual waiting
    // worker by forcing an SW update check, so the banner only appears once the
    // reload will really work — even on a tab open long enough that the SW
    // hasn't re-checked on its own.
    const ensureWorker = async () => {
      if (shown) return;
      if (!('serviceWorker' in navigator)) { show(); return; }
      const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
      if (!reg) return;
      if (promoteIfReady(reg)) return;
      if (!updateFoundAttached) {
        updateFoundAttached = true;
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed') promoteIfReady(reg);
          });
        });
      }
      await reg.update().catch(() => {});
      promoteIfReady(reg);
    };

    const check = async () => {
      if (shown) return;
      try {
        const res = await fetch('/version.json', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const served = String(data?.version ?? '').trim();
        if (served && served !== BOOTED) void ensureWorker();
      } catch {
        // network blip — stay silent
      }
    };

    // Fast path: the SW reached "waiting" and registerSW fired need-refresh.
    const onNeedRefresh = () => show();
    window.addEventListener('pwa:need-refresh', onNeedRefresh);

    check();
    const id = window.setInterval(check, intervalMs);
    const onFocus = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onFocus);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('pwa:need-refresh', onNeedRefresh);
    };
  }, [intervalMs]);

  return updateAvailable;
}
