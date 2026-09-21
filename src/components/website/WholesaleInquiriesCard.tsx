import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import DataTable, { type DataTableColumn } from "@/components/data-table/DataTable";
import { supabase } from "@/integrations/supabase/client";

/**
 * Read-only feed of wholesale enquiries submitted on the public website.
 * Rows are written by the `website` edge function; nobody edits them here.
 *
 * Moved out of WebsiteCatalog.tsx and put on DataTable while it moved — the
 * same seven columns, now sortable and searchable, because the list only grows
 * and a plain table gave no way to find last month's enquiry. Every cell
 * renders exactly what it rendered before.
 */
const MARKET_LABELS: Record<string, string> = {
  JP: "Japan", PH: "Philippines", BOTH: "Japan & Philippines", OTHER: "Other",
};
const VOLUME_LABELS: Record<string, string> = {
  TEST: "Test order", "20_50": "20–50 pieces", "50_200": "50–200 pieces", "200_PLUS": "200+ pieces",
};

interface WholesaleRow {
  id: string;
  name: string | null;
  business: string | null;
  email: string | null;
  phone: string | null;
  market: string | null;
  volume: string | null;
  notes: string | null;
  lang: string | null;
  created_at: string;
}

/** Received is a PHT calendar date, same as the plain table showed. */
const receivedDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });

export function WholesaleInquiriesCard() {
  const inquiries = useQuery({
    queryKey: ["wholesale-inquiries"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wholesale_inquiries" as any)
        .select("id, name, business, email, phone, market, volume, notes, lang, created_at")
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as WholesaleRow[];
    },
  });

  const rows = useMemo(() => inquiries.data ?? [], [inquiries.data]);

  const columns = useMemo<DataTableColumn<WholesaleRow>[]>(() => [
    {
      key: "created_at",
      header: "Received",
      cell: r => (
        <span className="whitespace-nowrap text-xs text-muted-foreground">{receivedDate(r.created_at)}</span>
      ),
      sortValue: r => r.created_at,
      csvValue: r => receivedDate(r.created_at),
    },
    {
      key: "name",
      header: "Name",
      cell: r => <span className="font-medium text-foreground">{r.name}</span>,
      sortValue: r => r.name ?? "",
      filterValue: r => r.name ?? "",
      csvValue: r => r.name ?? "",
    },
    {
      key: "business",
      header: "Business",
      cell: r => <>{r.business}</>,
      sortValue: r => r.business ?? "",
      filterValue: r => r.business ?? "",
      csvValue: r => r.business ?? "",
    },
    {
      key: "contact",
      header: "Contact",
      cell: r => (
        <div className="text-xs">
          <div>{r.email}</div>
          {r.phone && <div className="text-muted-foreground">{r.phone}</div>}
        </div>
      ),
      sortValue: r => r.email ?? "",
      filterValue: r => [r.email ?? "", r.phone ?? ""].join(" "),
      csvValue: r => [r.email ?? "", r.phone ?? ""].filter(Boolean).join(" / "),
    },
    {
      key: "market",
      header: "Market",
      cell: r => <>{MARKET_LABELS[r.market ?? ""] ?? r.market}</>,
      sortValue: r => MARKET_LABELS[r.market ?? ""] ?? r.market ?? "",
      filterValue: r => MARKET_LABELS[r.market ?? ""] ?? r.market ?? "",
      csvValue: r => MARKET_LABELS[r.market ?? ""] ?? r.market ?? "",
    },
    {
      key: "volume",
      header: "Volume",
      cell: r => <>{VOLUME_LABELS[r.volume ?? ""] ?? r.volume}</>,
      sortValue: r => VOLUME_LABELS[r.volume ?? ""] ?? r.volume ?? "",
      filterValue: r => VOLUME_LABELS[r.volume ?? ""] ?? r.volume ?? "",
      csvValue: r => VOLUME_LABELS[r.volume ?? ""] ?? r.volume ?? "",
    },
    {
      key: "notes",
      header: "Notes",
      cellClassName: "max-w-[22rem] text-xs text-muted-foreground",
      cell: r => (
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="uppercase">{r.lang}</Badge>
          <span className="truncate">{r.notes ?? "—"}</span>
        </div>
      ),
      sortValue: r => r.notes ?? "",
      filterValue: r => [r.lang ?? "", r.notes ?? ""].join(" "),
      csvValue: r => r.notes ?? "",
    },
  ], []);

  return (
    <Card>
      <CardHeader className="hairline-b">
        <CardTitle className="text-base">
          Wholesale inquiries {inquiries.data ? `(${rows.length})` : ""}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Submitted through the wholesale form on chajewelsjp.com. View only.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {inquiries.isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <p className="px-6 py-10 text-sm text-muted-foreground">No inquiries yet.</p>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={r => r.id}
            searchText={r => [r.name ?? "", r.business ?? "", r.email ?? "", r.phone ?? "", r.notes ?? ""]}
            csvName="wholesale-inquiries"
            densityKey="cj-wholesale-inquiries-density"
          />
        )}
      </CardContent>
    </Card>
  );
}
