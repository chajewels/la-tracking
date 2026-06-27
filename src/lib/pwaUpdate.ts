type UpdateFn = (reloadPage?: boolean) => Promise<void>;
let _updateSW: UpdateFn | null = null;
const dirtyForms = new Set<string>();

export function setUpdateSW(fn: UpdateFn) { _updateSW = fn; }
export function markFormDirty(id: string) { dirtyForms.add(id); }
export function markFormClean(id: string) { dirtyForms.delete(id); }
export function hasDirtyForm() { return dirtyForms.size > 0; }
export function applyUpdate() {
  if (_updateSW) {
    // updateSW(true) tells the waiting service worker to skipWaiting and
    // reloads the page itself once it takes control (controllerchange).
    // A synchronous window.location.reload() in the same tick races that
    // activation, so the reload gets served by the OLD service worker's
    // cache — the page comes back on the same commit. That was the
    // "Reload does nothing / same version" bug. Let updateSW drive the
    // reload, with a delayed fallback for the case where no SW is waiting
    // (the Hub banner can fire from version.json before a new SW has
    // installed) so the button is never a silent no-op.
    void _updateSW(true);
    window.setTimeout(() => window.location.reload(), 3000);
  } else {
    window.location.reload();
  }
}
