import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/hooks/use-toast";
import { formatPHTDisplay } from "@/lib/date-utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  MODE_LABEL, PAYMENT_REMINDERS_KEY, type PaymentReminderMode, type PaymentRemindersState,
  invalidOwnerAddresses, parseOwnerAddresses, paymentRemindersEffect, paymentRemindersReadError,
  paymentRemindersRefusal,
} from "@/components/settings/payment-reminders";

/**
 * Settings → General: the stage D payment-reminder switch
 * (system_settings.web_payment_reminders_mode + _owner_addresses,
 * docs/WEB-PAYMENT-REMINDERS.md). Off → Owner addresses only (the owner's
 * acceptance test) → On.
 *
 * Visible to admin_settings holders (the page's own gate); changing it is
 * ADMIN ONLY and re-checked server-side by set_web_payment_reminders, which
 * writes the audit row. A trigger refuses every other write to the two keys.
 * Neither RPC is in src/integrations/supabase/types.ts yet — hence the casts.
 */

async function callRpc(name: string, args?: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase.rpc(name as any, args as any);
  if (error) throw error;
  const out = (data ?? {}) as Record<string, unknown>;
  if (typeof out.error === "string") {
    throw Object.assign(new Error(out.error), { code: out.error, entry: out.entry as string | undefined });
  }
  return out;
}

const MODES: PaymentReminderMode[] = ["off", "owner_only", "on"];

export function PaymentRemindersCard() {
  const qc = useQueryClient();
  const { roles } = useAuth();
  const isAdmin = !!roles?.includes("admin");
  const [pending, setPending] = useState<PaymentReminderMode | null>(null);
  const [ownerText, setOwnerText] = useState("");

  const state = useQuery<PaymentRemindersState>({
    queryKey: PAYMENT_REMINDERS_KEY,
    queryFn: async () => (await callRpc("get_web_payment_reminders")) as unknown as PaymentRemindersState,
    staleTime: 30_000,
  });
  const data = state.data;

  useEffect(() => {
    if (data) setOwnerText((data.owner_addresses ?? []).join("\n"));
  }, [data]);

  const save = useMutation({
    mutationFn: (v: { mode: PaymentReminderMode; owners: string[] | null }) =>
      callRpc("set_web_payment_reminders", {
        p_mode: v.mode,
        p_owner_addresses: v.owners,
        p_expected_mode: data?.mode ?? null,
      }),
    onSuccess: (out) => {
      toast({
        title: out.changed ? `Payment reminders: ${MODE_LABEL[out.mode as PaymentReminderMode] ?? out.mode}` : "Nothing changed",
        description: paymentRemindersEffect(out.mode as PaymentReminderMode),
      });
    },
    onError: (e: Error & { code?: string; entry?: string }) => {
      toast({ title: "Not changed", description: paymentRemindersRefusal(e.code ?? e.message, e.entry), variant: "destructive" });
    },
    onSettled: () => {
      setPending(null);
      qc.invalidateQueries({ queryKey: PAYMENT_REMINDERS_KEY });
    },
  });

  const canChange = isAdmin && data?.can_change !== false;
  const owners = parseOwnerAddresses(ownerText);
  const badOwners = invalidOwnerAddresses(owners);
  const ownersDirty = !!data && owners.join("\n") !== (data.owner_addresses ?? []).join("\n");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <BellRing className="h-4 w-4 text-primary" />
          Payment reminders
          {data && (
            <Badge variant={data.mode === "on" ? "default" : "secondary"} data-testid="payment-reminders-state">
              {MODE_LABEL[data.mode]}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          One email before a confirmed website order's payment deadline — 6 hours before a 24-hour deadline,
          24 hours before a 72-hour one. Website orders only; at most two per order.
        </p>
        {state.isLoading && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {state.isError && (
          <p className="text-destructive" data-testid="payment-reminders-read-error">
            {data
              ? "Could not refresh — showing the last state read."
              : `Could not read the setting: ${paymentRemindersReadError(state.error)}`}
          </p>
        )}
        {data && (
          <>
            <p className="font-medium" data-testid="payment-reminders-effect">{paymentRemindersEffect(data.mode)}</p>
            <p className="text-xs text-muted-foreground" data-testid="payment-reminders-changed">
              {data.updated_by_user_id
                ? <>Last changed {data.updated_at ? formatPHTDisplay(data.updated_at) : ""} by {data.updated_by_name ?? "an unknown user"}.</>
                : <>Not changed from the Hub yet.</>}
              {" "}{data.sent_7d} sent in the last 7 days · {data.due_now} due right now.
            </p>

            {canChange ? (
              <div className="space-y-4 pt-1">
                <RadioGroup
                  value={data.mode}
                  onValueChange={(v) => { if (v !== data.mode) setPending(v as PaymentReminderMode); }}
                  className="gap-2"
                  aria-label="Payment reminder mode"
                >
                  {MODES.map((m) => (
                    <div key={m} className="flex items-center gap-3">
                      <RadioGroupItem value={m} id={`payment-reminders-${m}`} disabled={save.isPending} />
                      <Label htmlFor={`payment-reminders-${m}`}>{MODE_LABEL[m]}</Label>
                    </div>
                  ))}
                </RadioGroup>

                <div className="space-y-1.5">
                  <Label htmlFor="payment-reminders-owners" className="text-xs">
                    Owner addresses (one per line; "@domain" for a whole domain)
                  </Label>
                  <Textarea
                    id="payment-reminders-owners"
                    value={ownerText}
                    onChange={(e) => setOwnerText(e.target.value)}
                    rows={3}
                    className="max-w-md font-mono text-xs"
                  />
                  {badOwners.length > 0 && (
                    <p className="text-xs text-destructive" data-testid="payment-reminders-owner-error">
                      Not an address or @domain: {badOwners.join(", ")}
                    </p>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!ownersDirty || badOwners.length > 0 || save.isPending}
                    onClick={() => save.mutate({ mode: data.mode, owners })}
                  >
                    Save owner addresses
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="payment-reminders-readonly">
                Owner addresses: {(data.owner_addresses ?? []).join(", ") || "none"}. Only an admin can change this.
              </p>
            )}
          </>
        )}
      </CardContent>

      <AlertDialog open={pending !== null} onOpenChange={(o) => { if (!o && !save.isPending) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Payment reminders: {pending ? MODE_LABEL[pending] : ""}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>{pending ? paymentRemindersEffect(pending) : ""}</p>
                {pending === "on" && data && (
                  <p className="font-medium text-foreground" data-testid="payment-reminders-due">
                    {data.due_now === 0
                      ? "No order is due a reminder right now."
                      : `${data.due_now} order${data.due_now === 1 ? " is" : "s are"} due a reminder now and will get one at the next hourly run.`}
                  </p>
                )}
                <p className="text-xs">Takes effect at the next hourly run (:13). No deploy is needed.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={save.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={save.isPending}
              onClick={(e) => { e.preventDefault(); if (pending) save.mutate({ mode: pending, owners: null }); }}
            >
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
