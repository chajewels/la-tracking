import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Truck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/hooks/use-toast";
import { formatPHTDisplay } from "@/lib/date-utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  COD_KEY, COD_MODE_LABEL, type CodBracketRow, type CodMode, type CodSettingsState,
  codEffect, codRefusal, parseCodTable,
} from "@/components/settings/cod-settings";

/**
 * Website → Settings → Cash on delivery (代金引換, owner plan 2026-10-10;
 * docs/COD.md): the switch (system_settings.cod_mode, fail-closed, seeded Off)
 * and the fee table (cod_fee_table: amount collected up to and including
 * "up to" → fee). The top "up to" is the COD limit; the fee itself is not
 * counted in it. Admin only; set_cod_settings re-checks the role and writes the
 * audit row. Neither RPC is in the generated types yet.
 */

async function callRpc(name: string, args?: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase.rpc(name as any, args as any);
  if (error) throw error;
  const out = (data ?? {}) as Record<string, unknown>;
  if (typeof out.error === "string") throw Object.assign(new Error(out.error), { code: out.error });
  return out;
}

const MODES: CodMode[] = ["off", "on"];
const yen = (n: number) => `¥${n.toLocaleString("en-US")}`;

export function CodSettingsCard() {
  const qc = useQueryClient();
  const { roles } = useAuth();
  const isAdmin = !!roles?.includes("admin");
  const [pending, setPending] = useState<CodMode | null>(null);
  const [rows, setRows] = useState<{ max: string; fee: string }[]>([]);

  const state = useQuery<CodSettingsState>({
    queryKey: COD_KEY,
    queryFn: async () => (await callRpc("get_cod_settings")) as unknown as CodSettingsState,
    staleTime: 30_000,
  });
  const data = state.data;

  useEffect(() => {
    if (data?.fee_table) setRows(data.fee_table.map((r) => ({ max: String(r.max_jpy), fee: String(r.fee_jpy) })));
  }, [data]);

  const save = useMutation({
    mutationFn: (v: { mode: CodMode; table: CodBracketRow[] | null }) =>
      callRpc("set_cod_settings", { p_mode: v.mode, p_fee_table: v.table, p_expected_mode: data?.mode ?? null }),
    onSuccess: (out) => {
      toast({
        title: out.changed ? `Cash on delivery: ${COD_MODE_LABEL[out.mode as CodMode] ?? out.mode}` : "Nothing changed",
        description: codEffect(out.mode as CodMode),
      });
    },
    onError: (e: Error & { code?: string }) => {
      toast({ title: "Not changed", description: codRefusal(e.code ?? e.message), variant: "destructive" });
    },
    onSettled: () => {
      setPending(null);
      qc.invalidateQueries({ queryKey: COD_KEY });
    },
  });

  const canChange = isAdmin && data?.can_change !== false;
  const parsed = parseCodTable(rows);
  const tableProblem = "problem" in parsed ? parsed.problem : null;
  const tableDirty = !!data?.fee_table && JSON.stringify("rows" in parsed ? parsed.rows : rows) !== JSON.stringify(data.fee_table);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Truck className="h-4 w-4 text-primary" />
          Cash on delivery (代金引換)
          {data && (
            <Badge variant={data.mode === "on" ? "default" : "secondary"} data-testid="cod-state">
              {COD_MODE_LABEL[data.mode]}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Yen, full-payment website orders delivered in Japan. Staff confirm and ship at once; when the courier
          remits, record the FULL amount collected (pieces + shipping + the fee) with the remittance statement as
          proof. No payment deadline, no reminder, no automatic cancel. A refused parcel is a staff cancel (the stock returns).
          The fee is its own line, never in the loyalty amount, and points never pay it.
        </p>
        {state.isLoading && (
          <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        )}
        {state.isError && (
          <p className="text-destructive" data-testid="cod-read-error">
            {data ? "Could not refresh — showing the last state read." : `Could not read the setting: ${codRefusal(((state.error as Error & { code?: string })?.code) ?? (state.error as Error)?.message ?? "unknown")}`}
          </p>
        )}
        {data && (
          <>
            <p className="font-medium" data-testid="cod-effect">{codEffect(data.mode)}</p>
            <p className="text-xs text-muted-foreground" data-testid="cod-changed">
              {data.updated_by_user_id
                ? <>Last changed {data.updated_at ? formatPHTDisplay(data.updated_at) : ""} by {data.updated_by_name ?? "an unknown user"}.</>
                : <>Not changed from the Hub yet.</>}
              {" "}{data.open_cod_drafts} website order{data.open_cod_drafts === 1 ? "" : "s"} to confirm and {data.open_cod_orders} open order{data.open_cod_orders === 1 ? "" : "s"} on cash on delivery.
            </p>
            {data.limit_jpy !== null && (
              <p className="text-xs text-muted-foreground" data-testid="cod-limit">
                Offered while the amount collected is up to {yen(data.limit_jpy)} (the fee not counted).
              </p>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs">Fee by amount collected (up to and including)</Label>
              <table className="text-xs" data-testid="cod-fee-table">
                <thead>
                  <tr className="text-muted-foreground"><th className="pr-3 text-left font-normal">Up to (¥)</th><th className="text-left font-normal">Fee (¥)</th>{canChange && <th />}</tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td className="pr-3 py-0.5">
                        {canChange
                          ? <Input aria-label={`Up to, row ${i + 1}`} value={r.max} inputMode="numeric" className="h-8 w-28 tabular-nums"
                              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, max: e.target.value } : x)))} />
                          : <span className="tabular-nums">{yen(Number(r.max))}</span>}
                      </td>
                      <td className="py-0.5">
                        {canChange
                          ? <Input aria-label={`Fee, row ${i + 1}`} value={r.fee} inputMode="numeric" className="h-8 w-24 tabular-nums"
                              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, fee: e.target.value } : x)))} />
                          : <span className="tabular-nums">{yen(Number(r.fee))}</span>}
                      </td>
                      {canChange && (
                        <td className="pl-2">
                          <Button size="sm" variant="ghost" disabled={rows.length <= 1} onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              {canChange && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={rows.length >= 10} onClick={() => setRows([...rows, { max: "", fee: "" }])}>Add row</Button>
                  <Button size="sm" variant="outline" data-testid="cod-save-table"
                    disabled={!tableDirty || !!tableProblem || save.isPending}
                    onClick={() => { if ("rows" in parsed) save.mutate({ mode: data.mode, table: parsed.rows }); }}>
                    Save fee table
                  </Button>
                </div>
              )}
              {canChange && tableProblem && <p className="text-xs text-destructive" data-testid="cod-table-error">{tableProblem}</p>}
            </div>

            {canChange ? (
              <RadioGroup
                value={data.mode}
                onValueChange={(v) => { if (v !== data.mode) setPending(v as CodMode); }}
                className="gap-2 pt-1"
                aria-label="Cash on delivery"
              >
                {MODES.map((m) => (
                  <div key={m} className="flex items-center gap-3">
                    <RadioGroupItem value={m} id={`cod-${m}`} disabled={save.isPending} />
                    <Label htmlFor={`cod-${m}`}>{COD_MODE_LABEL[m]}</Label>
                  </div>
                ))}
              </RadioGroup>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="cod-readonly">Only an admin can change this.</p>
            )}
          </>
        )}
      </CardContent>

      <AlertDialog open={pending !== null} onOpenChange={(o) => { if (!o && !save.isPending) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cash on delivery: {pending ? COD_MODE_LABEL[pending] : ""}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>{pending ? codEffect(pending) : ""}</p>
                <p className="text-xs">Takes effect on the next checkout. No deploy is needed.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={save.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={save.isPending}
              onClick={(e) => { e.preventDefault(); if (pending) save.mutate({ mode: pending, table: null }); }}
            >
              {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {pending ? `Switch ${COD_MODE_LABEL[pending]}` : ""}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
