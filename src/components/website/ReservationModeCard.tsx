import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Hourglass, Loader2 } from "lucide-react";
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
  RESERVATION_MODE_KEY, type ReservationModeState, reservationModeEffect, reservationModeReadError,
  reservationModeRefusal,
} from "@/components/website/reservation-mode";

/**
 * Website → Settings: the reserve-first switch (system_settings.
 * web_reservation_mode, docs/RESERVE-FIRST.md). Owner rule 2026-09-24: it is
 * changed from here and never by SQL.
 *
 * Visible to manage_website_content holders (the Settings tab's own gate).
 * Changing it is ADMIN ONLY: everyone else sees the state read-only.
 *
 * Reads and writes go through two SECURITY DEFINER RPCs
 * (20260924120000_web_reservation_mode_toggle). set_web_reservation_mode
 * re-checks the admin role server-side, stores JSON true/false (what the
 * website's readReservationMode treats as on/off) and writes the audit row. A
 * trigger refuses every other write to the key, so there is no second path.
 * Neither RPC is in src/integrations/supabase/types.ts yet — hence the casts.
 */

async function callRpc(name: string, args?: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase.rpc(name as any, args as any);
  if (error) throw error;
  const out = (data ?? {}) as Record<string, unknown>;
  if (typeof out.error === "string") throw Object.assign(new Error(out.error), { code: out.error });
  return out;
}

export function ReservationModeCard() {
  const qc = useQueryClient();
  const { roles } = useAuth();
  const isAdmin = !!roles?.includes("admin");
  const [pending, setPending] = useState<boolean | null>(null);

  const mode = useQuery<ReservationModeState>({
    queryKey: RESERVATION_MODE_KEY,
    queryFn: async () => (await callRpc("get_web_reservation_mode")) as unknown as ReservationModeState,
    staleTime: 30_000,
  });

  const save = useMutation({
    mutationFn: (next: boolean) =>
      callRpc("set_web_reservation_mode", { p_enabled: next, p_expected: mode.data?.enabled ?? null }),
    onSuccess: (out) => {
      toast({
        title: out.enabled ? "Reserve-first checkout is ON" : "Reserve-first checkout is OFF",
        description: reservationModeEffect(!!out.enabled),
      });
    },
    onError: (e: Error & { code?: string }) => {
      toast({ title: "Not changed", description: reservationModeRefusal(e.code ?? e.message), variant: "destructive" });
    },
    onSettled: () => {
      setPending(null);
      qc.invalidateQueries({ queryKey: RESERVATION_MODE_KEY });
    },
  });

  const data = mode.data;
  const canToggle = isAdmin && data?.can_change !== false;

  const openConfirm = (next: boolean) => {
    setPending(next);
    // Turning off states how many are still waiting — make it current.
    if (!next) mode.refetch();
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Hourglass className="h-4 w-4 text-primary" />
          Reserve-first checkout
          {data && (
            <Badge
              variant={data.enabled ? "default" : "secondary"}
              data-testid="reservation-mode-state"
            >
              {data.enabled ? "On" : "Off"}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {mode.isLoading && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {mode.isError && (
          <p className="text-destructive" data-testid="reservation-mode-read-error">
            {data
              ? "Could not refresh the switch — showing the last state read."
              : `Could not read the switch: ${reservationModeReadError(mode.error)}`}
          </p>
        )}
        {data && (
          <>
            <p className="text-muted-foreground">{reservationModeEffect(data.enabled)}</p>
            <p className="text-xs text-muted-foreground" data-testid="reservation-mode-changed">
              {data.updated_by_user_id
                ? <>Last changed {data.updated_at ? formatPHTDisplay(data.updated_at) : ""} by {data.updated_by_name ?? "an unknown user"}.</>
                : <>Not changed from the Hub yet{data.updated_at ? ` (set ${formatPHTDisplay(data.updated_at)})` : ""}.</>}
              {data.awaiting_total > 0 && <> {data.awaiting_total} reservation{data.awaiting_total === 1 ? "" : "s"} waiting for confirmation.</>}
            </p>

            {canToggle ? (
              <div className="flex items-center gap-3 pt-1">
                <Switch
                  id="reservation-mode"
                  checked={data.enabled}
                  disabled={save.isPending}
                  onCheckedChange={(next) => openConfirm(next)}
                  aria-label="Reserve-first checkout"
                />
                <Label htmlFor="reservation-mode">{data.enabled ? "On" : "Off"}</Label>
                {save.isPending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="reservation-mode-readonly">
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
              Turn reserve-first checkout {pending ? "ON" : "OFF"}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>{pending !== null ? reservationModeEffect(pending) : ""}</p>
                {pending === false && data && (
                  <p className="font-medium text-foreground" data-testid="reservation-mode-waiting">
                    {data.awaiting_total === 0
                      ? "No reservations are waiting."
                      : `${data.awaiting_total} reservation${data.awaiting_total === 1 ? " is" : "s are"} still waiting for confirmation.`}
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
              onClick={(e) => { e.preventDefault(); if (pending !== null) save.mutate(pending); }}
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
