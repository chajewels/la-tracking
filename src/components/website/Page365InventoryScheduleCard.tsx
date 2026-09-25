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
  autoApplyRefusal, autoApplyText, runSourceLabel, runStatusText, type InventoryRun,
} from "@/lib/page365-inventory";
import { getAutoApply, runsTable, setAutoApply, type AutoApplyState } from "@/lib/page365-inventory-api";

/**
 * Website → Page365 stock → "Automatic decreases every 30 minutes" (PR 3).
 *
 * A pg_cron job reads the whole Page365 catalogue every 30 minutes whatever
 * this switch says; the switch only decides whether that scheduled read then
 * APPLIES ITS DECREASES by itself (page365_inventory_auto_apply_run). Increases,
 * new products, prices and photos never apply automatically — they wait on
 * the review below. Default OFF.
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
      const { data, error } = await runsTable()
        .select("id, source, status, error, page365_count, products_total, created_at, finished_at, auto_apply_state, auto_applied, auto_apply_changed, auto_apply_at")
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
        ? "Automatic decreases are ON. The next scheduled fetch applies Page365 decreases by itself."
        : "Automatic decreases are OFF. Scheduled fetches still run; nothing is applied without staff.");
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
          Automatic decreases every 30 minutes
          {data && (
            <Badge variant={data.enabled ? "default" : "secondary"} data-testid="p365-auto-apply-state">
              {data.enabled ? "On" : "Off"}
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Page365 is read every 30 minutes either way. When this is on, pieces Page365 has fewer of are reduced on the
          website by themselves — the same rule as the review below (Page365 minus website and unpaid-invoice holds,
          only if stock is unchanged since the read, never for products switched to “Don’t sync with Page365”, and never
          from an incomplete read). Increases, new products, prices and photos always wait for you.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 pt-5 text-sm">
        {state.isLoading && (
          <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        )}
        {state.isError && (
          <p className="text-muted-foreground" data-testid="p365-auto-apply-unavailable">
            Automatic decreases are not available yet. They appear once the schedule migration has been run.
          </p>
        )}
        {data && (
          <div className="flex flex-wrap items-center gap-3">
            <Switch
              id="p365-auto-apply"
              checked={data.enabled}
              disabled={save.isPending || !data.can_change}
              onCheckedChange={next => setPending(next)}
              aria-label="Automatic decreases every 30 minutes"
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
                Last scheduled fetch {formatPHTDisplay(lastScheduled.created_at)} ·{" "}
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
                  <TableHead>Read</TableHead>
                  <TableHead className="min-w-[12rem]">Automatic decreases</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map(r => (
                  <TableRow key={r.id} data-testid="p365-run-history-row">
                    <TableCell className="whitespace-nowrap text-xs">{formatPHTDisplay(r.created_at)}</TableCell>
                    <TableCell className="text-xs">
                      <Badge variant="outline" className="text-[10px]">{runSourceLabel(r)}</Badge>
                    </TableCell>
                    <TableCell className={`text-xs ${statusTone(r.status)}`} title={r.error ?? ""}>
                      {r.status === "ready" ? "Complete" : r.status === "fetching" ? "Reading…" : r.status === "partial" ? "Incomplete" : "Failed"}
                    </TableCell>
                    <TableCell className="text-xs">{autoApplyText(r)}</TableCell>
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
            <AlertDialogTitle>Turn automatic decreases {pending ? "ON" : "OFF"}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {pending
                    ? "Every 30 minutes, website stock goes DOWN by itself wherever Page365 has fewer. Nothing ever goes up by itself."
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
