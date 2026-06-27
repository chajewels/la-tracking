type UpdateFn = (reloadPage?: boolean) => Promise<void>;
let _updateSW: UpdateFn | null = null;
const dirtyForms = new Set<string>();

export function setUpdateSW(fn: UpdateFn) { _updateSW = fn; }
export function markFormDirty(id: string) { dirtyForms.add(id); }
export function markFormClean(id: string) { dirtyForms.delete(id); }
export function hasDirtyForm() { return dirtyForms.size > 0; }
export function applyUpdate() {
  try {
    if (_updateSW) { void _updateSW(true); }
  } finally {
    window.location.reload();
  }
}
