import { Fragment, useEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronDown, ChevronRight, Columns3, Download, Filter, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import DensityToggle, { useDensity, type Density } from '@/components/list-kit/DensityToggle';
import { transition } from '@/theme/motion';
import { downloadCsv } from '@/lib/csv';
import { cn } from '@/lib/utils';

/**
 * Opt-in data-table composite over the ui/table primitives.
 *
 * The primitives (ui/table.tsx) stay behavior-free — every capability here
 * (sort, per-column filter, global search, density, column show/hide, CSV,
 * row expansion, sticky header) is enabled per-consumer via props, so
 * adopting DataTable never silently changes an existing screen.
 *
 * With server-paginated data, pass the current page as `rows` — sorting and
 * searching then apply to the loaded page only; say so via `note`.
 */

export interface DataTableColumn<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Enables click-to-sort on this column. */
  sortValue?: (row: T) => string | number | null;
  /** Enables the per-column text filter on this column. */
  filterValue?: (row: T) => string;
  /** Plain-text value for CSV export (falls back to filterValue/sortValue). */
  csvValue?: (row: T) => string | number;
  align?: 'left' | 'right';
  headClassName?: string;
  cellClassName?: string;
  /** Set false to pin the column out of the show/hide menu. */
  hideable?: boolean;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Renders an expandable detail row (chevron column is added). */
  renderExpanded?: (row: T) => ReactNode;
  /** Enables the global search box; return the searchable strings per row. */
  searchText?: (row: T) => string[];
  /** Enables the CSV export button; used as the download filename prefix. */
  csvName?: string;
  /** Enables the density toggle, persisted under this storage key. */
  densityKey?: string;
  stickyHeader?: boolean;
  /** Extra toolbar content (filters etc.), rendered left of the built-ins. */
  toolbar?: ReactNode;
  /** Small caption under the toolbar, e.g. "Sort applies to this page". */
  note?: string;
  emptyState?: ReactNode;
  className?: string;
  /**
   * Hub visual refresh: 'ledger' = blurred sticky header on a bare <table>
   * (so the header genuinely sticks inside the scroll box), a gold rail on
   * the hovered / focused row, uppercase tracked headings. 'default' keeps
   * the original look for existing consumers.
   */
  variant?: 'default' | 'ledger';
  /** Set false to hide the built-in toolbar (search / columns / CSV). */
  showToolbar?: boolean;
  /** Extra props per row, e.g. data-* hooks, tabIndex, onKeyDown, aria-label. */
  rowProps?: (row: T) => HTMLAttributes<HTMLTableRowElement> & Record<`data-${string}`, string | boolean | undefined>;
  /** Controlled density (overrides the internal persisted toggle). */
  density?: Density;
  /** Scroll-box height cap when stickyHeader is on. */
  maxHeightClassName?: string;
  /**
   * Render-layer windowing once more than this many rows are shown (rows
   * outside the scroll box are not mounted). Ignored with renderExpanded.
   */
  virtualizeAbove?: number;
}

interface TableSort {
  key: string;
  dir: 'asc' | 'desc';
}

export default function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  renderExpanded,
  searchText,
  csvName,
  densityKey,
  stickyHeader = true,
  toolbar,
  note,
  emptyState,
  className,
  variant = 'default',
  showToolbar = true,
  rowProps,
  density: densityProp,
  maxHeightClassName = 'max-h-[70vh]',
  virtualizeAbove,
}: DataTableProps<T>) {
  const ledger = variant === 'ledger';
  const reducedMotion = useReducedMotion();
  const [sort, setSort] = useState<TableSort | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [storedDensity, setDensity] = useDensity(densityKey ?? 'cj-data-table-density');
  const density = densityProp ?? storedDensity;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Global search debounce: 250ms.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const visibleColumns = columns.filter(c => !hidden.has(c.key));

  const processedRows = useMemo(() => {
    let out = rows;
    if (searchText && search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter(r => searchText(r).some(s => s.toLowerCase().includes(q)));
    }
    for (const [key, value] of Object.entries(columnFilters)) {
      if (!value.trim()) continue;
      const col = columns.find(c => c.key === key);
      if (!col?.filterValue) continue;
      const q = value.trim().toLowerCase();
      out = out.filter(r => col.filterValue!(r).toLowerCase().includes(q));
    }
    if (sort) {
      const col = columns.find(c => c.key === sort.key);
      if (col?.sortValue) {
        const mul = sort.dir === 'asc' ? 1 : -1;
        out = [...out].sort((a, b) => {
          const va = col.sortValue!(a);
          const vb = col.sortValue!(b);
          if (va == null && vb == null) return 0;
          if (va == null) return 1;
          if (vb == null) return -1;
          if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul;
          return String(va).localeCompare(String(vb)) * mul;
        });
      }
    }
    return out;
  }, [rows, columns, search, searchText, columnFilters, sort]);

  const toggleSort = (key: string) => {
    setSort(prev => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return null;
    });
  };

  const exportCsv = () => {
    const cols = visibleColumns;
    downloadCsv(
      csvName ?? 'export',
      cols.map(c => c.header),
      processedRows.map(r =>
        cols.map(c => c.csvValue?.(r) ?? c.filterValue?.(r) ?? c.sortValue?.(r) ?? ''),
      ),
    );
  };

  const shouldVirtualize =
    !!virtualizeAbove && !renderExpanded && stickyHeader && processedRows.length > virtualizeAbove;
  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? processedRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (density === 'compact' ? 37 : 49),
    overscan: 12,
  });
  const virtualItems = shouldVirtualize ? virtualizer.getVirtualItems() : [];
  const padTop = virtualItems.length ? virtualItems[0].start : 0;
  const padBottom = virtualItems.length ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end : 0;
  const renderedRows = shouldVirtualize
    ? virtualItems.map(v => ({ row: processedRows[v.index], index: v.index }))
    : processedRows.map((row, index) => ({ row, index }));

  const activeFilterCount = Object.values(columnFilters).filter(v => v.trim()).length;
  const cellPad = density === 'compact' ? 'py-1.5 px-3' : 'py-3 px-4';
  const colSpan = visibleColumns.length + (renderExpanded ? 1 : 0);

  return (
    <div className={cn('space-y-3', className)}>
      {/* Toolbar */}
      {showToolbar && (
      <div className="flex flex-wrap items-center gap-2">
        {toolbar}
        {searchText && (
          <div className="relative w-full sm:w-auto">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Search…"
              aria-label="Search table"
              className="h-11 sm:h-9 w-full sm:w-[200px] pl-8 text-base sm:text-sm"
            />
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {densityKey && <DensityToggle value={density} onChange={setDensity} />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" aria-label="Show columns" className="h-9 gap-1.5 text-xs">
                <Columns3 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Columns</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel className="label-caps">Show columns</DropdownMenuLabel>
              {columns
                .filter(c => c.hideable !== false)
                .map(c => (
                  <DropdownMenuCheckboxItem
                    key={c.key}
                    className="text-xs"
                    checked={!hidden.has(c.key)}
                    onCheckedChange={checked => {
                      setHidden(prev => {
                        const next = new Set(prev);
                        if (checked) next.delete(c.key);
                        else next.add(c.key);
                        return next;
                      });
                    }}
                  >
                    {c.header}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {csvName && (
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 text-xs"
              onClick={exportCsv}
              aria-label="Export CSV"
              disabled={processedRows.length === 0}
            >
              <Download className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Export CSV</span>
            </Button>
          )}
        </div>
      </div>
      )}

      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}

      {/* Table */}
      <div
        ref={scrollRef}
        className={cn(
          'rounded-lg border',
          ledger ? 'border-gold-500/15 bg-card/70' : 'border-border bg-card',
          stickyHeader ? cn('overflow-auto', maxHeightClassName) : 'overflow-hidden',
        )}
      >
        <TableShell ledger={ledger}>
          <TableHeader
            className={cn(
              stickyHeader && 'sticky top-0 z-10',
              stickyHeader && (ledger ? 'bg-surface-1/70 backdrop-blur-md' : 'bg-card'),
            )}
          >
            <TableRow className="hover:bg-transparent">
              {renderExpanded && <TableHead className="w-8" aria-label="Expand" />}
              {visibleColumns.map(col => {
                const sorted = sort?.key === col.key ? sort.dir : null;
                return (
                  <TableHead
                    key={col.key}
                    className={cn(
                      'whitespace-nowrap',
                      ledger && 'h-10 text-[11px] font-medium uppercase tracking-[0.12em] text-ink-muted',
                      col.align === 'right' && 'text-right',
                      col.headClassName,
                    )}
                    aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    <span className={cn('inline-flex items-center gap-1', col.align === 'right' && 'flex-row-reverse')}>
                      {col.sortValue ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(col.key)}
                          className="inline-flex min-h-11 sm:min-h-8 items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {col.header}
                          <motion.span
                            animate={{ rotate: sorted === 'asc' ? 180 : 0, opacity: sorted ? 1 : 0.25 }}
                            transition={transition.micro}
                            className="inline-flex"
                          >
                            <ChevronDown className="h-3 w-3" />
                          </motion.span>
                        </button>
                      ) : (
                        col.header
                      )}
                      {col.filterValue && (
                        <Popover>
                          <PopoverTrigger asChild>
                            <button
                              type="button"
                              aria-label={`Filter ${col.header}`}
                              className={cn(
                                'inline-flex h-11 w-11 sm:h-8 sm:w-8 items-center justify-center rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                columnFilters[col.key]?.trim() && 'opacity-100 text-gold-300',
                              )}
                            >
                              <Filter className="h-3 w-3" />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent className="w-56 p-2" align="start">
                            <Input
                              autoFocus
                              value={columnFilters[col.key] ?? ''}
                              onChange={e => setColumnFilters(prev => ({ ...prev, [col.key]: e.target.value }))}
                              placeholder={`Filter ${col.header.toLowerCase()}…`}
                              aria-label={`Filter ${col.header}`}
                              className="h-11 sm:h-9 text-base sm:text-sm"
                            />
                          </PopoverContent>
                        </Popover>
                      )}
                    </span>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {processedRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-center py-10">
                  {emptyState ?? <span className="text-sm text-muted-foreground">No rows match.</span>}
                </TableCell>
              </TableRow>
            ) : (
              <>
              {padTop > 0 && <tr aria-hidden style={{ height: padTop }} />}
              {renderedRows.map(({ row, index }) => {
                const key = rowKey(row);
                const isExpanded = expanded === key;
                const extra = rowProps?.(row);
                return (
                  <Fragment key={key}>
                    <TableRow
                      {...extra}
                      ref={shouldVirtualize ? virtualizer.measureElement : undefined}
                      data-index={shouldVirtualize ? index : undefined}
                      className={cn(
                        onRowClick && 'cursor-pointer',
                        ledger
                          ? 'ledger-row border-border/60 hover:bg-gold-500/[0.04] focus-visible:bg-gold-500/[0.06] focus-visible:outline-none'
                          : 'hover:bg-muted/40',
                        extra?.className,
                      )}
                      onClick={() => onRowClick?.(row)}
                    >
                      {renderExpanded && (
                        <TableCell className={cn('w-8', cellPad)} onClick={e => e.stopPropagation()}>
                          <button
                            type="button"
                            aria-label={isExpanded ? 'Collapse row' : 'Expand row'}
                            aria-expanded={isExpanded}
                            onClick={() => setExpanded(isExpanded ? null : key)}
                            className="inline-flex h-11 w-11 sm:h-8 sm:w-8 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <motion.span animate={{ rotate: isExpanded ? 90 : 0 }} transition={transition.micro} className="inline-flex">
                              <ChevronRight className="h-3.5 w-3.5" />
                            </motion.span>
                          </button>
                        </TableCell>
                      )}
                      {visibleColumns.map(col => (
                        <TableCell
                          key={col.key}
                          className={cn(
                            'text-xs',
                            cellPad,
                            col.align === 'right' && 'text-right tabular-nums',
                            // Ledger: money / dates never break across lines.
                            ledger && col.align === 'right' && 'whitespace-nowrap',
                            col.cellClassName,
                          )}
                        >
                          {col.cell(row)}
                        </TableCell>
                      ))}
                    </TableRow>
                    {renderExpanded && (
                      <AnimatePresence initial={false}>
                        {isExpanded && (
                          <TableRow key={`${key}-expanded`} className="hover:bg-transparent">
                            <TableCell colSpan={colSpan} className="p-0">
                              <motion.div
                                initial={{ opacity: reducedMotion ? 1 : 0 }}
                                animate={{ opacity: 1, transition: transition.standard }}
                                exit={{ opacity: 0, transition: reducedMotion ? { duration: 0 } : transition.micro }}
                                className="overflow-hidden"
                              >
                                <div className="px-4 py-3 bg-surface-2/50 hairline-t">{renderExpanded(row)}</div>
                              </motion.div>
                            </TableCell>
                          </TableRow>
                        )}
                      </AnimatePresence>
                    )}
                  </Fragment>
                );
              })}
              {padBottom > 0 && <tr aria-hidden style={{ height: padBottom }} />}
              </>
            )}
          </TableBody>
        </TableShell>
      </div>
    </div>
  );
}

/**
 * The ledger variant renders a bare <table>: ui/table's <Table> wraps its
 * table in its own overflow-auto div, which becomes the sticky containing
 * block and stops the header sticking inside our scroll box. The default
 * variant keeps <Table> so existing consumers are byte-for-byte unchanged.
 */
function TableShell({ ledger, children }: { ledger: boolean; children: ReactNode }) {
  if (ledger) return <table className="w-full caption-bottom text-sm">{children}</table>;
  return <Table>{children}</Table>;
}
