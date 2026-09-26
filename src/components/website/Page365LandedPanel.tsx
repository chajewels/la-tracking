import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listLandings } from "@/lib/page365-drafts-api";
import { KIND_LABEL, incompleteText, photoText } from "@/lib/page365-drafts";

/**
 * "Landed in Catalog" — read-only (owner decision 2026-09-26, replaces "New in
 * Page365 / Create drafts"). Every new, in-stock Page365 product lands in the
 * Catalog by itself as an UNPUBLISHED product (SQL page365_inventory_land_run
 * at the end of each complete read); this lists the latest ones with what they
 * still need before they can be published, and links to each in the Catalog.
 */
export const LANDINGS_QUERY_KEY = "page365-landings";
const productLink = (id: string) => `/website?tab=catalog&product=${id}`;
export const LANDED_VIEW_LINK = "/website?tab=catalog&view=page365-drafts";

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " PHT";

export function Page365LandedPanel() {
  const q = useQuery({ queryKey: [LANDINGS_QUERY_KEY], queryFn: () => listLandings(50), staleTime: 30_000 });
  const rows = q.data ?? [];

  return (
    <section className="space-y-2" data-testid="p365-inv-landed">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-display text-sm text-card-foreground">Landed in Catalog</h3>
        <p className="w-full text-xs text-muted-foreground sm:w-auto">
          New in-stock Page365 products are added to Catalog by themselves, unpublished. Sold-out ones wait until
          they are back in stock. Nothing appears on the website until you publish it in{" "}
          <Link to={LANDED_VIEW_LINK} className="text-primary underline-offset-2 hover:underline">Catalog</Link>.
        </p>
      </div>
      {q.isLoading ? null : q.data === null ? (
        <p className="text-xs text-muted-foreground">Available after the owner runs this release’s migration.</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="p365-inv-landed-empty">
          Nothing has landed yet. New products land after the next complete fetch.
        </p>
      ) : (
        <div className="max-h-80 overflow-auto rounded-md border border-border">
          <Table className="table-fixed sm:table-auto">
            <TableHeader>
              <TableRow>
                <TableHead className="w-24 sm:w-auto">Code</TableHead>
                <TableHead className="min-w-[12rem]">Name</TableHead>
                <TableHead className="hidden sm:table-cell">Landed</TableHead>
                <TableHead className="hidden sm:table-cell">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(l => {
                const p = l.website_products;
                const flag = incompleteText(l);
                const kind = p?.item_kind ?? l.item_kind ?? "jewelry";
                const status = (
                  <>
                    {!p ? <span className="text-muted-foreground">removed</span>
                      : p.status !== "draft" ? <span className="text-success">{p.status === "active" ? "published" : p.status}</span>
                      : flag ? <span className="text-warning" data-testid="p365-landed-incomplete">{flag}</span>
                      : <span className="text-muted-foreground">ready to publish</span>}
                    <span className="block text-[10px] text-muted-foreground">{photoText(l)}</span>
                  </>
                );
                return (
                  <TableRow key={l.product_id} data-testid="p365-landed-row">
                    <TableCell className="font-medium">
                      <Link to={productLink(l.product_id)} className="text-primary underline-offset-2 hover:underline">
                        {p?.sku ?? l.code}
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-normal text-xs sm:max-w-[22rem]">
                      <span className="line-clamp-2 break-words sm:line-clamp-none sm:block sm:truncate" title={p?.name ?? l.name ?? ""}>{p?.name ?? l.name}</span>
                      {kind !== "jewelry" && (
                        <Badge variant="outline" className="mt-0.5 text-[10px]">{KIND_LABEL[kind] ?? kind}</Badge>
                      )}
                      {/* Phones: the status sits under the name (the Status column is hidden). */}
                      <span className="mt-1 block sm:hidden">{status}</span>
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-xs text-muted-foreground sm:table-cell">{when(l.landed_at)}</TableCell>
                    <TableCell className="hidden text-xs sm:table-cell">{status}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
