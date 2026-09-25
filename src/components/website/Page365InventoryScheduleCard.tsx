import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatPHTDisplay } from "@/lib/date-utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  NIGHTLY_FULL_TEXT, autoApplyRefusal, autoApplyText, runDuration, runKindLabel, runSourceLabel, runStatusText,
  type InventoryRun,
} from "@/lib/page365-inventory";
import { getAutoApply, runsTable, setAutoApply, type AutoApplyState } from "@/lib/page365-inventory-api";

/**
 * Website → Page365 stock → "Automatic updates every 30 minutes (decreases,
 * increases, hiding)" (PR 3; PR 3b hiding; PR 3c increases + quick reads).
 *
 * A pg_cron job reads Page365 every 30 minutes whatever this switch says —
 * QUICK reads (the catalogue list plus the pages of Hub products), and one
 * FULL read a night at 02:00 PHT (03:00 JST). The switch only decides whether
 * a scheduled read then APPLIES its stock changes by itself
 * (page365_inventory_auto_apply_run): decreases and increases (owner decision
 * 2026-09-26 — staff confirm every website sale in Page365, so Page365 is the
 * full truth), and hides of products Page365 stopped listing (missing from 2
 * complete reads in a row: stock 0 + unpublished). New products, prices,
 * photos and re-publishing never apply automatically. Default OFF.
 *
 * The switch is system_settings.page365_inventory_auto_apply, written ONLY by
 * set_page365_inventory_auto_apply (manage_website_catalog, audited); a guard
 * trigger refuses every other write. The whole Page365 stock tab is already
 * manage_website_catalog, so everyone who sees this card may change it.
 */

const AUTO_APPLY_KEY = ["page365-inventory-auto-apply"] as const;
const HISTORY_KEY = ["page365-inventory-run-history"] as const;

function statusTone(status: InventoryRun["status"]) {
  if (status === "ready") return "text-success";
  if (status === "fetching") return "text-muted-foreground";
  return "text-warning";
}

export function Page365InventoryScheduleCard() {
  const qc = useQueryClient();
  const [pending, setPending] = useState<boolean | null>(null);

  const state = useQuery<AutoApplyState>({ queryKey: AUTO_APPLY_KEY, queryFn: getAutoApply, staleTime: 30_000 });

  const history = useQuery({
    queryKey: HISTORY_KEY,
    queryFn: async () => {
      // "*": hidden_count (PR 3b) is read once its migration has run and is
      // simply absent before it — a column list would fail the whole query.
      const { data, error } = await runsTable()
        .select("*")
        .order("created_at", { ascending: false }).limit(10);
      if (error) throw error;
      return (data ?? []) as InventoryRun[];
    },
    refetchInterval: 60_000,
  });

  const save = useMutation({
    mutationFn: (next: boolean) => setAutoApply(next, state.data?.enabled ?? null),
    onSuccess: out => {
      toast.success(out.enabled
        ? "Automatic updates are ON. The next scheduled fetch applies Page365 decreases and increases by itself."
        : "Automatic updates are OFF. Scheduled fetches still run; nothing is applied without staff.");
    },
    onError: (e: Error & { code?: string }) => toast.error(autoApplyRefusal(e.code ?? e.message)),
    onSettled: () => {
      setPending(null);
      qc.invalidateQueries({ queryKey: AUTO_APPLY_KEY });
    },
  });

  const data = state.data;
  const runs = history.data ?? [];
  const lastScheduled = runs.find(r => r.source === "schedule") ?? null;

  return (
    <Card>
      <CardHeader className="hairline-b">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Clock className="h-4 w-4 text-primary" />
          Automatic updates every 30 minutes (decreases, increases, hiding)
          {data && (
            <Badge variant={data.enabled ? "default" : "secondary"} data-testid="p365-auto-apply-state">
              {data.enabled ? "On" : "Off"}
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Page365 is read every 30 minutes either way — a quick read (the catalogue list plus your Hub products’ pages),
          and a full read of every page once a night at {NIGHTLY_FULL_TEXT}. When this is on, website stock follows
          Page365 by itself, down and up — the same rule as the review below (Page365 minus website and unpaid-invoice
          holds, only if stock is unchanged since the read, never for products switched to “Don’t sync with Page365”,
          and never from an incomplete read). It also hides a product Page365 stopped listing — missing from 2 complete
          reads in a row after being on Page365 — by setting its website stock to 0 and unpublishing it. Re-publishing,
          new products, prices and photos always wait for you.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 pt-5 text-sm">
        {state.isLoading && (
          <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        )}
        {state.isError && (
          <p className="text-muted-foreground" data-testid="p365-auto-apply-unavailable">
            Automatic updates are not available yet. They appear once the schedule migration has been run.
          </p>
        )}
        {data && (
          <div className="flex flex-wrap items-center gap-3">
            <Switch
              id="p365-auto-apply"
              checked={data.enabled}
              disabled={save.isPending || !data.can_change}
              onCheckedChange={next => setPending(next)}
              aria-label="Automatic updates every 30 minutes"
            />
            <Label htmlFor="p365-auto-apply">{data.enabled ? "On" : "Off"}</Label>
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            <span className="text-xs text-muted-foreground" data-testid="p365-auto-apply-changed">
              {data.updated_by_user_id
                ? <>Last changed {data.updated_at ? formatPHTDisplay(data.updated_at) : ""} by {data.updated_by_name ?? "an unknown user"}.</>
                : <>Not changed from the Hub yet.</>}
            </span>
          </div>
        )}

        {!history.isError && (
          <p className="text-xs text-muted-foreground" data-testid="p365-last-scheduled">
            {lastScheduled ? (
              <>
                Last scheduled fetch {formatPHTDisplay(lastScheduled.created_at)} ({runKindLabel(lastScheduled).toLowerCase()}) ·{" "}
                <span className={statusTone(lastScheduled.status)}>{runStatusText(lastScheduled)}</span> ·{" "}
                {autoApplyText(lastScheduled)}
              </>
            ) : (
              "No scheduled fetch yet. The first one runs within 30 minutes of the schedule migration being applied."
            )}
          </p>
        )}

        {runs.length > 0 && (
          <div className="max-h-72 overflow-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">Started</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-right">Took</TableHead>
                  <TableHead>Read</TableHead>
                  <TableHead className="min-w-[12rem]">Automatic updates</TableHead>
                  <TableHead className="text-right">Hidden</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map(r => (
                  <TableRow key={r.id} data-testid="p365-run-history-row">
                    <TableCell className="whitespace-nowrap text-xs">{formatPHTDisplay(r.created_at)}</TableCell>
                    <TableCell className="text-xs">
                      <Badge variant="outline" className="text-[10px]">{runSourceLabel(r)}</Badge>
                    </TableCell>
                    <TableCell className="text-xs" data-testid="p365-run-kind">
                      <Badge variant={r.kind === "quick" ? "secondary" : "outline"} className="text-[10px]">{runKindLabel(r)}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right text-xs tabular-nums" data-testid="p365-run-duration">
                      {runDuration(r)}
                    </TableCell>
                    <TableCell className={`text-xs ${statusTone(r.status)}`} title={r.error ?? ""}>
                      {r.status === "ready" ? "Complete" : r.status === "fetching" ? "Reading…" : r.status === "partial" ? "Incomplete" : "Failed"}
                    </TableCell>
                    <TableCell className="text-xs">{autoApplyText(r)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums" data-testid="p365-run-hidden">
                      {r.hidden_count ? r.hidden_count : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <AlertDialog open={pending !== null} onOpenChange={o => { if (!o && !save.isPending) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn automatic updates {pending ? "ON" : "OFF"}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {pending
                    ? "Every 30 minutes, website stock follows Page365 by itself — DOWN where Page365 has fewer, UP where it has more — and a product Page365 stopped listing (2 complete reads in a row) is hidden. Nothing is ever re-published or created by itself."
                    : "Scheduled fetches keep running and stay in the history below, but nothing is applied without a staff tick."}
                </p>
                <p className="text-xs">The change is recorded in the audit log with your name.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={save.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={save.isPending}
              onClick={e => { e.preventDefault(); if (pending !== null) save.mutate(pending); }}
            >
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Turn {pending ? "on" : "off"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
