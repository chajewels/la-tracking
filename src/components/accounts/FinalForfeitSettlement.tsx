import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency } from "@/lib/calculations";
import { PAYMENT_METHODS } from "@/lib/payment-method-registry";
import { getPHTToday } from "@/lib/date-utils";
import type { Currency } from "@/lib/types";

/**
 * SAME-DAY SETTLEMENT AFTER FINAL FORFEITURE (owner rule R7, 2026-10-20).
 * Shown on a final_forfeited plan ONLY while settle-final-forfeited's preview
 * says it can be submitted: on the PHT day of the final forfeiture, no pending
 * submission, no earlier settlement. One full payment (remaining balance +
 * that day's engine penalty, if any) with proof; a reviewer confirms it in
 * Payment Submissions as usual. docs/PENALTY-AND-FORFEITURE.md.
 */

interface Preview {
  ok?: boolean;
  amount?: number;
  penalty_total?: number;
  penalties?: Array<{
    installment_number?: number;
    stage: string;
    cycle: number;
    amount: number;
  }>;
  rehold?: boolean;
  final_forfeit_day?: string;
  error?: string;
  code?: string;
}

async function invokeSettlement(
  body: Record<string, unknown>,
): Promise<Preview> {
  const { data, error } = await supabase.functions.invoke(
    "settle-final-forfeited",
    { body },
  );
  if (error) {
    try {
      const ctxBody = (error as { context?: { body?: BodyInit | null } } | null)
        ?.context?.body;
      if (ctxBody) return (await new Response(ctxBody).json()) as Preview;
    } catch {
      /* fall through */
    }
    return { error: error.message };
  }
  return (data ?? {}) as Preview;
}

const MAX_PROOF_BYTES = 5 * 1024 * 1024;

export function FinalForfeitSettlement({
  accountId,
  invoiceNumber,
  currency,
}: {
  accountId: string;
  invoiceNumber: string;
  currency: Currency;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState("");
  const [paymentDate, setPaymentDate] = useState(getPHTToday());
  const [reference, setReference] = useState("");
  const [senderName, setSenderName] = useState("");
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { data: preview } = useQuery({
    queryKey: ["final-forfeit-settlement", accountId],
    queryFn: () => invokeSettlement({ account_id: accountId, preview: true }),
    staleTime: 60_000,
  });

  const methods = useMemo(
    () =>
      PAYMENT_METHODS.filter(
        (m) => m.currency === currency || m.currency === "any",
      ),
    [currency],
  );
  const proofError =
    proofFile && proofFile.size > MAX_PROOF_BYTES ? "File exceeds 5MB" : null;

  const submit = useCallback(async () => {
    if (!proofFile || !method) return;
    setSubmitting(true);
    try {
      const ext = (proofFile.name.split(".").pop() || "jpg").toLowerCase();
      const storagePath = `${accountId}/${invoiceNumber}_Settlement_${paymentDate}_${Date.now().toString(36)}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("payment-proofs")
        .upload(storagePath, proofFile, {
          cacheControl: "3600",
          upsert: false,
        });
      if (upErr) throw upErr;
      const proofUrl = supabase.storage
        .from("payment-proofs")
        .getPublicUrl(storagePath).data.publicUrl;

      const res = await invokeSettlement({
        account_id: accountId,
        payment_method: method,
        payment_date: paymentDate,
        reference_number: reference || null,
        sender_name: senderName || null,
        proof_url: proofUrl,
      });
      if (!res.ok) throw new Error(res.error || "Settlement failed");
      toast.success(
        `Settlement of ${formatCurrency(Number(res.amount), currency)} submitted — confirm it in Payment Submissions.`,
      );
      setOpen(false);
      queryClient.invalidateQueries({
        queryKey: ["final-forfeit-settlement", accountId],
      });
      queryClient.invalidateQueries({ queryKey: ["account", accountId] });
      queryClient.invalidateQueries({ queryKey: ["schedule", accountId] });
      queryClient.invalidateQueries({
        queryKey: ["submission-proofs", accountId],
      });
    } catch (err: unknown) {
      toast.error((err as Error).message || "Settlement failed");
    } finally {
      setSubmitting(false);
    }
  }, [
    accountId,
    invoiceNumber,
    currency,
    method,
    paymentDate,
    reference,
    senderName,
    proofFile,
    queryClient,
  ]);

  // Nothing to offer outside the day or after a settlement: render nothing.
  if (!preview?.ok) return null;

  const amount = Number(preview.amount ?? 0);
  const penaltyTotal = Number(preview.penalty_total ?? 0);

  return (
    <>
      <Button
        variant="outline"
        className="border-warning/30 text-warning hover:bg-warning/10"
        onClick={() => setOpen(true)}
      >
        Same-day settlement
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Same-day settlement</DialogTitle>
            <DialogDescription>
              One full payment, today only ({preview.final_forfeit_day}, PHT). A
              reviewer confirms it in Payment Submissions; confirming it
              completes the account.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-md border border-border p-3 text-sm space-y-1">
              <div className="flex justify-between">
                <span>Amount to settle</span>
                <strong>{formatCurrency(amount, currency)}</strong>
              </div>
              {penaltyTotal > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Includes today's penalty of{" "}
                  {formatCurrency(penaltyTotal, currency)}
                  {preview.penalties?.[0]?.installment_number
                    ? ` (installment ${preview.penalties[0].installment_number})`
                    : ""}
                  .
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No penalty falls due today on this plan.
                </p>
              )}
              {preview.rehold && (
                <p className="text-xs text-muted-foreground">
                  The piece goes back on hold for this customer when you submit.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Payment method *</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a method" />
                </SelectTrigger>
                <SelectContent>
                  {methods.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ffs-date">Payment date</Label>
              <Input
                id="ffs-date"
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ffs-ref">Reference number</Label>
              <Input
                id="ffs-ref"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ffs-sender">Sender name</Label>
              <Input
                id="ffs-sender"
                value={senderName}
                onChange={(e) => setSenderName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ffs-proof">Proof of payment *</Label>
              <Input
                id="ffs-proof"
                type="file"
                accept="image/*,application/pdf"
                onChange={(e) => setProofFile(e.target.files?.[0] ?? null)}
              />
              {proofError && (
                <p className="text-xs text-destructive">{proofError}</p>
              )}
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={submitting || !method || !proofFile || !!proofError}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                `Submit ${formatCurrency(amount, currency)}`
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
