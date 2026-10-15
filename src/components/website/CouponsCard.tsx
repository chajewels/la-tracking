import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, TicketPercent } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { isMissingFunction } from "@/components/website/shipping-fees";
import {
  COUPON_NOTE, WEBSITE_COUPONS_KEY, type CouponForm, type CouponKind, type CouponsState, type WebsiteCoupon,
  couponPayload, couponRefusal, couponStatus, couponValueLabel, emptyCouponForm, formFromCoupon, formatYen,
  usesLabel, validateCouponForm,
} from "@/components/website/coupons";

/**
 * Website → Settings → Coupons (owner 2026-10-15). Rendered for ADMINS ONLY
 * (Website.tsx); every change is re-checked server-side (admin role) and
 * audited by upsert_website_coupon / set_website_coupon_active. Coupons are
 * never deleted, only switched off.
 *
 * Until migration 20261217100000 is applied the RPCs do not exist (PGRST202):
 * the card says "Waiting for the database update" instead of erroring.
 */

async function callRpc(name: string, args?: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase.rpc(name as any, args as any);
  if (error) throw error;
  const out = (data ?? {}) as Record<string, unknown>;
  if (typeof out.error === "string") throw Object.assign(new Error(out.error), { code: out.error });
  return out;
}

function dateRange(c: WebsiteCoupon): string {
  const fmt = (s: string) => new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  if (!c.starts_at && !c.ends_at) return "Any time";
  if (c.starts_at && c.ends_at) return `${fmt(c.starts_at)} – ${fmt(c.ends_at)}`;
  return c.starts_at ? `From ${fmt(c.starts_at)}` : `Until ${fmt(c.ends_at as string)}`;
}

export function CouponsCard() {
  const qc = useQueryClient();
  const [form, setForm] = useState<CouponForm | null>(null);

  const state = useQuery<CouponsState>({
    queryKey: WEBSITE_COUPONS_KEY,
    queryFn: async () => {
      try {
        const out = await callRpc("get_website_coupons");
        return { available: true, coupons: (out.coupons ?? []) as WebsiteCoupon[] };
      } catch (e) {
        if (isMissingFunction(e)) return { available: false };
        throw e;
      }
    },
    staleTime: 30_000,
  });
  const data = state.data;
  const coupons = data?.available ? data.coupons : [];

  const onError = (e: Error & { code?: string }) => {
    toast({ title: "Not saved", description: couponRefusal(e.code ?? e.message), variant: "destructive" });
  };
  const save = useMutation({
    mutationFn: (f: CouponForm) => callRpc("upsert_website_coupon", { p: couponPayload(f) }),
    onSuccess: (out) => {
      const c = out.coupon as WebsiteCoupon | undefined;
      toast({ title: form?.id ? "Coupon saved" : "Coupon added", description: c ? `${c.code}: ${couponValueLabel(c)}` : undefined });
      setForm(null);
    },
    onError,
    onSettled: () => qc.invalidateQueries({ queryKey: WEBSITE_COUPONS_KEY }),
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; active: boolean }) => callRpc("set_website_coupon_active", { p_id: v.id, p_active: v.active }),
    onSuccess: (out) => {
      const c = out.coupon as WebsiteCoupon | undefined;
      if (c) toast({ title: c.is_active ? `${c.code} switched on` : `${c.code} switched off` });
    },
    onError,
    onSettled: () => qc.invalidateQueries({ queryKey: WEBSITE_COUPONS_KEY }),
  });

  const formError = form ? validateCouponForm(form) : null;
  const set = <K extends keyof CouponForm>(k: K, v: CouponForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const digits = (s: string) => s.replace(/[^\d]/g, "");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <TicketPercent className="h-4 w-4 text-primary" />
          Coupons
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {state.isLoading && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {data?.available === false && (
          <p className="rounded-md border border-dashed p-3 text-muted-foreground" data-testid="coupons-waiting">
            Waiting for the database update. Coupons appear here once the owner has run the coupons migration in the
            Supabase SQL Editor. Checkout does not accept codes until then.
          </p>
        )}
        {state.isError && (
          <p className="text-destructive" data-testid="coupons-read-error">Could not read the coupons. Try again in a moment.</p>
        )}
        {data?.available && (
          <>
            {coupons.length === 0 ? (
              <p className="text-muted-foreground">No coupons yet.</p>
            ) : (
              <ul className="divide-y rounded-md border" data-testid="coupons-list">
                {coupons.map((c) => {
                  const status = couponStatus(c);
                  return (
                    <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5" data-testid={`coupon-${c.code}`}>
                      <div className="min-w-0 space-y-0.5">
                        <p className="flex flex-wrap items-center gap-2">
                          <span className="font-mono font-semibold">{c.code}</span>
                          <span>{couponValueLabel(c)}</span>
                          <Badge variant={status === "Active" ? "default" : "secondary"}>{status}</Badge>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {c.min_subtotal_jpy != null ? `Pieces from ${formatYen(c.min_subtotal_jpy)} · ` : ""}
                          {dateRange(c)} · {usesLabel(c)} · {c.per_customer_limit} per customer
                          {c.full_price_only ? " · full-price pieces only" : ""}
                          {c.allow_layaway ? "" : " · not for layaway"}
                        </p>
                        {c.note && <p className="text-xs text-muted-foreground">{c.note}</p>}
                      </div>
                      <div className="flex items-center gap-3">
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Switch
                            checked={c.is_active} disabled={toggle.isPending}
                            onCheckedChange={(v) => toggle.mutate({ id: c.id, active: v })}
                            aria-label={`${c.code} active`}
                          />
                          Active
                        </label>
                        <Button size="sm" variant="outline" onClick={() => setForm(formFromCoupon(c))} disabled={save.isPending}>
                          Edit
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-xs text-muted-foreground" data-testid="coupons-note">{COUPON_NOTE}</p>
            <Button size="sm" onClick={() => setForm(emptyCouponForm())} disabled={save.isPending}>
              <Plus className="mr-1 h-4 w-4" /> Add a coupon
            </Button>
          </>
        )}
      </CardContent>

      <Dialog open={form !== null} onOpenChange={(o) => { if (!o && !save.isPending) setForm(null); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form?.id ? `Edit ${form.code}` : "Add a coupon"}</DialogTitle>
            <DialogDescription>{COUPON_NOTE}</DialogDescription>
          </DialogHeader>
          {form && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="coupon-code">Code</Label>
                <Input id="coupon-code" value={form.code} maxLength={20} placeholder="WELCOME10"
                  onChange={(e) => set("code", e.target.value.toUpperCase().replace(/\s/g, ""))} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="coupon-kind">Type</Label>
                  <Select value={form.kind} onValueChange={(v) => set("kind", v as CouponKind)}>
                    <SelectTrigger id="coupon-kind"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="percent">Percent</SelectItem>
                      <SelectItem value="amount">Yen</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="coupon-value">{form.kind === "percent" ? "Percent" : "Yen"}</Label>
                  <Input id="coupon-value" value={form.value} inputMode="numeric"
                    placeholder={form.kind === "percent" ? "10" : "5000"} onChange={(e) => set("value", digits(e.target.value))} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="coupon-min">Pieces at least (¥, optional)</Label>
                <Input id="coupon-min" value={form.min_subtotal_jpy} inputMode="numeric"
                  onChange={(e) => set("min_subtotal_jpy", digits(e.target.value))} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="coupon-max">Total uses</Label>
                  <Input id="coupon-max" value={form.max_uses} inputMode="numeric" placeholder="No limit"
                    onChange={(e) => set("max_uses", digits(e.target.value))} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="coupon-per">Per customer</Label>
                  <Input id="coupon-per" value={form.per_customer_limit} inputMode="numeric"
                    onChange={(e) => set("per_customer_limit", digits(e.target.value))} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="coupon-start">Starts (optional)</Label>
                <Input id="coupon-start" type="datetime-local" value={form.starts_at} onChange={(e) => set("starts_at", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="coupon-end">Ends (optional)</Label>
                <Input id="coupon-end" type="datetime-local" value={form.ends_at} onChange={(e) => set("ends_at", e.target.value)} />
              </div>
              <label className="flex items-center gap-2 sm:col-span-2">
                <Switch checked={form.full_price_only} onCheckedChange={(v) => set("full_price_only", v)} />
                Full-price pieces only (pieces on sale do not count)
              </label>
              <label className="flex items-center gap-2 sm:col-span-2">
                <Switch checked={form.allow_layaway} onCheckedChange={(v) => set("allow_layaway", v)} />
                Can be used on a layaway
              </label>
              <label className="flex items-center gap-2 sm:col-span-2">
                <Switch checked={form.is_active} onCheckedChange={(v) => set("is_active", v)} />
                Active
              </label>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="coupon-note">Note (staff only)</Label>
                <Textarea id="coupon-note" rows={2} value={form.note} onChange={(e) => set("note", e.target.value)} />
              </div>
            </div>
          )}
          {formError && form?.code && (
            <p className="text-xs text-destructive" data-testid="coupon-form-error">{formError}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)} disabled={save.isPending}>Cancel</Button>
            <Button onClick={() => form && save.mutate(form)} disabled={!!formError || save.isPending}>
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
