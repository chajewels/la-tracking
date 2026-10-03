import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, Loader2 } from "lucide-react";
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
  SQUARE_KEY, SQUARE_MODE_LABEL, type SquareMode, type SquareSettingsState,
  squareAgreementLabel, squareAppIdProblem, squareEffect, squareLocationIdProblem, squareRefusal,
} from "@/components/settings/square-settings";

/**
 * Website → Settings → Card payments (Square) (S1, 2026-10-04, docs/SQUARE.md):
 * the "Pay by card" switch (system_settings.square_mode), the PUBLIC
 * Application ID and Location ID the website hands to Square's Web Payments
 * SDK, and the Card Purchase Agreement threshold (0 = every card payment,
 * owner decision 2026-10-03). Off → Test (only customers flagged is_test see
 * it, against the sandbox) → On (every customer, production).
 *
 * The ACCESS TOKEN and the webhook SIGNATURE KEY are never here: they are
 * edge-function secrets. The setter refuses anything that is not an
 * Application ID, and an id family that does not match the mode. Admin only;
 * set_square_settings re-checks the role and writes the audit row. Neither
 * RPC is in the generated types yet. Twin of PaidySettingsCard.
 */

async function callRpc(name: string, args?: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase.rpc(name as any, args as any);
  if (error) throw error;
  const out = (data ?? {}) as Record<string, unknown>;
  if (typeof out.error === "string") throw Object.assign(new Error(out.error), { code: out.error });
  return out;
}

const MODES: SquareMode[] = ["off", "test", "on"];

export function SquareSettingsCard() {
  const qc = useQueryClient();
  const { roles } = useAuth();
  const isAdmin = !!roles?.includes("admin");
  const [pending, setPending] = useState<SquareMode | null>(null);
  const [appId, setAppId] = useState("");
  const [locId, setLocId] = useState("");
  const [minJpy, setMinJpy] = useState("0");

  const state = useQuery<SquareSettingsState>({
    queryKey: SQUARE_KEY,
    queryFn: async () => (await callRpc("get_square_settings")) as unknown as SquareSettingsState,
    staleTime: 30_000,
  });
  const data = state.data;

  useEffect(() => {
    if (data) {
      setAppId(data.app_id ?? "");
      setLocId(data.location_id ?? "");
      setMinJpy(String(Math.round(Number(data.agreement_min_jpy ?? 0))));
    }
  }, [data]);

  const save = useMutation({
    mutationFn: (v: { mode: SquareMode; app?: string | null; loc?: string | null; min?: number | null }) =>
      callRpc("set_square_settings", {
        p_mode: v.mode,
        p_app_id: v.app ?? null,
        p_location_id: v.loc ?? null,
        p_agreement_min_jpy: v.min ?? null,
        p_expected_mode: data?.mode ?? null,
      }),
    onSuccess: (out) => {
      toast({
        title: out.changed ? `Card payments: ${SQUARE_MODE_LABEL[out.mode as SquareMode] ?? out.mode}` : "Nothing changed",
        description: squareEffect(out.mode as SquareMode),
      });
    },
    onError: (e: Error & { code?: string }) => {
      toast({ title: "Not changed", description: squareRefusal(e.code ?? e.message), variant: "destructive" });
    },
    onSettled: () => {
      setPending(null);
      qc.invalidateQueries({ queryKey: SQUARE_KEY });
    },
  });

  const canChange = isAdmin && data?.can_change !== false;
  const appTrim = appId.trim();
  const locTrim = locId.trim();
  const appProblem = squareAppIdProblem(appTrim);
  const locProblem = squareLocationIdProblem(locTrim);
  const minNum = Number(minJpy);
  const minProblem = !Number.isInteger(minNum) || minNum < 0 ? "A whole yen amount, 0 or more." : null;
  const idsDirty = !!data && (appTrim !== (data.app_id ?? "") || locTrim !== (data.location_id ?? ""));
  const minDirty = !!data && minNum !== Math.round(Number(data.agreement_min_jpy ?? 0));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <CreditCard className="h-4 w-4 text-primary" />
          Card payments (Square)
          {data && (
            <Badge variant={data.mode === "on" ? "default" : "secondary"} data-testid="square-state">
              {SQUARE_MODE_LABEL[data.mode]}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          "Pay by card" on the website's confirmed order page, for yen orders (Visa, Mastercard, Amex, JCB, Diners,
          Discover; 3-D Secure always). The customer's card is authorised; the money is taken only when a reviewer clicks
          Confirm on Payment Submissions. Reject voids the hold — nothing is charged. Never on layaway.
        </p>
        {state.isLoading && (
          <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        )}
        {state.isError && (
          <p className="text-destructive" data-testid="square-read-error">
            {data ? "Could not refresh — showing the last state read." : `Could not read the setting: ${(state.error as Error)?.message ?? "unknown"}`}
          </p>
        )}
        {data && (
          <>
            <p className="font-medium" data-testid="square-effect">{squareEffect(data.mode)}</p>
            <p className="text-xs text-muted-foreground" data-testid="square-changed">
              {data.updated_by_user_id
                ? <>Last changed {data.updated_at ? formatPHTDisplay(data.updated_at) : ""} by {data.updated_by_name ?? "an unknown user"}.</>
                : <>Not changed from the Hub yet.</>}
              {" "}{data.authorized_now} awaiting Confirm · {data.captured_30d} captured in the last 30 days
              {data.disputes_open > 0 ? <> · <span className="text-destructive font-medium">{data.disputes_open} dispute(s) open</span></> : null}.
            </p>
            <p className="text-xs" data-testid="square-agreement">{squareAgreementLabel(Number(data.agreement_min_jpy ?? 0))}</p>

            {canChange ? (
              <div className="space-y-4 pt-1">
                <RadioGroup
                  value={data.mode}
                  onValueChange={(v) => { if (v !== data.mode) setPending(v as SquareMode); }}
                  className="gap-2"
                  aria-label="Card payments mode"
                >
                  {MODES.map((m) => (
                    <div key={m} className="flex items-center gap-3">
                      <RadioGroupItem value={m} id={`square-${m}`} disabled={save.isPending} />
                      <Label htmlFor={`square-${m}`}>{SQUARE_MODE_LABEL[m]}</Label>
                    </div>
                  ))}
                </RadioGroup>

                <div className="space-y-1.5">
                  <Label htmlFor="square-app-id" className="text-xs">
                    Application ID (sandbox-sq0idb-… for Test, sq0idp-… for On). The access token is NEVER entered here.
                  </Label>
                  <Input id="square-app-id" value={appId} onChange={(e) => setAppId(e.target.value)}
                    className="max-w-md font-mono text-xs" autoComplete="off" spellCheck={false} />
                  {appProblem && <p className="text-xs text-destructive" data-testid="square-app-error">{appProblem}</p>}
                  <Label htmlFor="square-location-id" className="text-xs">Location ID (the Cha Jewels Japan / JPY location)</Label>
                  <Input id="square-location-id" value={locId} onChange={(e) => setLocId(e.target.value)}
                    className="max-w-md font-mono text-xs" autoComplete="off" spellCheck={false} />
                  {locProblem && <p className="text-xs text-destructive" data-testid="square-loc-error">{locProblem}</p>}
                  <Button size="sm" variant="outline"
                    disabled={!idsDirty || !!appProblem || !!locProblem || save.isPending}
                    onClick={() => save.mutate({ mode: data.mode, app: appTrim, loc: locTrim })}>
                    Save ids
                  </Button>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="square-agreement-min" className="text-xs">
                    Card Purchase Agreement required from (¥). 0 = every card payment.
                  </Label>
                  <Input id="square-agreement-min" value={minJpy} onChange={(e) => setMinJpy(e.target.value)}
                    className="max-w-[12rem] font-mono text-xs" inputMode="numeric" />
                  {minProblem && <p className="text-xs text-destructive">{minProblem}</p>}
                  <Button size="sm" variant="outline"
                    disabled={!minDirty || !!minProblem || save.isPending}
                    onClick={() => save.mutate({ mode: data.mode, min: minNum })}>
                    Save threshold
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="square-readonly">
                Application ID: {data.app_id ? `${data.app_id.slice(0, 14)}…` : "none"} · Location: {data.location_id || "none"}. Only an admin can change this.
              </p>
            )}
          </>
        )}
      </CardContent>

      <AlertDialog open={pending !== null} onOpenChange={(o) => { if (!o && !save.isPending) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Card payments: {pending ? SQUARE_MODE_LABEL[pending] : ""}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>{pending ? squareEffect(pending) : ""}</p>
                {pending === "on" && (
                  <p className="font-medium text-foreground">
                    Every customer will see "Pay by card" on a confirmed yen order. The saved ids must be the PRODUCTION
                    Application ID and Location ID, and the Lovable secrets the production access token and webhook
                    signature key.
                  </p>
                )}
                <p className="text-xs">Takes effect on the next order page load. No deploy is needed.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={save.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={save.isPending}
              onClick={(e) => { e.preventDefault(); if (pending) save.mutate({ mode: pending, app: idsDirty ? appTrim : null, loc: idsDirty ? locTrim : null }); }}>
              {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {pending ? `Switch to ${SQUARE_MODE_LABEL[pending]}` : ""}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
