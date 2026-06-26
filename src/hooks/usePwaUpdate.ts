import { useEffect, useState } from 'react';
import { applyUpdate, hasDirtyForm } from '@/lib/pwaUpdate';

export function usePwaUpdate() {
  const [updateReady, setUpdateReady] = useState(false);
  useEffect(() => {
    const onNeed = () => setUpdateReady(true);
    window.addEventListener('pwa:need-refresh', onNeed);
    return () => window.removeEventListener('pwa:need-refresh', onNeed);
  }, []);
  return { updateReady, applyUpdate, hasDirtyForm };
}
