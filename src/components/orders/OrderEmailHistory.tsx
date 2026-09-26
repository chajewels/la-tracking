import { useQuery } from "@tanstack/react-query";
import { Loader2, Mail } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { formatPHTDisplay } from "@/lib/date-utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EMAIL_LABELS, emailStatusTone, type OrderEmailHistory as History } from "@/components/orders/order-email-history";

/**
 * Customer emails for one WEB order or plan: every storefront email logged
 * under its reference (order-ready, the payment reminder, expiry …) and the
 * stage D reminder ledger (docs/WEB-PAYMENT-REMINDERS.md), newest first.
 * Read through get_order_email_history (staff only; SECURITY DEFINER — the
 * email log itself is service-role only). Not in the generated types yet —
 * hence the cast.
 */
export default function OrderEmailHistory({ entityType, entityId }: { entityType: "cash_order" | "layaway"; entityId: string }) {
  const q = useQuery<History>({
    queryKey: ["order-email-history", entityType, entityId],
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await supabase.rpc("get_order_email_history" as any, { p_entity_type: entityType, p_entity_id: entityId } as any);
      if (error) throw error;
      const out = (data ?? {}) as History & { error?: string };
      if (out.error) throw new Error(out.error);
      return out;
    },
    staleTime: 60_000,
  });

  const emails = q.data?.emails ?? [];
  const reminders = q.data?.payment_reminders ?? [];

  return (
    <Card data-testid="order-email-history">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="h-4 w-4 text-primary" />
          Customer emails
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {q.isLoading && (
          <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        )}
        {q.isError && <p className="text-destructive">Could not read the email history.</p>}
        {q.data && emails.length === 0 && reminders.length === 0 && (
          <p className="text-muted-foreground">No customer emails recorded for this order yet.</p>
        )}
        {emails.length > 0 && (
          <ul className="divide-y divide-border">
            {emails.map((e, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="font-medium">{EMAIL_LABELS[e.template] ?? e.template}</p>
                  <p className="break-all text-xs text-muted-foreground">
                    {formatPHTDisplay(e.created_at)} · {e.recipient}
                    {e.skip_reason ? ` · ${e.skip_reason.replace(/_/g, " ")}` : ""}
                    {e.error ? ` · ${e.error}` : ""}
                  </p>
                </div>
                <Badge variant={emailStatusTone(e.status)}>{e.status}</Badge>
              </li>
            ))}
          </ul>
        )}
        {reminders.length > 0 && (
          <div className="rounded-md border border-border p-3" data-testid="order-email-history-reminders">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Payment reminders</p>
            <ul className="space-y-1">
              {reminders.map((r, i) => (
                <li key={i} className="text-xs">
                  {formatPHTDisplay(r.claimed_at)} — <span className="font-medium">{r.status}</span> for the deadline{" "}
                  {formatPHTDisplay(r.deadline)} · {r.currency === "PHP" ? "₱" : "¥"}{Number(r.amount).toLocaleString("en-US")}
                  {" "}· {r.lang === "ja" ? "Japanese + English" : "English"}
                  {r.detail ? ` · ${r.detail}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
