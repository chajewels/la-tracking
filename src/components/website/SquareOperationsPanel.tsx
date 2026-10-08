import { useMemo, useState, type ReactNode } from "react";
import { useIsFetching, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { callUntypedRpc } from "@/lib/untyped-rpc";
import { formatCurrency } from "@/lib/calculations";
import { formatPHTDisplay } from "@/lib/date-utils";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import StatusPill from "@/components/shared/StatusPill";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DISPUTE_CLOSED_STATES, DISPUTE_WARNING_DAYS, HOLD_WARNING_DAYS, SQUARE_DECISIONS,
  ageLabel, defaultSettlementRange, isDeadlineSoon, isOpenSquareException, orderRef,
  refundNotPaidBack, settlementCsv, settlementFileName, settlementTotals,
  eventsApiNotEnabled, refundPendingDays, REFUND_PENDING_SUPPORT_DAYS, REFUND_PENDING_WARN_DAYS, squareDecisionRefusal, squareExceptionLabel, squareHealthStatus, squareNoteRequired, squarePaymentStateLabel,
  type SettlementRow, type SquareCaseKind, type SquareOpsHealth,
} from "@/lib/square-ops";

/**
 * Website → Settings → Card payments: the OPERATOR panel (Square integrity,
 * 2026-10-04, docs/SQUARE-INTEGRITY.md "Hub UI"), shown under the Square
 * settings card. Admin only (Website.tsx gate); every table has a staff SELECT
 * RLS policy. It reads; the only write is decide_square_case (staff record a
 * decision on an exception, refund or dispute — audited). Money is never moved
 * from here: refunds and dispute evidence stay in the Square Dashboard
 * (owner 2A).
 *
 * The integrity tables are not in the generated types yet (never hand-edit
 * types.ts), so reads go through the untyped-table cast and RPCs through
 * callUntypedRpc (never a detached supabase.rpc).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped tables (not in the generated types yet)
const db = supabase as unknown as { from: (table: string) => any };
const KEY = ["square-ops"] as const;
const LIMIT = 50;
const STALE = 30_000;
const PHT_TIP = "Shown in Philippine time (PHT), like the rest of the Hub. Japan time (JST) is one hour later.";

interface OrderLite { id: string; web_reference: string | null; invoice_number: string | null }
type WithOrder<T> = T & { order: OrderLite | null };

/** One read of cash_orders for the rows' orders (no embed: the integrity tables make PostgREST joins ambiguous). */
async function attachOrders<T extends { cash_order_id: string | null }>(rows: T[]): Promise<WithOrder<T>[]> {
  const ids = Array.from(new Set(rows.map((r) => r.cash_order_id).filter((v): v is string => !!v)));
  const map = new Map<string, OrderLite>();
  if (ids.length > 0) {
    const { data, error } = await supabase.from("cash_orders").select("id, web_reference, invoice_number").in("id", ids);
    if (error) throw error;
    for (const o of (data ?? []) as OrderLite[]) map.set(o.id, o);
  }
  return rows.map((r) => ({ ...r, order: r.cash_order_id ? map.get(r.cash_order_id) ?? null : null }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a PostgREST builder on an untyped table
async function readRows<T extends { cash_order_id: string | null }>(build: () => any): Promise<WithOrder<T>[]> {
  const { data, error } = await build();
  if (error) throw error;
  return attachOrders((data ?? []) as T[]);
}

const yen = (v: number | string | null | undefined) => (v == null ? "—" : formatCurrency(Number(v), "JPY"));
const when = (v: string | null | undefined) => (v ? formatPHTDisplay(v) : "—");

interface HoldRow {
  id: string; cash_order_id: string; amount_jpy: number; card_brand: string | null; card_last4: string | null;
  authorized_at: string; capture_by: string | null; action: string | null; action_started_at: string | null; test: boolean;
}
interface AttemptRow {
  id: string; cash_order_id: string; reference: string; amount_jpy: number; status: string; created_at: string;
  error_code: string | null; test: boolean;
}
interface ExceptionRow {
  id: string; cash_order_id: string; amount_jpy: number; captured_amount_jpy: number | null; status: string;
  cash_payment_id: string | null; exception: string | null; exception_at: string | null; exception_note: string | null;
  exception_resolved_at: string | null; captured_at: string | null; created_at: string; test: boolean;
  exception_decision: string | null; exception_decided_at: string | null;
}
interface RefundRow {
  id: string; cash_order_id: string; amount_jpy: number; status: string; reason: string | null; created_at: string;
  decision: string | null; decided_at: string | null;
}
interface DisputeRow {
  id: string; cash_order_id: string; amount_jpy: number | null; state: string; reason: string | null; due_at: string | null;
  created_at: string; decision: string | null; decided_at: string | null;
}
interface WebhookRow {
  event_id: string; event_type: string; received_at: string; attempts: number; last_error: string | null;
  next_attempt_at: string | null; status: string;
}

const decisionLabel = (kind: SquareCaseKind, v: string | null) =>
  v ? SQUARE_DECISIONS[kind].find((d) => d.value === v)?.label ?? v : null;

function Section({ title, hint, count, loading, error, emptyText, children }: {
  title: string; hint?: ReactNode; count: number; loading: boolean; error: unknown; emptyText: string; children: ReactNode;
}) {
  return (
    <section className="space-y-2 border-t border-border/60 pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {!loading && !error && <span className="text-xs text-muted-foreground">{count}{count >= LIMIT ? "+ (oldest 50 shown)" : ""}</span>}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {loading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</p>
      ) : error ? (
        <p className="text-xs text-destructive">Could not read: {(error as Error)?.message ?? "unknown error"}</p>
      ) : count === 0 ? (
        <p className="text-xs text-muted-foreground italic">{emptyText}</p>
      ) : children}
    </section>
  );
}

export function SquareOperationsPanel() {
  const qc = useQueryClient();
  const fetching = useIsFetching({ queryKey: KEY });
  const now = new Date();

  const holds = useQuery({
    queryKey: [...KEY, "holds"],
    staleTime: STALE,
    queryFn: () => readRows<HoldRow>(() => db.from("square_payments")
      .select("id, cash_order_id, amount_jpy, card_brand, card_last4, authorized_at, capture_by, action, action_started_at, test")
      .eq("status", "authorized").order("authorized_at", { ascending: true }).limit(LIMIT)),
  });

  const attempts = useQuery({
    queryKey: [...KEY, "attempts"],
    staleTime: STALE,
    queryFn: () => readRows<AttemptRow>(() => db.from("square_card_attempts")
      .select("id, cash_order_id, reference, amount_jpy, status, created_at, error_code, test")
      .in("status", ["reserved", "unknown", "cancelling"]).order("created_at", { ascending: true }).limit(LIMIT)),
  });

  const exceptions = useQuery({
    queryKey: [...KEY, "exceptions"],
    staleTime: STALE,
    queryFn: async () => (await readRows<ExceptionRow>(() => db.from("square_payments")
      .select("id, cash_order_id, amount_jpy, captured_amount_jpy, status, cash_payment_id, exception, exception_at, exception_note, exception_resolved_at, exception_decision, exception_decided_at, captured_at, created_at, test")
      .is("exception_resolved_at", null)
      .or("and(status.eq.captured,cash_payment_id.is.null),exception.not.is.null")
      .order("created_at", { ascending: true }).limit(LIMIT))).filter(isOpenSquareException),
  });

  const [allRefunds, setAllRefunds] = useState(false);
  const refunds = useQuery({
    queryKey: [...KEY, "refunds", allRefunds],
    staleTime: STALE,
    queryFn: () => readRows<RefundRow>(() => {
      const q = db.from("square_refunds")
        .select("id, cash_order_id, amount_jpy, status, reason, created_at, decision, decided_at");
      return allRefunds
        ? q.order("created_at", { ascending: false }).limit(LIMIT)
        : q.is("decided_at", null).order("created_at", { ascending: true }).limit(LIMIT);
    }),
  });

  const disputes = useQuery({
    queryKey: [...KEY, "disputes"],
    staleTime: STALE,
    queryFn: () => readRows<DisputeRow>(() => db.from("square_disputes")
      .select("id, cash_order_id, amount_jpy, state, reason, due_at, created_at, decision, decided_at")
      .or(`state.not.in.(${DISPUTE_CLOSED_STATES.join(",")}),decided_at.is.null`)
      .order("created_at", { ascending: true }).limit(LIMIT)),
  });

  const webhooks = useQuery({
    queryKey: [...KEY, "webhooks"],
    staleTime: STALE,
    queryFn: async () => {
      const { data, error } = await db.from("square_webhook_events")
        .select("event_id, event_type, received_at, attempts, last_error, next_attempt_at, status")
        .in("status", ["failed", "quarantined", "dead"]).order("received_at", { ascending: true }).limit(LIMIT);
      if (error) throw error;
      return (data ?? []) as WebhookRow[];
    },
  });

  // Health strip (QC11): the last hourly check and the backlogs.
  const health = useQuery({
    queryKey: [...KEY, "health"],
    staleTime: STALE,
    queryFn: async () => (await callUntypedRpc<SquareOpsHealth | null>("square_ops_health", {})) ?? null,
  });
  const healthStatus = squareHealthStatus(health.data, now);
  const oldestRefundDays = refundPendingDays(health.data, now);

  // Card activity report (estimated net — not bank money) — Japan days.
  const initialRange = useMemo(() => defaultSettlementRange(new Date()), []);
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [includeTest, setIncludeTest] = useState(false);
  const rangeOk = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const report = useQuery({
    queryKey: [...KEY, "settlement", from, to, includeTest],
    staleTime: STALE,
    enabled: rangeOk,
    queryFn: async () =>
      (await callUntypedRpc<SettlementRow[] | null>("square_settlement_report", { p_from: from, p_to: to, p_include_test: includeTest })) ?? [],
  });
  const totals = useMemo(() => settlementTotals(report.data ?? []), [report.data]);

  const downloadReport = () => {
    const blob = new Blob([settlementCsv(report.data ?? [])], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${settlementFileName(from, to)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Decision dialog (exception / refund / dispute).
  const [caseDialog, setCaseDialog] = useState<{ kind: SquareCaseKind; id: string; title: string } | null>(null);
  const [decision, setDecision] = useState("");
  const [note, setNote] = useState("");
  const openCase = (kind: SquareCaseKind, id: string, title: string) => {
    setDecision("");
    setNote("");
    setCaseDialog({ kind, id, title });
  };
  const decide = useMutation({
    mutationFn: async (v: { kind: SquareCaseKind; id: string; decision: string; note: string }) => {
      const out = await callUntypedRpc<{ ok?: boolean; error?: string; resolved?: boolean; next?: string; submission_id?: string; decision_recorded?: boolean } | null>("decide_square_case", {
        p_kind: v.kind, p_id: v.id, p_decision: v.decision, p_note: v.note,
      });
      if (!out?.ok) throw Object.assign(new Error(out?.error ?? "unknown"), { code: out?.error ?? "unknown", saved: out?.decision_recorded === true });
      // QC02: "record" decisions hand the capture to the normal Confirm path —
      // review-payment-submission reads Square and the finalizer records it.
      let recorded: string | null = null;
      if (out.next === "confirm_submission" && out.submission_id) {
        const { data, error } = await supabase.functions.invoke<{ ok?: boolean; error?: string; message?: string }>("review-payment-submission", {
          body: { submission_id: out.submission_id, action: "confirmed", reviewer_notes: v.note, submission_type: "cash_payment" },
        });
        if (data?.error || error) {
          let msg = data?.message || data?.error || error?.message || "unknown error";
          const ctx = (error as { context?: Response } | null)?.context;
          if (ctx && typeof ctx.json === "function") {
            try { const b = await ctx.clone().json(); msg = b?.message || b?.error || msg; } catch { /* keep msg */ }
          }
          recorded = `Decision saved, but recording did not finish: ${msg} Use "Finish recording" on Payment Submissions.`;
        } else recorded = v.decision === "record_net_after_refund"
          ? "The net was recorded on the order. If the refund was for a change to the order, lower the order total on the order page so it no longer shows the refunded part as owed."
          : "The capture was recorded on the order.";
      }
      return { ...out, recorded };
    },
    onSuccess: (out) => {
      toast({
        title: out.resolved || (out.recorded !== null && !out.recorded.startsWith("Decision saved")) ? "Resolved" : "Decision recorded",
        description: out.recorded ?? (out.resolved ? "Verified against Square and saved with your name in the audit log." : "Saved with your name in the audit log. It does not resolve the case by itself."),
      });
      setCaseDialog(null);
      qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e: Error & { code?: string; saved?: boolean }) => {
      const raw = e.code ?? e.message;
      const why = squareDecisionRefusal(raw.includes("not_staff") ? "not_staff" : raw);
      // The decision may be saved even when it does not resolve the case.
      toast({
        title: e.saved ? "Decision saved — case still open" : "Not recorded",
        description: why,
        variant: e.saved ? undefined : "destructive",
      });
      if (e.saved) { setCaseDialog(null); qc.invalidateQueries({ queryKey: KEY }); }
    },
  });
  const noteNeeded = caseDialog ? squareNoteRequired(caseDialog.kind) : false;
  const canSubmit = !!caseDialog && !!decision && (!noteNeeded || note.trim().length > 0) && !decide.isPending;

  const testPill = (t: boolean) => (t ? <StatusPill label="Test" tone="muted" className="ml-1" /> : null);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <ShieldAlert className="h-4 w-4 text-primary" />
          Card payments — operations
          <Button size="sm" variant="outline" className="ml-auto h-7 gap-1.5"
            onClick={() => qc.invalidateQueries({ queryKey: KEY })} disabled={fetching > 0}>
            {fetching > 0 ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </Button>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          What needs a person on card payments. Holds are captured or voided from Payment Submissions; refunds and dispute
          evidence are done in the Square Dashboard. Here staff record what was decided.
        </p>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        {/* Health (QC11) */}
        <section aria-label="Card payment checks" className={cn("rounded-md border px-3 py-2 text-xs",
          healthStatus === "ok" ? "border-border/60" : healthStatus === "unknown" ? "border-border/60 text-muted-foreground" : "border-warning/60 bg-warning/5")}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusPill
              label={healthStatus === "ok" ? "Checks OK" : healthStatus === "degraded" ? "Checks need attention" : healthStatus === "failed" ? "Checks FAILED" : healthStatus === "stale" ? "Checks not running" : "Checks: no run yet"}
              tone={healthStatus === "ok" ? "success" : healthStatus === "unknown" ? "muted" : healthStatus === "failed" || healthStatus === "stale" ? "danger" : "warning"} />
            <span title={PHT_TIP}>Last run {when(health.data?.last_run?.at ?? null)} · last good run {when(health.data?.last_ok_at ?? null)}</span>
            <span>Inbox backlog {health.data?.events_backlog ?? "—"}{(health.data?.events_dead ?? 0) > 0 ? ` · ${health.data?.events_dead} failed for good` : ""}</span>
            <span>Refunds open {health.data?.refunds_open ?? "—"} · disputes open {health.data?.disputes_open ?? "—"}</span>
            {oldestRefundDays != null && (
              <span className={cn(oldestRefundDays >= REFUND_PENDING_WARN_DAYS && "font-medium text-warning", oldestRefundDays >= REFUND_PENDING_SUPPORT_DAYS && "text-destructive")}>
                Oldest refund waiting {oldestRefundDays} {oldestRefundDays === 1 ? "day" : "days"}
                {oldestRefundDays >= REFUND_PENDING_SUPPORT_DAYS ? " — contact Square support" : oldestRefundDays >= REFUND_PENDING_WARN_DAYS ? " — check it in the Square Dashboard" : ""}
              </span>
            )}
            {(health.data?.attempts_stuck ?? 0) > 0 && (
              <span className="font-medium text-warning">Card attempts not settled: {health.data?.attempts_stuck}</span>
            )}
          </div>
          {eventsApiNotEnabled(health.data) ? (
            <p className="mt-1 text-muted-foreground">
              Square's event history (Events API) is not enabled for this Square account. The hourly checks still read payments, refunds
              and disputes directly; enable it before going live so a long outage can be caught up.
            </p>
          ) : null}
          {healthStatus !== "ok" && healthStatus !== "unknown" ? (
            <p className="mt-1 text-muted-foreground">
              {healthStatus === "stale"
                ? "The hourly Square check has not finished a good run for over 3 hours — it may not be running. Ask for it to be checked."
                : (health.data?.last_run?.report?.errors ?? []).slice(0, 2).join(" · ")
                  || (health.data?.last_run?.report?.truncated ?? []).concat(health.data?.last_run?.report?.history_gaps ?? []).join(" · ")
                  || "See the bell for details."}
            </p>
          ) : null}
        </section>

        {/* Active holds */}
        <Section title="Active holds" count={holds.data?.length ?? 0} loading={holds.isLoading} error={holds.error}
          emptyText="No card hold is waiting for Confirm or Reject."
          hint={`Money held on the customer's card, not yet taken. Warning when Square's deadline is under ${HOLD_WARNING_DAYS} days.`}>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Order</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Card</TableHead>
              <TableHead>Authorised</TableHead><TableHead title={PHT_TIP}>Square deadline</TableHead><TableHead>In progress</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {(holds.data ?? []).map((h) => {
                const soon = isDeadlineSoon(h.capture_by, now, HOLD_WARNING_DAYS);
                return (
                  <TableRow key={h.id}>
                    <TableCell className="font-mono text-xs">{orderRef(h.order)}{testPill(h.test)}</TableCell>
                    <TableCell className="text-right tabular-nums">{yen(h.amount_jpy)}</TableCell>
                    <TableCell className="text-xs">{h.card_brand ?? "Card"} ····{h.card_last4 ?? "????"}</TableCell>
                    <TableCell className="text-xs">{when(h.authorized_at)}</TableCell>
                    <TableCell className={cn("text-xs", soon && "font-semibold text-warning")} title={PHT_TIP}>
                      {when(h.capture_by)}{soon ? " · soon" : ""}
                    </TableCell>
                    <TableCell className="text-xs">
                      {h.action
                        ? <StatusPill label={h.action === "capture" ? "Capturing" : "Voiding"} tone="info" />
                        : "—"}
                      {h.action && h.action_started_at ? <span className="ml-1 text-muted-foreground">{ageLabel(h.action_started_at, now)}</span> : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Section>

        {/* Open card attempts */}
        <Section title="Card attempts still open" count={attempts.data?.length ?? 0} loading={attempts.isLoading} error={attempts.error}
          emptyText="No card attempt is waiting for Square's answer."
          hint="A card payment whose result is not known yet. square-reconcile asks Square and resolves them every hour; the order takes no other payment meanwhile.">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Reference</TableHead><TableHead>Order</TableHead><TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead><TableHead>Age</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {(attempts.data ?? []).map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-mono text-xs">{a.reference}</TableCell>
                  <TableCell className="font-mono text-xs">{orderRef(a.order)}{testPill(a.test)}</TableCell>
                  <TableCell className="text-right tabular-nums">{yen(a.amount_jpy)}</TableCell>
                  <TableCell><StatusPill label={a.status} tone={a.status === "unknown" ? "warning" : "info"} /></TableCell>
                  <TableCell className="text-xs" title={when(a.created_at)}>{ageLabel(a.created_at, now)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>

        {/* Captured, not recorded / exceptions */}
        <Section title="Captured, not recorded / exceptions" count={exceptions.data?.length ?? 0} loading={exceptions.isLoading} error={exceptions.error}
          emptyText="Nothing: every captured card payment is recorded."
          hint={<>Card money that needs a person. A capture with no exception code is finished with <span className="text-foreground">Finish recording</span> on Payment Submissions; an exception is resolved here once the money was handled.</>}>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Order</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Problem</TableHead>
              <TableHead>Since</TableHead><TableHead className="text-right">Action</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {(exceptions.data ?? []).map((x) => (
                <TableRow key={x.id}>
                  <TableCell className="font-mono text-xs">{orderRef(x.order)}{testPill(x.test)}</TableCell>
                  <TableCell className="text-right tabular-nums">{yen(x.captured_amount_jpy ?? x.amount_jpy)}</TableCell>
                  <TableCell className="text-xs">
                    <span className={cn(x.exception && "font-medium text-danger")}>{squareExceptionLabel(x.exception)}</span>
                    <span className="block">{squarePaymentStateLabel(x.status)}</span>
                    {x.exception_decision ? (
                      <span className="block text-muted-foreground">Decision: {decisionLabel("exception", x.exception_decision)} · not resolved yet</span>
                    ) : null}
                    {x.exception_note ? <span className="block text-muted-foreground">{x.exception_note}</span> : null}
                  </TableCell>
                  <TableCell className="text-xs">{when(x.exception_at ?? x.captured_at ?? x.created_at)}</TableCell>
                  <TableCell className="text-right">
                    {x.exception ? (
                      <Button size="sm" variant="outline" className="h-7"
                        onClick={() => openCase("exception", x.id, `${orderRef(x.order)} · ${squareExceptionLabel(x.exception)}`)}>
                        Decide…
                      </Button>
                    ) : <span className="text-xs text-muted-foreground">Finish recording</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>

        {/* Refunds */}
        <Section title={allRefunds ? "Refunds (recent)" : "Refunds awaiting a decision"} count={refunds.data?.length ?? 0}
          loading={refunds.isLoading} error={refunds.error}
          emptyText={allRefunds ? "No card refunds yet." : "No refund is waiting for a decision."}
          hint={
            <span className="flex flex-wrap items-center gap-2">
              Refunds are made in the Square Dashboard; record what was done with the order.
              <label className="inline-flex items-center gap-1.5 text-foreground">
                <Checkbox checked={allRefunds} onCheckedChange={(v) => setAllRefunds(v === true)} aria-label="Show all recent refunds" />
                Show all recent
              </label>
            </span>
          }>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Order</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Square status</TableHead>
              <TableHead>Created</TableHead><TableHead>Decision</TableHead><TableHead className="text-right">Action</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {(refunds.data ?? []).map((r) => {
                const failed = refundNotPaidBack(r.status);
                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{orderRef(r.order)}</TableCell>
                    <TableCell className="text-right tabular-nums">{yen(r.amount_jpy)}</TableCell>
                    <TableCell className="text-xs">
                      <StatusPill label={r.status} tone={failed ? "danger" : r.status === "COMPLETED" ? "success" : "info"} />
                      {failed && <span className="ml-1 font-medium text-danger">not paid back</span>}
                    </TableCell>
                    <TableCell className="text-xs">{when(r.created_at)}</TableCell>
                    <TableCell className="text-xs">{decisionLabel("refund", r.decision) ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      {!r.decided_at && (
                        <Button size="sm" variant="outline" className="h-7"
                          onClick={() => openCase("refund", r.id, `${orderRef(r.order)} · refund ${yen(r.amount_jpy)} (${r.status})`)}>
                          Record decision
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Section>

        {/* Disputes */}
        <Section title="Disputes" count={disputes.data?.length ?? 0} loading={disputes.isLoading} error={disputes.error}
          emptyText="No open dispute."
          hint={`Evidence is submitted in the Square Dashboard; record here what was done. Warning when the evidence is due in under ${DISPUTE_WARNING_DAYS} days.`}>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Order</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Reason</TableHead>
              <TableHead>State</TableHead><TableHead title={PHT_TIP}>Evidence due</TableHead><TableHead>Decision</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {(disputes.data ?? []).map((d) => {
                const closed = (DISPUTE_CLOSED_STATES as readonly string[]).includes(d.state);
                const soon = !closed && isDeadlineSoon(d.due_at, now, DISPUTE_WARNING_DAYS);
                return (
                  <TableRow key={d.id}>
                    <TableCell className="font-mono text-xs">{orderRef(d.order)}</TableCell>
                    <TableCell className="text-right tabular-nums">{yen(d.amount_jpy)}</TableCell>
                    <TableCell className="text-xs">{d.reason ?? "—"}</TableCell>
                    <TableCell><StatusPill label={d.state} tone={closed ? "muted" : "warning"} /></TableCell>
                    <TableCell className={cn("text-xs", soon && "font-semibold text-warning")} title={PHT_TIP}>
                      {when(d.due_at)}{soon ? " · soon" : ""}
                    </TableCell>
                    <TableCell className="text-xs">{decisionLabel("dispute", d.decision) ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" className="h-7"
                        onClick={() => openCase("dispute", d.id, `${orderRef(d.order)} · dispute ${yen(d.amount_jpy)} (${d.state})`)}>
                        Record decision
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Section>

        {/* Webhook problems */}
        <Section title="Webhook problems" count={webhooks.data?.length ?? 0} loading={webhooks.isLoading} error={webhooks.error}
          emptyText="No failed Square messages."
          hint="Square messages the Hub could not process yet. Failed and quarantined ones are retried automatically; dead ones stopped after 12 tries.">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Event</TableHead><TableHead>Status</TableHead><TableHead>Received</TableHead>
              <TableHead className="text-right">Tries</TableHead><TableHead>Last error</TableHead><TableHead>Next try</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {(webhooks.data ?? []).map((w) => (
                <TableRow key={w.event_id}>
                  <TableCell className="font-mono text-xs">{w.event_type}</TableCell>
                  <TableCell><StatusPill label={w.status} tone={w.status === "dead" ? "danger" : "warning"} /></TableCell>
                  <TableCell className="text-xs">{when(w.received_at)}</TableCell>
                  <TableCell className="text-right tabular-nums">{w.attempts}</TableCell>
                  <TableCell className="max-w-[16rem] truncate text-xs" title={w.last_error ?? undefined}>{w.last_error ?? "—"}</TableCell>
                  <TableCell className="text-xs">{w.status === "dead" ? "—" : when(w.next_attempt_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>

        {/* Settlement report */}
        <section className="space-y-2 border-t border-border/60 pt-4">
          <h3 className="text-sm font-semibold">Card activity (estimated)</h3>
          <p className="text-xs text-muted-foreground">
            Gross is what customers paid (invoice credit); the estimated net is after Square's fees as reported, completed refunds and
            lost disputes. This is NOT bank money: payouts, money Square holds during a dispute and fee adjustments are in the Square
            Dashboard. A fee Square has not reported yet counts as ¥0 (shown in the last column).
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="sq-report-from" className="text-xs">From (Japan date)</Label>
              <Input id="sq-report-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-[10.5rem]" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sq-report-to" className="text-xs">To (Japan date)</Label>
              <Input id="sq-report-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-[10.5rem]" />
            </div>
            <label className="inline-flex h-8 items-center gap-1.5 text-xs">
              <Checkbox checked={includeTest} onCheckedChange={(v) => setIncludeTest(v === true)} aria-label="Include test payments" />
              Include test payments
            </label>
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={downloadReport}
              disabled={!rangeOk || report.isLoading || !!report.error}>
              <Download className="h-3.5 w-3.5" /> Download CSV
            </Button>
          </div>
          {!rangeOk ? (
            <p className="text-xs text-destructive">Choose a start date on or before the end date.</p>
          ) : report.isLoading ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</p>
          ) : report.error ? (
            <p className="text-xs text-destructive">Could not read the report: {(report.error as Error)?.message ?? "unknown error"}</p>
          ) : (report.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No card money in this range.</p>
          ) : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>Day (Japan)</TableHead><TableHead className="text-right">Captures</TableHead>
                <TableHead className="text-right">Gross</TableHead><TableHead className="text-right">Square fees</TableHead>
                <TableHead className="text-right">Refunds done</TableHead><TableHead className="text-right">Refunds pending</TableHead>
                <TableHead className="text-right">Disputes lost</TableHead><TableHead className="text-right">Est. net</TableHead>
                <TableHead className="text-right" title="Captures whose Square fee is not reported yet">Fee pending</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {(report.data ?? []).map((r) => (
                  <TableRow key={r.day}>
                    <TableCell className="font-mono text-xs">{r.day}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(r.captures)}</TableCell>
                    <TableCell className="text-right tabular-nums">{yen(r.gross_jpy)}</TableCell>
                    <TableCell className="text-right tabular-nums">{yen(r.fees_jpy)}</TableCell>
                    <TableCell className="text-right tabular-nums">{yen(r.refunds_completed_jpy)}</TableCell>
                    <TableCell className="text-right tabular-nums">{yen(r.refunds_open_jpy)}</TableCell>
                    <TableCell className="text-right tabular-nums">{yen(r.disputes_lost_jpy)}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{yen(r.net_jpy)}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", Number(r.fees_missing ?? 0) > 0 && "text-warning")}>{Number(r.fees_missing ?? 0)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="font-semibold">Total</TableCell>
                  <TableCell className="text-right tabular-nums">{totals.captures}</TableCell>
                  <TableCell className="text-right tabular-nums">{yen(totals.gross_jpy)}</TableCell>
                  <TableCell className="text-right tabular-nums">{yen(totals.fees_jpy)}</TableCell>
                  <TableCell className="text-right tabular-nums">{yen(totals.refunds_completed_jpy)}</TableCell>
                  <TableCell className="text-right tabular-nums">{yen(totals.refunds_open_jpy)}</TableCell>
                  <TableCell className="text-right tabular-nums">{yen(totals.disputes_lost_jpy)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{yen(totals.net_jpy)}</TableCell>
                  <TableCell className="text-right tabular-nums">{totals.fees_missing}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          )}
        </section>
      </CardContent>

      <Dialog open={caseDialog !== null} onOpenChange={(o) => { if (!o && !decide.isPending) setCaseDialog(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {caseDialog?.kind === "exception" ? "Decide card exception" : caseDialog?.kind === "refund" ? "Record refund decision" : "Record dispute decision"}
            </DialogTitle>
            <DialogDescription>
              {caseDialog?.title}. This records what was decided; it moves no money.
              {caseDialog?.kind === "exception"
                ? " The order opens for another payment only when Square or the ledger shows the money was handled — recorded on the order, refunded in full, or the hold voided."
                : " It must match what Square reports for this case."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="sq-case-decision" className="text-xs">Decision</Label>
              <Select value={decision} onValueChange={setDecision}>
                <SelectTrigger id="sq-case-decision"><SelectValue placeholder="Choose…" /></SelectTrigger>
                <SelectContent>
                  {(caseDialog ? SQUARE_DECISIONS[caseDialog.kind] : []).map((d) => (
                    <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sq-case-note" className="text-xs">Note{noteNeeded ? " (required)" : " (optional)"}</Label>
              <Textarea id="sq-case-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCaseDialog(null)} disabled={decide.isPending}>Cancel</Button>
            <Button disabled={!canSubmit}
              onClick={() => caseDialog && decide.mutate({ kind: caseDialog.kind, id: caseDialog.id, decision, note: note.trim() })}>
              {decide.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save decision
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default SquareOperationsPanel;
