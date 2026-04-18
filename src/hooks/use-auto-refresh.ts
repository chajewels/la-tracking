import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Auto-refresh React Query caches on a timer + expose a manual refresh.
 *
 * Usage:
 *   const { lastRefreshedAt, refreshing, refresh } = useAutoRefresh([
 *     ['account', id],
 *     ['schedule', id],
 *   ]);
 *
 * Every intervalMs (default 5 min) the provided query-key prefixes are
 * invalidated — which triggers refetch for any actively-rendered query
 * whose key starts with one of those prefixes. The `refresh` callback
 * does the same thing on demand and bumps `lastRefreshedAt`.
 */
const FIVE_MINUTES_MS = 5 * 60 * 1000;

export function useAutoRefresh(
  queryKeyPrefixes: readonly (readonly unknown[])[],
  intervalMs: number = FIVE_MINUTES_MS,
) {
  const queryClient = useQueryClient();
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date>(() => new Date());
  const [refreshing, setRefreshing] = useState(false);

  // Serialise the prefixes so the refresh callback identity changes only
  // when the list actually changes (not on every render of a fresh literal).
  const prefixesKey = JSON.stringify(queryKeyPrefixes);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const prefixes = JSON.parse(prefixesKey) as unknown[][];
      await Promise.all(
        prefixes.map((key) =>
          queryClient.invalidateQueries({ queryKey: key as readonly unknown[] })
        )
      );
    } finally {
      setLastRefreshedAt(new Date());
      setRefreshing(false);
    }
  }, [queryClient, prefixesKey]);

  useEffect(() => {
    if (!intervalMs || intervalMs <= 0) return;
    const id = setInterval(() => {
      const activeEl = document.activeElement;
      const isInputFocused = activeEl instanceof HTMLInputElement
        || activeEl instanceof HTMLTextAreaElement;
      if (isInputFocused) return;
      void refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);

  return { lastRefreshedAt, refreshing, refresh };
}
