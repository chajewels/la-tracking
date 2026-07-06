import { useEffect, type RefObject } from 'react';

/**
 * Keyboard navigation for card lists:
 *   ↑ / ↓  — move focus between elements marked data-nav-card
 *   /      — focus the surface's search input (first input whose
 *            placeholder mentions "Search"), unless already typing
 * Enter/Space activation is handled on the cards themselves (they are
 * focusable role="button" elements), so it works with or without this hook.
 */
export function useListKeyboardNav(containerRef: RefObject<HTMLElement>) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const cards = () =>
      Array.from(container.querySelectorAll<HTMLElement>('[data-nav-card]'));

    const onContainerKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select')) return;
      const list = cards();
      const idx = list.indexOf(target.closest('[data-nav-card]') as HTMLElement);
      if (idx === -1) return;
      e.preventDefault();
      const next = list[idx + (e.key === 'ArrowDown' ? 1 : -1)];
      next?.focus();
    };

    const onDocKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && active.closest('input, textarea, select, [contenteditable="true"]')) return;
      const search = document.querySelector<HTMLInputElement>('input[placeholder*="Search" i]');
      if (search) {
        e.preventDefault();
        search.focus();
      }
    };

    container.addEventListener('keydown', onContainerKey);
    document.addEventListener('keydown', onDocKey);
    return () => {
      container.removeEventListener('keydown', onContainerKey);
      document.removeEventListener('keydown', onDocKey);
    };
  }, [containerRef]);
}
