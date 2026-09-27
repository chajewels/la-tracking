import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Truck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  SHIPPING_NOTE, SHIPPING_RATES_KEY, type ShippingRate, type ShippingRatesState,
  deactivateEffect, feeFor, formatYen, groupByCountry, isMissingFunction, rateLabel,
  shippingRateRefusal, validateRateInput,
} from "@/components/website/shipping-fees";

/**
 * Website → Settings → Shipping fees (website-orders PR 2): the storefront
 * rate card, public.shipping_rates. Rendered for ADMINS ONLY (Website.tsx);
 * every change is re-checked server-side (admin role) and audited by
 * set_shipping_rate / deactivate_shipping_rate, and a trigger refuses every
 * other write. Rates are never deleted, only deactivated.
 *
 * Until migration 20261008100000 is applied the RPCs do not exist (PGRST202):
 * the card says "Waiting for the database update" instead of erroring, since
 * the frontend reaches main before the owner runs the SQL.
 * None of the RPCs are in src/integrations/supabase/types.ts yet — hence the casts.
 */

async function callRpc(name: string, args?: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase.rpc(name as any, args as any);
  if (error) throw error;
  const out = (data ?? {}) as Record<string, unknown>;
  if (typeof out.error === "string") throw Object.assign(new Error(out.error), { code: out.error });
  return out;
}

type FormState = { mode: "add" } | { mode: "fee"; rate: ShippingRate };
type Pending =
  | { kind: "set"; country: string; min: number; fee: number; before: ShippingRate | null }
  | { kind: "deactivate"; rate: ShippingRate };

export function ShippingFeesCard() {
  const qc = useQueryClient();
  const { roles } = useAuth();
  const isAdmin = !!roles?.includes("admin");
  const [form, setForm] = useState<FormState | null>(null);
  const [country, setCountry] = useState("");
  const [threshold, setThreshold] = useState("");
  const [fee, setFee] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);

  const state = useQuery<ShippingRatesState>({
    queryKey: SHIPPING_RATES_KEY,
    queryFn: async () => {
      try {
        const out = await callRpc("get_shipping_rates");
        return {
          available: true,
          can_change: out.can_change === true,
          rates: (out.rates ?? []) as ShippingRate[],
        };
      } catch (e) {
        if (isMissingFunction(e)) return { available: false };
        throw e;
      }
    },
    staleTime: 30_000,
  });
  const data = state.data;
  const rates = data?.available ? data.rates : [];
  const canChange = isAdmin && data?.available === true && data.can_change;

  const save = useMutation({
    mutationFn: (p: Pending) =>
      p.kind === "set"
        ? callRpc("set_shipping_rate", { p_country: p.country, p_min_subtotal_jpy: p.min, p_fee_jpy: p.fee })
        : callRpc("deactivate_shipping_rate", { p_id: p.rate.id }),
    onSuccess: (out) => {
      const r = out.rate as ShippingRate | undefined;
      const words: Record<string, string> = {
        created: "Rate added", fee_changed: "Fee changed", reactivated: "Rate reactivated",
        deactivated: "Rate deactivated", unchanged: "Nothing changed",
      };
      toast({
        title: words[String(out.action)] ?? "Saved",
        description: r ? `${r.country}: ${rateLabel(r)}` : undefined,
      });
      setForm(null);
    },
    onError: (e: Error & { code?: string }) => {
      toast({ title: "Not changed", description: shippingRateRefusal(e.code ?? e.message), variant: "destructive" });
    },
    onSettled: () => {
      setPending(null);
      qc.invalidateQueries({ queryKey: SHIPPING_RATES_KEY });
    },
  });

  const openAdd = () => {
    setCountry(""); setThreshold(""); setFee(""); setForm({ mode: "add" });
  };
  const openFee = (rate: ShippingRate) => {
    setCountry(rate.country); setThreshold(String(rate.min_subtotal_jpy)); setFee(String(rate.fee_jpy));
    setForm({ mode: "fee", rate });
  };
  const formError = form ? validateRateInput(country, threshold, fee) : null;
  const submitForm = () => {
    if (!form || formError) return;
    const c = country.trim().toUpperCase();
    const min = Number(threshold);
    const before = rates.find((r) => r.country === c && r.min_subtotal_jpy === min) ?? null;
    setPending({ kind: "set", country: c, min, fee: Number(fee), before });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Truck className="h-4 w-4 text-primary" />
          Shipping fees
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {state.isLoading && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {data?.available === false && (
          <p className="rounded-md border border-dashed p-3 text-muted-foreground" data-testid="shipping-fees-waiting">
            Waiting for the database update. The shipping fees appear here once the owner has run the
            shipping-fees migration in the Supabase SQL Editor. Checkout keeps charging the current card meanwhile.
          </p>
        )}
        {state.isError && (
          <p className="text-destructive" data-testid="shipping-fees-read-error">
            Could not read the shipping fees. Try again in a moment.
          </p>
        )}
        {data?.available && (
          <>
            {rates.length === 0 ? (
              <p className="text-muted-foreground">No shipping rates yet. Every country asks for a manual quote.</p>
            ) : (
              <div className="space-y-4" data-testid="shipping-fees-list">
                {groupByCountry(rates).map((g) => (
                  <div key={g.country} className="space-y-1.5">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.country}</p>
                    <ul className="divide-y rounded-md border">
                      {g.rates.map((r) => (
                        <li
                          key={r.id}
                          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                          data-testid={`shipping-rate-${r.country}-${r.min_subtotal_jpy}`}
                        >
                          <span className={r.is_active ? "" : "text-muted-foreground line-through"}>{rateLabel(r)}</span>
                          <span className="flex flex-wrap items-center gap-2">
                            <Badge variant={r.is_active ? "default" : "secondary"}>{r.is_active ? "Active" : "Inactive"}</Badge>
                            {canChange && r.is_active && (
                              <>
                                <Button size="sm" variant="outline" onClick={() => openFee(r)} disabled={save.isPending}>
                                  Change fee
                                </Button>
                                <Button
                                  size="sm" variant="ghost" className="text-destructive"
                                  onClick={() => setPending({ kind: "deactivate", rate: r })} disabled={save.isPending}
                                >
                                  Deactivate
                                </Button>
                              </>
                            )}
                            {canChange && !r.is_active && (
                              <Button
                                size="sm" variant="outline" disabled={save.isPending}
                                onClick={() => setPending({ kind: "set", country: r.country, min: r.min_subtotal_jpy, fee: r.fee_jpy, before: r })}
                              >
                                Reactivate
                              </Button>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground" data-testid="shipping-fees-note">{SHIPPING_NOTE}</p>
            {canChange ? (
              <Button size="sm" onClick={openAdd} disabled={save.isPending}>
                <Plus className="mr-1 h-4 w-4" /> Add a rate
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">Only an admin can change shipping fees.</p>
            )}
          </>
        )}
      </CardContent>

      <Dialog open={form !== null} onOpenChange={(o) => { if (!o && !save.isPending) setForm(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{form?.mode === "fee" ? `Change fee — ${form.rate.country}` : "Add a shipping rate"}</DialogTitle>
            <DialogDescription>{SHIPPING_NOTE}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="shipping-rate-country">Country</Label>
              <Input
                id="shipping-rate-country" value={country} maxLength={2} placeholder="JP"
                onChange={(e) => setCountry(e.target.value.toUpperCase())} disabled={form?.mode === "fee"}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="shipping-rate-threshold">From (¥)</Label>
              <Input
                id="shipping-rate-threshold" value={threshold} inputMode="numeric" placeholder="0"
                onChange={(e) => setThreshold(e.target.value.replace(/[^\d]/g, ""))} disabled={form?.mode === "fee"}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="shipping-rate-fee">Fee (¥)</Label>
              <Input
                id="shipping-rate-fee" value={fee} inputMode="numeric" placeholder="800"
                onChange={(e) => setFee(e.target.value.replace(/[^\d]/g, ""))}
              />
            </div>
          </div>
          {formError && (country || threshold || fee) && (
            <p className="text-xs text-destructive" data-testid="shipping-rate-form-error">{formError}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>Cancel</Button>
            <Button onClick={submitForm} disabled={!!formError}>Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={pending !== null} onOpenChange={(o) => { if (!o && !save.isPending) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending ? confirmTitle(pending) : ""}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2" data-testid="shipping-rate-confirm">
                {pending && <p>{confirmBody(pending, rates)}</p>}
                <p className="text-xs">Applies to the next checkout quote. Orders already placed keep their shipping.</p>
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
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function confirmTitle(p: Pending): string {
  if (p.kind === "deactivate") return `Deactivate ${p.rate.country}: ${rateLabel(p.rate)}?`;
  if (!p.before) return `Add ${p.country}: ${rateLabel({ min_subtotal_jpy: p.min, fee_jpy: p.fee })}?`;
  if (!p.before.is_active) return `Reactivate ${p.country}: ${rateLabel({ min_subtotal_jpy: p.min, fee_jpy: p.fee })}?`;
  return `Change the ${p.country} fee from ${formatYen(p.min)}?`;
}

function confirmBody(p: Pending, rates: ShippingRate[]): string {
  if (p.kind === "deactivate") return deactivateEffect(rates, p.rate);
  if (p.before && p.before.is_active) {
    return `${formatYen(p.before.fee_jpy)} → ${formatYen(p.fee)} for ${p.country} subtotals from ${formatYen(p.min)}.`;
  }
  const now = feeFor(rates, p.country, p.min);
  return now === null
    ? `${p.country} subtotals from ${formatYen(p.min)} have no fee on the card today (manual quote); they will be charged ${formatYen(p.fee)}.`
    : `${p.country} subtotals from ${formatYen(p.min)} are charged ${formatYen(now)} today; they will be charged ${formatYen(p.fee)}.`;
}
