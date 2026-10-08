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
  PAIDY_KEY, PAIDY_MODE_LABEL, type PaidyMode, type PaidySettingsState,
  paidyEffect, paidyPublicKeyProblem, paidyRefusal,
} from "@/components/settings/paidy-settings";

/**
 * Website → Settings → Paidy (2026-10-03, docs/PAIDY.md): the
 * 『あと払い（ペイディ）』 switch (system_settings.paidy_mode) and the PUBLIC key
 * the website hands to Paidy Checkout (paidy_public_key). Off → Test (only
 * customers flagged is_test see it, with the pk_test_ key) → On (every
 * customer with a Japanese delivery address, pk_live_ key).
 *
 * The SECRET key is never here: it is the PAIDY_SECRET_KEY edge-function
 * secret. The setter refuses a key that is not a public key, and a key family
 * that does not match the mode. Admin only; set_paidy_settings re-checks the
 * role and writes the audit row. Neither RPC is in the generated types yet.
 */

async function callRpc(name: string, args?: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase.rpc(name as any, args as any);
  if (error) throw error;
  const out = (data ?? {}) as Record<string, unknown>;
  if (typeof out.error === "string") throw Object.assign(new Error(out.error), { code: out.error });
  return out;
}

const MODES: PaidyMode[] = ["off", "test", "on"];

export function PaidySettingsCard() {
  const qc = useQueryClient();
  const { roles } = useAuth();
  const isAdmin = !!roles?.includes("admin");
  const [pending, setPending] = useState<PaidyMode | null>(null);
  const [keyText, setKeyText] = useState("");

  const state = useQuery<PaidySettingsState>({
    queryKey: PAIDY_KEY,
    queryFn: async () => (await callRpc("get_paidy_settings")) as unknown as PaidySettingsState,
    staleTime: 30_000,
  });
  const data = state.data;

  useEffect(() => { if (data) setKeyText(data.public_key ?? ""); }, [data]);

  const save = useMutation({
    mutationFn: (v: { mode: PaidyMode; key: string | null }) =>
      callRpc("set_paidy_settings", { p_mode: v.mode, p_public_key: v.key, p_expected_mode: data?.mode ?? null }),
    onSuccess: (out) => {
      toast({
        title: out.changed ? `Paidy: ${PAIDY_MODE_LABEL[out.mode as PaidyMode] ?? out.mode}` : "Nothing changed",
        description: paidyEffect(out.mode as PaidyMode),
      });
    },
    onError: (e: Error & { code?: string }) => {
      toast({ title: "Not changed", description: paidyRefusal(e.code ?? e.message), variant: "destructive" });
    },
    onSettled: () => {
      setPending(null);
      qc.invalidateQueries({ queryKey: PAIDY_KEY });
    },
  });

  const canChange = isAdmin && data?.can_change !== false;
  const keyTrim = keyText.trim();
  const keyProblem = paidyPublicKeyProblem(keyTrim);
  const keyDirty = !!data && keyTrim !== (data.public_key ?? "");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <CreditCard className="h-4 w-4 text-primary" />
          Paidy あと払い
          {data && (
            <Badge variant={data.mode === "on" ? "default" : "secondary"} data-testid="paidy-state">
              {PAIDY_MODE_LABEL[data.mode]}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          『あと払い（ペイディ）』 on the website's confirmed order page, for yen orders with a Japanese delivery address, once the buyer's own details are complete (family and given name, a Japanese mobile, a Japanese billing address — the order page asks her for them).
          The customer authorises in Paidy's window; the money is taken only when a reviewer clicks Confirm on
          Payment Submissions (valid 30 days). Reject releases it.
        </p>
        {state.isLoading && (
          <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        )}
        {state.isError && (
          <p className="text-destructive" data-testid="paidy-read-error">
            {data ? "Could not refresh — showing the last state read." : `Could not read the setting: ${(state.error as Error)?.message ?? "unknown"}`}
          </p>
        )}
        {data && (
          <>
            <p className="font-medium" data-testid="paidy-effect">{paidyEffect(data.mode)}</p>
            <p className="text-xs text-muted-foreground" data-testid="paidy-changed">
              {data.updated_by_user_id
                ? <>Last changed {data.updated_at ? formatPHTDisplay(data.updated_at) : ""} by {data.updated_by_name ?? "an unknown user"}.</>
                : <>Not changed from the Hub yet.</>}
              {" "}{data.authorized_now} awaiting Confirm · {data.captured_30d} captured in the last 30 days.
            </p>

            {canChange ? (
              <div className="space-y-4 pt-1">
                <RadioGroup
                  value={data.mode}
                  onValueChange={(v) => { if (v !== data.mode) setPending(v as PaidyMode); }}
                  className="gap-2"
                  aria-label="Paidy mode"
                >
                  {MODES.map((m) => (
                    <div key={m} className="flex items-center gap-3">
                      <RadioGroupItem value={m} id={`paidy-${m}`} disabled={save.isPending} />
                      <Label htmlFor={`paidy-${m}`}>{PAIDY_MODE_LABEL[m]}</Label>
                    </div>
                  ))}
                </RadioGroup>

                <div className="space-y-1.5">
                  <Label htmlFor="paidy-public-key" className="text-xs">
                    Public key (pk_test_… for Test, pk_live_… for On). The secret key is NEVER entered here.
                  </Label>
                  <Input
                    id="paidy-public-key"
                    value={keyText}
                    onChange={(e) => setKeyText(e.target.value)}
                    className="max-w-md font-mono text-xs"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {keyProblem && (
                    <p className="text-xs text-destructive" data-testid="paidy-key-error">{keyProblem}</p>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!keyDirty || !!keyProblem || save.isPending}
                    onClick={() => save.mutate({ mode: data.mode, key: keyTrim })}
                  >
                    Save public key
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="paidy-readonly">
                Public key: {data.public_key ? `${data.public_key.slice(0, 11)}…` : "none"}. Only an admin can change this.
              </p>
            )}
          </>
        )}
      </CardContent>

      <AlertDialog open={pending !== null} onOpenChange={(o) => { if (!o && !save.isPending) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Paidy: {pending ? PAIDY_MODE_LABEL[pending] : ""}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>{pending ? paidyEffect(pending) : ""}</p>
                {pending === "on" && (
                  <p className="font-medium text-foreground">
                    Every customer with a Japanese delivery address will see 『あと払い（ペイディ）』 on a confirmed yen
                    order. The saved key must be the live pk_live_ key and the Lovable secret the live sk_live_ key.
                  </p>
                )}
                <p className="text-xs">Takes effect on the next order page load. No deploy is needed.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={save.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={save.isPending}
              onClick={(e) => { e.preventDefault(); if (pending) save.mutate({ mode: pending, key: keyDirty ? keyTrim : null }); }}
            >
              {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {pending ? `Switch to ${PAIDY_MODE_LABEL[pending]}` : ""}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
