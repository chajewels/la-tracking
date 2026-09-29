import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/hooks/use-toast";
import { formatPHTDisplay } from "@/lib/date-utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  CHECKOUT_MODE_KEY, CHECKOUT_MODE_LABEL, type CheckoutMode, type CheckoutModeState,
  checkoutModeEffect, checkoutModeReadError, checkoutModeRefusal, draftsWaitingLine,
} from "@/components/website/checkout-mode";

/**
 * Website → Settings → "Website orders (staff confirm first)" — website-orders
 * PR 8: the switch system_settings.web_checkout_mode (docs/WEB-ORDER-DRAFTS.md).
 *
 * Visible to the Settings tab's own gate (manage_website_content); the read RPC
 * also admits confirm_web_order_ready. Changing it is ADMIN ONLY:
 * set_web_checkout_mode re-checks the admin ROLE server-side (no override can
 * grant it), writes the audit row, and a guard trigger refuses every other
 * write to the key. Never set it in SQL or a migration.
 */

async function callRpc(name: string, args?: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase.rpc(name as any, args as any);
  if (error) throw error;
  const out = (data ?? {}) as Record<string, unknown>;
  if (typeof out.error === "string") throw Object.assign(new Error(out.error), { code: out.error });
  return out;
}

export function CheckoutModeCard() {
  const qc = useQueryClient();
  const { roles } = useAuth();
  const isAdmin = !!roles?.includes("admin");
  const [pending, setPending] = useState<CheckoutMode | null>(null);

  const state = useQuery<CheckoutModeState>({
    queryKey: CHECKOUT_MODE_KEY,
    queryFn: async () => (await callRpc("get_web_checkout_mode")) as unknown as CheckoutModeState,
    staleTime: 30_000,
  });
  const data = state.data;

  const save = useMutation({
    mutationFn: (next: CheckoutMode) =>
      callRpc("set_web_checkout_mode", { p_mode: next, p_expected: data?.mode ?? null }),
    onSuccess: (out) => {
      const mode = (out.mode === "draft" ? "draft" : "order") as CheckoutMode;
      toast({
        title: out.changed ? `Website orders: ${mode === "draft" ? "staff confirm first" : "created at checkout"}` : "Nothing changed",
        description: checkoutModeEffect(mode),
      });
    },
    onError: (e: Error & { code?: string }) => {
      toast({ title: "Not changed", description: checkoutModeRefusal(e.code ?? e.message), variant: "destructive" });
    },
    onSettled: () => {
      setPending(null);
      qc.invalidateQueries({ queryKey: CHECKOUT_MODE_KEY });
      qc.invalidateQueries({ queryKey: ["web-drafts"] });
    },
  });

  const canToggle = isAdmin && data?.can_change !== false;
  const on = data?.mode === "draft";

  const openConfirm = (next: CheckoutMode) => {
    setPending(next);
    state.refetch(); // the waiting count in the dialog must be current
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <ClipboardCheck className="h-4 w-4 text-primary" />
          Website orders (staff confirm first)
          {data && (
            <Badge variant={on ? "default" : "secondary"} data-testid="checkout-mode-state">
              {on ? "On" : "Off"}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {state.isLoading && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {state.isError && (
          <p className="text-destructive" data-testid="checkout-mode-read-error">
            {data
              ? "Could not refresh — showing the last state read."
              : `Could not read the setting: ${checkoutModeReadError(state.error)}`}
          </p>
        )}
        {data && (
          <>
            <p className="text-muted-foreground" data-testid="checkout-mode-effect">{checkoutModeEffect(data.mode)}</p>
            <p className="text-xs text-muted-foreground" data-testid="checkout-mode-changed">
              {data.updated_by_user_id
                ? <>Last changed {data.updated_at ? formatPHTDisplay(data.updated_at) : ""} by {data.updated_by_name ?? "an unknown user"}.</>
                : <>Not changed from the Hub yet.</>}
              {data.drafts_to_confirm > 0 && (
                <>
                  {" "}{data.drafts_to_confirm} waiting in{" "}
                  <Link to="/sales?tab=web" className="underline underline-offset-2">To confirm</Link>.
                </>
              )}
            </p>

            {canToggle ? (
              <div className="flex items-center gap-3 pt-1">
                <Switch
                  id="checkout-mode"
                  checked={on}
                  disabled={save.isPending}
                  onCheckedChange={(next) => openConfirm(next ? "draft" : "order")}
                  aria-label="Website orders (staff confirm first)"
                />
                <Label htmlFor="checkout-mode">{CHECKOUT_MODE_LABEL[data.mode]}</Label>
                {save.isPending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="checkout-mode-readonly">
                Only an admin can change this.
              </p>
            )}
          </>
        )}
      </CardContent>

      <AlertDialog open={pending !== null} onOpenChange={(o) => { if (!o && !save.isPending) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending === "draft" ? "Staff confirm every website order first?" : "Create website orders at checkout again?"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>{pending ? checkoutModeEffect(pending) : ""}</p>
                {pending && data && (
                  <p className="font-medium text-foreground" data-testid="checkout-mode-waiting">
                    {draftsWaitingLine(data.drafts_to_confirm, pending)}
                  </p>
                )}
                <p className="text-xs">The website picks this up on the next checkout. No deploy is needed.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={save.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={save.isPending}
              onClick={(e) => { e.preventDefault(); if (pending) save.mutate(pending); }}
            >
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {pending === "draft" ? "Turn on" : "Turn off"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
