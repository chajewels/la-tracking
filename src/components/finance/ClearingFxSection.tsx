import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, ChevronLeft, ChevronRight, Loader2, Plus } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { callRpc } from "@/components/finance/useBookedMonths";
import { shiftMonth } from "@/components/finance/expenses";
import { LEDGER_JOURNALS_KEY, LEDGER_STATUS_KEY, LEDGER_TB_KEY, dayLabel, formatNative, formatYen, longMonth } from "@/components/finance/ledger";
import {
  CLEARING_KEY, FX_KEY, PROVIDERS, PROVIDER_LABEL, RATE_HISTORY_KEY, type MoneyAccount, type Provider, type SettlementForm, type TransferForm,
  clearingRefusal, emptySettlementForm, emptyTransferForm, fxLabel, normaliseClearing, normaliseFx, normaliseRateHistory, providerStatus,
  settlementPayload, settlementProblem, transferPayload, transferProblem, yenPerPeso,
} from "@/components/finance/clearing";

/**
 * Finance → Ledger → "Clearing & FX" (Expenses Phase 6, owner 2026-10-26). Clearing per provider with
 * "Record settlement…", own-account transfers with "Record transfer…", the month-end peso revaluation the
 * engine posts (read-only) and the rate history. Writing needs post_journal; reading view_ledger.
 */

function refusal(e: unknown, fallback: string) {
  const code = (e as { code?: string })?.code ?? "";
  toast({ title: clearingRefusal(code) || fallback, variant: "destructive" });
}

export default function ClearingFxSection({ thisMonth, today, onChanged }: { thisMonth: string; today: string; onChanged: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: CLEARING_KEY, staleTime: 15_000, queryFn: async () => normaliseClearing(await callRpc("get_clearing_summary", { p_months: 6 })) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: CLEARING_KEY }); qc.invalidateQueries({ queryKey: FX_KEY }); qc.invalidateQueries({ queryKey: RATE_HISTORY_KEY });
    qc.invalidateQueries({ queryKey: LEDGER_STATUS_KEY }); qc.invalidateQueries({ queryKey: LEDGER_JOURNALS_KEY }); qc.invalidateQueries({ queryKey: LEDGER_TB_KEY });
    onChanged();
  };
  const d = q.data;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base">Clearing — what the providers owe</CardTitle>
            {d?.can_post && <SettlementDialog today={today} ledgerStart={d.ledger_start} accounts={d.accounts} onDone={refresh} />}
          </div>
          <p className="text-xs text-muted-foreground">
            Card, Paidy and COD money sits in a clearing account from the moment the customer pays until the provider or courier pays it out. Square's fee is booked from each payment; Paidy's fees and the courier's charges come from the statement you record here.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {q.isLoading && <div className="text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin mr-2" />Loading…</div>}
          {q.isError && <div className="text-sm text-destructive">Could not load the clearing figures.</div>}
          {d && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="clearing-providers">
                  <thead className="text-xs text-muted-foreground">
                    <tr><th className="text-left py-1">Provider</th><th className="text-right">Captured</th><th className="text-right">Fees</th><th className="text-right">Refunds</th><th className="text-right">Paid out</th><th className="text-right">Still owed</th><th className="text-left pl-3">Status</th></tr>
                  </thead>
                  <tbody>
                    {d.providers.map((p) => (
                      <tr key={p.provider} className="border-t">
                        <td className="py-1">{PROVIDER_LABEL[p.provider]} <span className="text-xs text-muted-foreground">{p.account}</span></td>
                        <td className="text-right tabular-nums">{formatYen(p.captured_jpy)}</td>
                        <td className="text-right tabular-nums">{formatYen(p.fees_jpy)}</td>
                        <td className="text-right tabular-nums">{formatYen(p.refunds_jpy)}</td>
                        <td className="text-right tabular-nums">{formatYen(p.payouts_jpy)}</td>
                        <td className={`text-right tabular-nums font-medium ${p.balance_jpy < 0 ? "text-destructive" : ""}`}>{formatYen(p.balance_jpy)}</td>
                        <td className="pl-3 text-xs text-muted-foreground">{providerStatus(p).replace(/(\d{4}-\d{2}-\d{2})/, (m) => dayLabel(m))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="font-medium text-sm mb-1">Settlements recorded</div>
                {d.settlements.length === 0 && <p className="text-xs text-muted-foreground">None yet.</p>}
                <ul className="divide-y">
                  {d.settlements.map((s) => (
                    <li key={s.id} className={`py-2 flex flex-wrap items-center justify-between gap-2 text-sm ${s.voided_at ? "opacity-60" : ""}`} data-testid={`settlement-${s.id}`}>
                      <div className="min-w-0 space-y-0.5">
                        <p>
                          <span className="font-medium">{PROVIDER_LABEL[s.provider]}</span> · {dayLabel(s.received_on)}
                          {s.reference ? ` · ${s.reference}` : ""}
                          {s.voided_at && <Badge variant="outline" className="ml-2 line-through">voided</Badge>}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {s.amount_received_jpy > 0 ? `received ${formatYen(s.amount_received_jpy)} into ${s.bank_account}` : "no money received"}
                          {s.fees_jpy > 0 ? ` · fees ${formatYen(s.fees_jpy)}` : ""}
                          {s.adjustments_jpy !== 0 ? ` · adjustment ${formatYen(s.adjustments_jpy)}` : ""}
                          {s.period_from ? ` · period ${dayLabel(s.period_from)}${s.period_to ? ` – ${dayLabel(s.period_to)}` : ""}` : ""}
                          {s.note ? ` · ${s.note}` : ""}
                          {s.void_reason ? ` · void: ${s.void_reason}` : ""}
                        </p>
                      </div>
                      {d.can_post && !s.voided_at && <VoidButton rpc="void_provider_settlement" id={s.id} label="settlement" onDone={refresh} />}
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {d && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-base">Transfers between our accounts</CardTitle>
              {d.can_post && <TransferDialog today={today} ledgerStart={d.ledger_start} accounts={d.accounts} onDone={refresh} />}
            </div>
            <p className="text-xs text-muted-foreground">Remittances from Japan to the Philippines, bank to cash, and the like. The bank's fee goes to Payment and bank fees; the difference between what left and what arrived (at the Hub's one rate) is booked as an FX gain or loss.</p>
          </CardHeader>
          <CardContent>
            {d.transfers.length === 0 && <p className="text-xs text-muted-foreground">None yet.</p>}
            <ul className="divide-y">
              {d.transfers.map((t) => (
                <li key={t.id} className={`py-2 flex flex-wrap items-center justify-between gap-2 text-sm ${t.voided_at ? "opacity-60" : ""}`} data-testid={`transfer-${t.id}`}>
                  <div className="min-w-0 space-y-0.5">
                    <p className="flex flex-wrap items-center gap-2">
                      <span>{dayLabel(t.transfer_on)}</span>
                      <span className="font-medium">{t.from_account} → {t.to_account}</span>
                      {t.reference && <span className="text-muted-foreground">{t.reference}</span>}
                      {t.voided_at && <Badge variant="outline" className="line-through">voided</Badge>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      sent {formatNative(t.from_amount, t.from_currency)} · received {formatNative(t.to_amount, t.to_currency)}
                      {t.fee_amount > 0 ? ` · fee ${formatNative(t.fee_amount, t.fee_currency)}` : ""} · {fxLabel(t.fx_jpy)}
                      {t.note ? ` · ${t.note}` : ""}{t.void_reason ? ` · void: ${t.void_reason}` : ""}
                    </p>
                  </div>
                  {d.can_post && !t.voided_at && <VoidButton rpc="void_fund_transfer" id={t.id} label="transfer" onDone={refresh} />}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <FxCard thisMonth={thisMonth} />
    </div>
  );
}

function VoidButton({ rpc, id, label, onDone }: { rpc: "void_provider_settlement" | "void_fund_transfer"; id: string; label: string; onDone: () => void }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => callRpc(rpc, { p_id: id, p_reason: reason.trim() }),
    onSuccess: () => { toast({ title: `The ${label} was voided` }); setAsking(false); setReason(""); onDone(); },
    onError: (e) => refusal(e, `Could not void the ${label}`),
  });
  if (!asking) return <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setAsking(true)}>Void</Button>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input className="min-h-11 w-[220px]" aria-label="Reason" placeholder="Why? (≥ 3 characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <Button size="sm" className="min-h-11" disabled={reason.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>Confirm void</Button>
      <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setAsking(false)}>Cancel</Button>
    </div>
  );
}

function AccountSelect({ id, value, onChange, accounts, placeholder }: { id: string; value: string; onChange: (v: string) => void; accounts: MoneyAccount[]; placeholder: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="min-h-11"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {accounts.map((a) => <SelectItem key={a.code} value={a.code}>{a.code} · {a.name}{a.currency_hint ? ` (${a.currency_hint === "PHP" ? "₱" : "¥"})` : ""}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function SettlementDialog({ today, ledgerStart, accounts, onDone }: { today: string; ledgerStart: string | null; accounts: MoneyAccount[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<SettlementForm>(() => emptySettlementForm(today));
  const set = <K extends keyof SettlementForm>(k: K, v: SettlementForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const problem = settlementProblem(f, ledgerStart, today);
  const banks = accounts.filter((a) => a.code < "1130");
  const save = useMutation({
    mutationFn: () => callRpc("record_provider_settlement", { p: settlementPayload(f) }),
    onSuccess: () => { toast({ title: `${PROVIDER_LABEL[f.provider]} settlement recorded` }); setOpen(false); setF(emptySettlementForm(today)); onDone(); },
    onError: (e) => refusal(e, "Could not record the settlement"),
  });
  return (
    <>
      <Button size="sm" variant="outline" className="min-h-11" onClick={() => setOpen(true)} data-testid="record-settlement"><Plus className="h-4 w-4 mr-1" />Record settlement</Button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setF(emptySettlementForm(today)); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Record a settlement</DialogTitle>
            <DialogDescription>From the Square Dashboard payout, the Paidy monthly statement or the courier's COD remittance advice. The money received clears the provider's account; fees go to Payment and bank fees (courier charges to Carrier cost).</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="st-provider">Provider</Label>
              <Select value={f.provider} onValueChange={(v) => set("provider", v as Provider)}>
                <SelectTrigger id="st-provider" className="min-h-11"><SelectValue /></SelectTrigger>
                <SelectContent>{PROVIDERS.map((p) => <SelectItem key={p} value={p}>{PROVIDER_LABEL[p]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1"><Label htmlFor="st-on">Received on</Label><Input id="st-on" type="date" className="min-h-11" value={f.received_on} onChange={(e) => set("received_on", e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="st-amount">Amount received (¥)</Label><Input id="st-amount" inputMode="numeric" className="min-h-11" value={f.amount_received_jpy} onChange={(e) => set("amount_received_jpy", e.target.value)} placeholder="0 for a fee-only statement" /></div>
            <div className="space-y-1"><Label htmlFor="st-bank">Into which account</Label><AccountSelect id="st-bank" value={f.bank_account} onChange={(v) => set("bank_account", v)} accounts={banks} placeholder="Bank / cash account" /></div>
            <div className="space-y-1"><Label htmlFor="st-fees">Fees on the statement (¥)</Label><Input id="st-fees" inputMode="numeric" className="min-h-11" value={f.fees_jpy} onChange={(e) => set("fees_jpy", e.target.value)} placeholder={f.provider === "square" ? "Only fees not already on the payments" : "e.g. 3.5 % + ¥500 transfer fee"} /></div>
            <div className="space-y-1"><Label htmlFor="st-adj">Adjustment (¥, − deducted / + in our favour)</Label><Input id="st-adj" inputMode="numeric" className="min-h-11" value={f.adjustments_jpy} onChange={(e) => set("adjustments_jpy", e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="st-from">Statement period from</Label><Input id="st-from" type="date" className="min-h-11" value={f.period_from} onChange={(e) => set("period_from", e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="st-to">to</Label><Input id="st-to" type="date" className="min-h-11" value={f.period_to} onChange={(e) => set("period_to", e.target.value)} /></div>
            <div className="space-y-1 sm:col-span-2"><Label htmlFor="st-ref">Reference</Label><Input id="st-ref" className="min-h-11" value={f.reference} onChange={(e) => set("reference", e.target.value)} placeholder="Payout id, statement number, remittance advice" maxLength={120} /></div>
            <div className="space-y-1 sm:col-span-2"><Label htmlFor="st-note">Note</Label><Textarea id="st-note" rows={2} value={f.note} onChange={(e) => set("note", e.target.value)} maxLength={500} /></div>
          </div>
          {problem && (f.amount_received_jpy || f.fees_jpy || f.adjustments_jpy) && <p className="text-xs text-destructive">{problem}</p>}
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setOpen(false)}>Cancel</Button>
            <Button className="min-h-11" disabled={!!problem || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Record"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TransferDialog({ today, ledgerStart, accounts, onDone }: { today: string; ledgerStart: string | null; accounts: MoneyAccount[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<TransferForm>(() => emptyTransferForm(today));
  const set = <K extends keyof TransferForm>(k: K, v: TransferForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const pickAccount = (side: "from" | "to", code: string) => {
    const acct = accounts.find((a) => a.code === code);
    setF((x) => ({ ...x, [`${side}_account`]: code, ...(acct?.currency_hint ? { [`${side}_currency`]: acct.currency_hint } : {}) } as TransferForm));
  };
  const problem = transferProblem(f, ledgerStart, today);
  const save = useMutation({
    mutationFn: () => callRpc("record_fund_transfer", { p: transferPayload(f) }),
    onSuccess: () => { toast({ title: "Transfer recorded" }); setOpen(false); setF(emptyTransferForm(today)); onDone(); },
    onError: (e) => refusal(e, "Could not record the transfer"),
  });
  const Cur = ({ k }: { k: "from_currency" | "to_currency" | "fee_currency" }) => (
    <Select value={f[k]} onValueChange={(v) => set(k, v as "JPY" | "PHP")}>
      <SelectTrigger className="min-h-11 w-[84px]" aria-label="Currency"><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="JPY">¥</SelectItem><SelectItem value="PHP">₱</SelectItem></SelectContent>
    </Select>
  );
  return (
    <>
      <Button size="sm" variant="outline" className="min-h-11" onClick={() => setOpen(true)} data-testid="record-transfer"><ArrowRightLeft className="h-4 w-4 mr-1" />Record transfer</Button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setF(emptyTransferForm(today)); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Record a transfer between our accounts</DialogTitle>
            <DialogDescription>Enter what left one account and what arrived in the other, in each account's currency, plus the bank's fee. Nothing else is needed — the FX difference is worked out at the Hub's rate.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1 sm:col-span-2"><Label htmlFor="tf-on">Date</Label><Input id="tf-on" type="date" className="min-h-11 sm:w-1/2" value={f.transfer_on} onChange={(e) => set("transfer_on", e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="tf-from">From</Label><AccountSelect id="tf-from" value={f.from_account} onChange={(v) => pickAccount("from", v)} accounts={accounts} placeholder="Account the money left" /></div>
            <div className="space-y-1"><Label htmlFor="tf-from-amt">Amount sent</Label><div className="flex gap-2"><Input id="tf-from-amt" inputMode="decimal" className="min-h-11" value={f.from_amount} onChange={(e) => set("from_amount", e.target.value)} /><Cur k="from_currency" /></div></div>
            <div className="space-y-1"><Label htmlFor="tf-to">To</Label><AccountSelect id="tf-to" value={f.to_account} onChange={(v) => pickAccount("to", v)} accounts={accounts} placeholder="Account the money reached" /></div>
            <div className="space-y-1"><Label htmlFor="tf-to-amt">Amount received</Label><div className="flex gap-2"><Input id="tf-to-amt" inputMode="decimal" className="min-h-11" value={f.to_amount} onChange={(e) => set("to_amount", e.target.value)} /><Cur k="to_currency" /></div></div>
            <div className="space-y-1"><Label htmlFor="tf-fee">Bank fee (optional)</Label><div className="flex gap-2"><Input id="tf-fee" inputMode="decimal" className="min-h-11" value={f.fee_amount} onChange={(e) => set("fee_amount", e.target.value)} /><Cur k="fee_currency" /></div></div>
            <div className="space-y-1"><Label htmlFor="tf-ref">Reference</Label><Input id="tf-ref" className="min-h-11" value={f.reference} onChange={(e) => set("reference", e.target.value)} maxLength={120} /></div>
            <div className="space-y-1 sm:col-span-2"><Label htmlFor="tf-note">Note</Label><Textarea id="tf-note" rows={2} value={f.note} onChange={(e) => set("note", e.target.value)} maxLength={500} /></div>
          </div>
          {problem && (f.from_amount || f.to_amount) && <p className="text-xs text-destructive">{problem}</p>}
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setOpen(false)}>Cancel</Button>
            <Button className="min-h-11" disabled={!!problem || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Record"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function FxCard({ thisMonth }: { thisMonth: string }) {
  const [month, setMonth] = useState(thisMonth);
  const fx = useQuery({ queryKey: [...FX_KEY, month], staleTime: 15_000, queryFn: async () => normaliseFx(await callRpc("get_fx_revaluation", { p_month: `${month}-01` })) });
  const rates = useQuery({ queryKey: RATE_HISTORY_KEY, staleTime: 60_000, queryFn: async () => normaliseRateHistory(await callRpc("get_rate_history", {})) });
  const d = fx.data;
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">Peso revaluation at month end</CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" className="h-11 w-11" aria-label="Earlier month" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft className="h-4 w-4" /></Button>
            <span className="min-w-[150px] text-center text-sm font-medium">{longMonth(month)}</span>
            <Button variant="outline" size="icon" className="h-11 w-11" aria-label="Later month" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Every peso balance (Philippine banks, GCash, PH cash, the peso part of receivables and liabilities) is restated at the rate in effect on the last day of the month; the difference from what the books carried is posted as an unrealised FX gain or loss. The ledger does this itself — this is what it posts.
          {rates.data && <> Rate now: <strong>{yenPerPeso(rates.data.current)}</strong>{rates.data.history[0] ? ` since ${dayLabel(rates.data.history[0].effective_from)}` : ""}.</>}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {fx.isLoading && <div className="text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin mr-2" />Loading…</div>}
        {fx.isError && <div className="text-sm text-destructive">Could not load the revaluation.</div>}
        {d && (
          <>
            <p className="text-xs text-muted-foreground">Month-end rate {yenPerPeso(d.rate_used)}{!d.posted ? " · this month has not ended yet — figures are a preview" : ""}.</p>
            {d.rows.length === 0 && <p className="text-xs text-muted-foreground">No peso balances in the books up to this month.</p>}
            {d.rows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="fx-rows">
                  <thead className="text-xs text-muted-foreground">
                    <tr><th className="text-left py-1">Account</th><th className="text-right">Balance ₱</th><th className="text-right">Books ¥</th><th className="text-right">At month-end rate ¥</th><th className="text-right">This month's gain / loss</th></tr>
                  </thead>
                  <tbody>
                    {d.rows.map((r) => (
                      <tr key={r.account} className="border-t">
                        <td className="py-1">{r.account} · {r.name}</td>
                        <td className="text-right tabular-nums">{formatNative(r.native_php, "PHP")}</td>
                        <td className="text-right tabular-nums">{formatYen(r.carrying_jpy)}</td>
                        <td className="text-right tabular-nums">{formatYen(r.target_jpy)}</td>
                        <td className={`text-right tabular-nums font-medium ${r.increment_jpy < 0 ? "text-destructive" : ""}`}>{r.increment_jpy === 0 ? "—" : formatYen(r.increment_jpy)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {rates.data && rates.data.history.length > 0 && (
          <div>
            <div className="font-medium text-sm mb-1">Rate history</div>
            <ul className="text-xs text-muted-foreground space-y-0.5">
              {rates.data.history.slice(0, 8).map((h) => <li key={h.effective_from}>{dayLabel(h.effective_from)} — {yenPerPeso(h.rate)} (₱{h.rate} per ¥)</li>)}
            </ul>
            <p className="text-[11px] text-muted-foreground mt-1">Change the rate under Settings; it is logged here automatically.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
