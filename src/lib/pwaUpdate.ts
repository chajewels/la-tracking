type UpdateFn = (reloadPage?: boolean) => Promise<void>;
let _updateSW: UpdateFn | null = null;
const dirtyForms = new Set<string>();

export function setUpdateSW(fn: UpdateFn) { _updateSW = fn; }
export function markFormDirty(id: string) { dirtyForms.add(id); }
export function markFormClean(id: string) { dirtyForms.delete(id); }
export function hasDirtyForm() { return dirtyForms.size > 0; }
export function applyUpdate() {
  // Reload exactly once when the new SW takes control. Guarded so neither
  // the controllerchange listener nor the fallback can double-fire.
  let reloaded = false;
  const reloadOnce = () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  };

  if (!('serviceWorker' in navigator)) {
    reloadOnce();
    return;
  }

  // A new controller taking over = the waiting worker activated. This is
  // the reliable reload trigger, independent of any cached updateSW handle.
  navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });

  // Tell whatever worker is ACTUALLY waiting right now to skipWaiting.
  // The registerSW updateSW(true) handle is captured at first onNeedRefresh
  // and goes stale across successive deploys, so it can miss the live
  // waiting worker (observed: worker stuck "waiting to activate", banner
  // never clears). Reading registration.waiting at click time fixes that.
  navigator.serviceWorker.getRegistration().then((reg) => {
    if (reg?.waiting) {
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    } else {
      // No waiting worker (e.g. Hub banner fired from version.json before a
      // SW installed) — try the registerSW handle, then fall through to the
      // timeout reload so the button is never a silent no-op.
      if (_updateSW) void _updateSW(true);
    }
  }).catch(() => {
    if (_updateSW) void _updateSW(true);
  });

  // Last-resort fallback: if controllerchange never fires (no waiting worker
  // to activate, or activation stalls), reload anyway after a delay.
  window.setTimeout(reloadOnce, 3000);
}
