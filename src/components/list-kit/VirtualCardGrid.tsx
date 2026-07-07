import { useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';

/**
 * Window-scrolled virtualized card grid. Items are chunked into rows that
 * mirror the responsive grid used by the plain lists (1 col, sm:2, lg:3).
 *
 * RENDER-layer only: this changes how many cards are mounted at once, not
 * how data is fetched — the parked P5 full-table fetch decision is untouched.
 * Engage it only for large revealed lists (the caller decides the threshold);
 * small lists keep the plain grid with entrance stagger.
 */

function subscribeToMedia(cb: () => void) {
  const mqs = [window.matchMedia('(min-width: 640px)'), window.matchMedia('(min-width: 1024px)')];
  mqs.forEach(mq => mq.addEventListener('change', cb));
  return () => mqs.forEach(mq => mq.removeEventListener('change', cb));
}

function getColumns(): number {
  if (window.matchMedia('(min-width: 1024px)').matches) return 3;
  if (window.matchMedia('(min-width: 640px)').matches) return 2;
  return 1;
}

interface VirtualCardGridProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  /** Estimated row height in px (card + gap). Rows self-measure after mount. */
  estimateRowHeight?: number;
}

export default function VirtualCardGrid<T>({
  items,
  renderItem,
  estimateRowHeight = 230,
}: VirtualCardGridProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const columns = useSyncExternalStore(subscribeToMedia, getColumns, () => 1);
  const rowCount = Math.ceil(items.length / columns);

  const virtualizer = useWindowVirtualizer({
    count: rowCount,
    estimateSize: () => estimateRowHeight,
    overscan: 4,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });

  return (
    <div ref={listRef}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(vRow => {
          const start = vRow.index * columns;
          const rowItems = items.slice(start, start + columns);
          return (
            <div
              key={vRow.key}
              ref={virtualizer.measureElement}
              data-index={vRow.index}
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-4"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vRow.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              {rowItems.map((item, i) => renderItem(item, start + i))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
