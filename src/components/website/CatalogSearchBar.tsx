import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { type CatalogFilters, NO_PRODUCT_TYPE, hasActiveFilters } from "@/lib/catalog-search";

/**
 * The Products card's search box, filters and "Jump to" product types
 * (Website → Catalog). Stateless: ProductsCard owns the state, which lives in
 * the URL (?q=&type=&category=&status=&stock=, within the ?view= tab) — see
 * src/lib/catalog-search.ts.
 *
 * Since 2026-09-28 the list itself is grouped under product-type headings, so
 * the chips no longer filter: they JUMP to a group (the Product type select
 * still narrows the list to one type). Everything counts within the open tab.
 * Since the types became collapsible sections (closed by default), a chip opens
 * its type and closes the others; Open all / Close all sit beside the chips.
 */

// Radix Select cannot hold "" as an item value.
const ALL = "__all";

export interface TypeOption { id: string; name: string }

interface Props {
  query: string;
  onQueryChange: (q: string) => void;
  filters: CatalogFilters;
  onFiltersChange: (patch: Partial<CatalogFilters>) => void;
  onClear: () => void;
  types: TypeOption[];
  categories: TypeOption[];
  statuses: string[];
  counts: { all: number; none: number; byType: Map<string, number> };
  shown: number;
  total: number;
  /** "published products" / "unpublished products" — what the counts are of. */
  noun?: string;
  /** Open a product-type group, close the others and scroll to it (website_collections id or NO_PRODUCT_TYPE). */
  onJump?: (typeId: string) => void;
  onOpenAll?: () => void;
  onCloseAll?: () => void;
  /** Sections open / sections listed, to disable Open all or Close all when there is nothing to do. */
  openCount?: number;
  groupCount?: number;
}

export function CatalogSearchBar({
  query, onQueryChange, filters, onFiltersChange, onClear, types, categories, statuses, counts, shown, total,
  noun = "products", onJump, onOpenAll, onCloseAll, openCount = 0, groupCount = 0,
}: Props) {
  const active = hasActiveFilters({ ...filters, q: query });
  // The groups on screen: every type, or only the one the type filter picked.
  const chips: Array<{ value: string; label: string; count: number }> = [
    ...types.map((t) => ({ value: t.id, label: t.name, count: counts.byType.get(t.id) ?? 0 })),
    { value: NO_PRODUCT_TYPE, label: "No product type", count: counts.none },
  ].filter((c) => !filters.type || c.value === filters.type);

  return (
    <div className="space-y-3 border-b border-border px-4 py-3" data-testid="catalog-search-bar">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative lg:w-80">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search code, SKU or name (EN / JA)"
            aria-label="Search products"
            className="pl-8 pr-8"
            data-testid="catalog-search-input"
          />
          {query && (
            <button
              type="button"
              onClick={() => onQueryChange("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
          <FilterSelect
            label="Product type" value={filters.type} onChange={(v) => onFiltersChange({ type: v })}
            options={[
              ...types.map((t) => ({ value: t.id, label: `${t.name} (${counts.byType.get(t.id) ?? 0})` })),
              { value: NO_PRODUCT_TYPE, label: `No product type (${counts.none})` },
            ]}
          />
          <FilterSelect
            label="Category" value={filters.category} onChange={(v) => onFiltersChange({ category: v })}
            options={categories.map((c) => ({ value: c.id, label: c.name }))}
          />
          {statuses.length > 0 && (
            <FilterSelect
              label="Status" value={filters.status} onChange={(v) => onFiltersChange({ status: v })}
              options={statuses.map((s) => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))}
            />
          )}
          <FilterSelect
            label="Stock" value={filters.stock} onChange={(v) => onFiltersChange({ stock: v as CatalogFilters["stock"] })}
            options={[{ value: "in", label: "In stock" }, { value: "out", label: "Sold out" }]}
          />
          {active && (
            <Button variant="link" size="sm" className="h-auto justify-start px-1" onClick={onClear} data-testid="catalog-clear-filters">
              Clear filters
            </Button>
          )}
        </div>
      </div>

      {((onJump && chips.length > 1) || onOpenAll || onCloseAll) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {onJump && chips.length > 1 && (
        <nav className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1" aria-label="Jump to a product type" data-testid="catalog-type-jump">
          <span className="shrink-0 text-xs text-muted-foreground">Jump to</span>
          <div className="-mx-1 flex min-w-0 gap-1.5 overflow-x-auto px-1 pb-1">
            {chips.map((c) => (
              <button
                key={c.value}
                type="button"
                disabled={c.count === 0}
                onClick={() => onJump(c.value)}
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors",
                  "hover:border-primary/60 hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:border-border",
                )}
              >
                {c.label} ({c.count})
              </button>
            ))}
          </div>
        </nav>
        )}
        {(onOpenAll || onCloseAll) && (
          <div className="flex shrink-0 items-center gap-1" data-testid="catalog-open-close">
            {onOpenAll && (
              <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" disabled={groupCount === 0 || openCount >= groupCount} onClick={onOpenAll}>
                Open all
              </Button>
            )}
            {onCloseAll && (
              <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" disabled={openCount === 0} onClick={onCloseAll}>
                Close all
              </Button>
            )}
          </div>
        )}
        </div>
      )}

      <p className="text-xs text-muted-foreground" data-testid="catalog-result-count">
        {active ? `${shown} of ${total} ${noun} match.` : `${total} ${noun}.`}
      </p>
    </div>
  );
}

function FilterSelect({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? "" : v)}>
      <SelectTrigger className="h-9 sm:w-44" aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{`${label}: all`}</SelectItem>
        {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
