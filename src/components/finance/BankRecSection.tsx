import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronLeft, ChevronRight, Loader2, Upload, Wand2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { callRpc } from "@/components/finance/useBookedMonths";
import { shiftMonth } from "@/components/finance/expenses";
import { LEDGER_COA_KEY, LEDGER_STATUS_KEY, dayLabel, formatNative, formatYen, ledgerRefusal, longMonth, normaliseAccounts, sourceTypeLabel } from "@/components/finance/ledger";
import {
  BANKREC_KEY, DEFAULT_PROFILE, READINESS_KEY, type BankRec, type ImportProfile, type ParsedStatement, type UnmatchedStatement,
  buildStatementLines, cashAdjustmentHint, controlsRefusal, decodeStatementBytes, expectedClosing, formatSigned, importPayload, monthStartOf, normaliseBankRec, parseCsvRows, sha256Hex, signOffBlockers, sniffDelimiter,
} from "@/components/finance/controls";

/**
 * Finance → Ledger → Bank rec (Expenses Phase 8, D3 / D4 / D6). One money account × one month: import the bank's own
 * CSV (parsed in the browser with a column map saved per account; Shift-JIS handled), auto-match same amount ± 3 days
 * when exactly one candidate on each side, one-tap manual match for the rest, ignore the bank's own fee / interest
 * lines with a reason, and sign the month off when the statement closing equals the ledger and nothing is left.
 * Cash accounts type the counted cash instead. Imports, matches and sign-offs need post_journal.
 */

function refusal(e: unknown, fallback: string) {
  const code = (e as { code?: string })?.code ?? "";
  toast({ title: controlsRefusal(code) || ledgerRefusal(code) || fallback, variant: "destructive" });
}

export default function BankRecSection({ thisMonth, initialMonth, initialAccount }: { thisMonth: string; initialMonth?: string | null; initialAccount?: string | null }) {
  const qc = useQueryClient();
  const [month, setMonth] = useState(initialMonth && /^\d{4}-\d{2}$/.test(initialMonth) ? initialMonth : shiftMonth(thisMonth, -1));
  const [account, setAccount] = useState(initialAccount ?? "");
  const coa = useQuery({ queryKey: [...LEDGER_COA_KEY, "money"], staleTime: 60_000, queryFn: async () => normaliseAccounts((await callRpc("get_chart_of_accounts", { p_as_of: null })).accounts) });
  const money = useMemo(() => (coa.data ?? []).filter((a) => a.kind === "asset" && a.active && a.code < "1130"), [coa.data]);
  useEffect(() => { if (!account && money.length > 0) setAccount(money.find((a) => a.code === "1101")?.code ?? money[0].code); }, [account, money]);
  useEffect(() => { if (initialMonth && /^\d{4}-\d{2}$/.test(initialMonth)) setMonth(initialMonth); }, [initialMonth]);
  useEffect(() => { if (initialAccount) setAccount(initialAccount); }, [initialAccount]);
  const q = useQuery<BankRec>({
    queryKey: [...BANKREC_KEY, account, month], staleTime: 10_000, enabled: !!account,
    queryFn: async () => normaliseBankRec(await callRpc("get_bank_reconciliation", { p_account: account, p_month: monthStartOf(month) })),
  });
  const refresh = () => { qc.invalidateQueries({ queryKey: BANKREC_KEY }); qc.invalidateQueries({ queryKey: LEDGER_STATUS_KEY }); qc.invalidateQueries({ queryKey: READINESS_KEY }); };
  const rec = q.data;

  const act = useMutation({
    mutationFn: (v: { fn: string; args: Record<string, unknown>; done: string }) => callRpc(v.fn, v.args).then((out) => ({ out, done: v.done })),
    onSuccess: ({ out, done }) => { toast({ title: done.replace("{n}", String(out.matched ?? "")) }); refresh(); },
    onError: (e) => refusal(e, "That did not work"),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base">Bank reconciliation</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={account} onValueChange={setAccount}>
                <SelectTrigger className="w-[260px] min-h-11" aria-label="Account"><SelectValue placeholder="Account" /></SelectTrigger>
                <SelectContent>{money.map((a) => <SelectItem key={a.code} value={a.code}>{a.code} {a.name}{a.name_ja ? ` · ${a.name_ja}` : ""}</SelectItem>)}</SelectContent>
              </Select>
              <Button variant="outline" size="icon" className="h-11 w-11" aria-label="Earlier month" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft className="h-4 w-4" /></Button>
              <span className="min-w-[150px] text-center text-sm font-medium">{longMonth(month)}</span>
              <Button variant="outline" size="icon" className="h-11 w-11" aria-label="Later month" onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= thisMonth}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {(q.isLoading || coa.isLoading) && <div className="text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin mr-2" />Loading…</div>}
          {q.isError && <div className="text-sm text-destructive">Could not load the reconciliation.</div>}
          {rec && <Header rec={rec} onChanged={refresh} />}
          {rec && !rec.is_cash && rec.can_post && (
            <div className="flex flex-wrap gap-2">
              <ImportDialog rec={rec} onDone={refresh} />
              <Button size="sm" variant="outline" className="min-h-11" onClick={() => act.mutate({ fn: "auto_match_bank_lines", args: { p_account: rec.account, p_month: rec.month }, done: "Matched {n} line(s)" })} disabled={act.isPending}>
                <Wand2 className="h-4 w-4 mr-1" />Match again
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {rec && !rec.is_cash && (
        <>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Not in the Hub — statement lines without a Hub entry ({rec.unmatched_statement.length})</CardTitle></CardHeader>
            <CardContent>
              {rec.unmatched_statement.length === 0 ? <p className="text-sm text-muted-foreground">Every statement line this month has its Hub entry{rec.matched_count ? ` (${rec.matched_count} matched)` : ""}.</p> : (
                <ul className="divide-y text-sm">
                  {rec.unmatched_statement.map((l) => <StatementLineRow key={l.id} l={l} rec={rec} canPost={rec.can_post} busy={act.isPending} onMatch={(jl) => act.mutate({ fn: "match_bank_line", args: { p_line: l.id, p_journal_line: jl }, done: "Matched" })} onIgnore={(reason) => act.mutate({ fn: "ignore_bank_line", args: { p_line: l.id, p_reason: reason }, done: "Line set aside" })} />)}
                </ul>
              )}
              <p className="text-xs text-muted-foreground mt-2">A line the Hub has no entry for is usually a bank fee or interest (set it aside with a reason and book it as an expense), a transfer between your own accounts (Clearing &amp; FX → Record transfer), a provider payout (Clearing &amp; FX → Record payout) or a payment that was never recorded.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Not yet on the bank — Hub entries without a statement line ({rec.unmatched_ledger.length})</CardTitle></CardHeader>
            <CardContent>
              {rec.unmatched_ledger.length === 0 ? <p className="text-sm text-muted-foreground">Every Hub entry this month is on the statement.</p> : (
                <ul className="divide-y text-sm">
                  {rec.unmatched_ledger.map((l) => (
                    <li key={l.journal_line_id} className="flex flex-wrap items-center justify-between gap-2 py-2 min-h-[44px]">
                      <div>
                        <span className="text-muted-foreground mr-2">{dayLabel(l.entry_date)}</span>#{l.journal_no} · {sourceTypeLabel(l.source_type)} · {l.description}{l.memo ? <span className="text-muted-foreground"> · {l.memo}</span> : null}
                        {l.account_id ? <Link className="text-primary underline text-xs ml-2" to={`/accounts/${l.account_id}`}>Open plan</Link> : l.cash_order_id ? <Link className="text-primary underline text-xs ml-2" to={`/cash-orders/${l.cash_order_id}`}>Open order</Link> : l.expense_id ? <Link className="text-primary underline text-xs ml-2" to={`/finance?tab=expenses&month=${l.entry_date.slice(0, 7)}`}>Open expenses</Link> : null}
                      </div>
                      <span className={`tabular-nums font-medium ${l.signed_amount < 0 ? "text-destructive" : ""}`}>{formatSigned(l.signed_amount, rec.currency)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground mt-2">Normal for the last days of the month (the bank books it next month). An older one usually means the payment was recorded on the wrong account or with the wrong amount.</p>
            </CardContent>
          </Card>
          {(rec.ignored.length > 0 || rec.imports.length > 0) && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Set aside and imports</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {rec.ignored.map((l) => (
                  <div key={l.id} className="flex flex-wrap items-center justify-between gap-2 border-t py-1">
                    <span><span className="text-muted-foreground mr-2">{dayLabel(l.booked_on)}</span>{l.description} · {formatSigned(l.amount, rec.currency)} <span className="text-muted-foreground">— {l.reason}</span></span>
                    {rec.can_post && rec.reconciliation?.status !== "reconciled" && <Button size="sm" variant="ghost" className="min-h-11" onClick={() => act.mutate({ fn: "unmatch_bank_line", args: { p_line: l.id }, done: "Back in the list" })}>Undo</Button>}
                  </div>
                ))}
                {rec.imports.map((i) => (
                  <div key={i.id} className={`flex flex-wrap items-center justify-between gap-2 border-t py-1 ${i.voided_at ? "opacity-60" : ""}`}>
                    <span><Upload className="inline h-3 w-3 mr-1" />{i.file_name} · {i.inserted} line{i.inserted === 1 ? "" : "s"}{i.skipped ? `, ${i.skipped} already known` : ""}{i.period_from ? ` · ${dayLabel(i.period_from)} – ${dayLabel(i.period_to ?? i.period_from)}` : ""}{i.voided_at ? ` · removed (${i.void_reason})` : ""}</span>
                    {rec.can_post && !i.voided_at && <VoidImportButton id={i.id} onDone={refresh} />}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Header({ rec, onChanged }: { rec: BankRec; onChanged: () => void }) {
  const [closing, setClosing] = useState(rec.statement_closing == null ? "" : String(rec.statement_closing));
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => { setClosing(rec.statement_closing == null ? "" : String(rec.statement_closing)); }, [rec.statement_closing, rec.account, rec.month]);
  const typed = closing.trim() === "" ? null : Number(closing.replace(/[,\s¥₱]/g, ""));
  const expected = expectedClosing(rec);
  const blockers = signOffBlockers(rec, Number.isNaN(typed) ? null : typed);
  const done = rec.reconciliation?.status === "reconciled";
  const signOff = useMutation({
    mutationFn: () => callRpc("sign_off_reconciliation", { p_account: rec.account, p_month: rec.month, p_statement_closing: typed, p_note: note.trim() || null }),
    onSuccess: () => { toast({ title: `${rec.name} · ${longMonth(rec.month.slice(0, 7))} reconciled` }); onChanged(); },
    onError: (e) => refusal(e, "Could not sign off"),
  });
  const reopen = useMutation({
    mutationFn: () => callRpc("reopen_reconciliation", { p_account: rec.account, p_month: rec.month, p_reason: reason.trim() }),
    onSuccess: () => { toast({ title: "Reopened" }); setReason(""); onChanged(); },
    onError: (e) => refusal(e, "Could not reopen"),
  });
  const hint = rec.is_cash && typed != null && !Number.isNaN(typed) ? cashAdjustmentHint(rec, typed) : null;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
        <div className="rounded-md border p-2"><div className="text-xs text-muted-foreground">Ledger at {dayLabel(rec.month_end)}</div><div className="tabular-nums font-semibold">{formatNative(rec.ledger_closing_native, rec.currency)}</div>
          {rec.currency === "PHP" && <div className="text-[11px] text-muted-foreground">{formatYen(rec.ledger_closing_jpy)} in the books</div>}
          {!rec.is_cash && rec.in_transit_native !== 0 && <div className="text-[11px] text-muted-foreground">{formatSigned(rec.in_transit_native, rec.currency)} in transit (last 5 days, not on the bank yet) → bank should show {formatNative(expected, rec.currency)}</div>}</div>
        <div className="rounded-md border p-2">
          <Label className="text-xs text-muted-foreground" htmlFor="stmt-closing">{rec.is_cash ? "Counted cash" : "Statement closing"}</Label>
          {done ? <div className="tabular-nums font-semibold">{formatNative(rec.reconciliation?.statement_closing ?? 0, rec.currency)}</div>
            : <Input id="stmt-closing" inputMode="decimal" className="min-h-11" value={closing} onChange={(e) => setClosing(e.target.value)} placeholder={rec.is_cash ? "What is in the drawer" : "From the statement"} disabled={!rec.can_post} />}
          {!done && rec.statement_closing_source === "statement" && <div className="text-[11px] text-muted-foreground">from the last statement line</div>}
        </div>
        <div className="rounded-md border p-2"><div className="text-xs text-muted-foreground">Difference</div><div className={`tabular-nums font-semibold ${typed != null && !Number.isNaN(typed) && Math.round((typed - expected) * 100) !== 0 ? "text-destructive" : ""}`}>{typed == null || Number.isNaN(typed) ? "—" : formatSigned(typed - expected, rec.currency)}</div></div>
        <div className="rounded-md border p-2"><div className="text-xs text-muted-foreground">Status</div>
          <div className="flex items-center gap-1 font-medium">{done ? <><CheckCircle2 className="h-4 w-4 text-success" />Reconciled</> : rec.reconciliation ? "Open — attempted" : "Open"}</div>
          {done && rec.reconciliation?.reconciled_at && <div className="text-[11px] text-muted-foreground">{new Date(rec.reconciliation.reconciled_at).toLocaleDateString("en-GB", { timeZone: "Asia/Tokyo" })}{rec.reconciliation.note ? ` · ${rec.reconciliation.note}` : ""}</div>}
        </div>
      </div>
      {!done && rec.can_post && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="grow max-w-md"><Label className="text-xs" htmlFor="rec-note">Note (optional)</Label><Input id="rec-note" className="min-h-11" value={note} onChange={(e) => setNote(e.target.value)} placeholder={rec.is_cash ? "Counted by …" : "Statement page, remarks"} /></div>
          <Button className="min-h-11" disabled={blockers.length > 0 || signOff.isPending} onClick={() => signOff.mutate()}>{signOff.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}Reconciled</Button>
          {blockers.length > 0 && <ul className="text-xs text-muted-foreground basis-full">{blockers.map((b) => <li key={b}>· {b}</li>)}</ul>}
          {hint && <p className="text-xs basis-full rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-2">{hint} Post it under Journals → New manual journal; nothing is posted automatically.</p>}
        </div>
      )}
      {done && rec.can_post && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="grow max-w-md"><Label className="text-xs" htmlFor="rec-reopen">Reopen — why?</Label><Input id="rec-reopen" className="min-h-11" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="At least 3 characters" /></div>
          <Button variant="outline" className="min-h-11" disabled={reason.trim().length < 3 || reopen.isPending} onClick={() => reopen.mutate()}>Reopen</Button>
        </div>
      )}
      {rec.is_cash && <p className="text-xs text-muted-foreground">Cash has no statement: count the drawer at month end and type it. A difference is shown, never posted for you.</p>}
    </div>
  );
}

function StatementLineRow({ l, rec, canPost, busy, onMatch, onIgnore }: { l: UnmatchedStatement; rec: BankRec; canPost: boolean; busy: boolean; onMatch: (jl: string) => void; onIgnore: (reason: string) => void }) {
  const [ignoring, setIgnoring] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <li className="py-2 space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2 min-h-[44px]">
        <div><span className="text-muted-foreground mr-2">{dayLabel(l.booked_on)}</span>{l.description || <span className="text-muted-foreground">(no description)</span>}</div>
        <div className="flex items-center gap-2">
          <span className={`tabular-nums font-medium ${l.amount < 0 ? "text-destructive" : ""}`}>{formatSigned(l.amount, rec.currency)}</span>
          {canPost && !ignoring && <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setIgnoring(true)}>Set aside</Button>}
        </div>
      </div>
      {l.candidates.length > 0 && canPost && (
        <div className="flex flex-wrap gap-2 pl-4">
          {l.candidates.map((c) => (
            <Button key={c.journal_line_id} size="sm" variant="outline" className="min-h-11" disabled={busy} onClick={() => onMatch(c.journal_line_id)}>
              Match #{c.journal_no} · {dayLabel(c.entry_date)} · {sourceTypeLabel(c.source_type)}{c.memo ? ` · ${c.memo}` : ""}
            </Button>
          ))}
        </div>
      )}
      {l.candidates.length === 0 && <div className="pl-4 text-xs text-muted-foreground">No Hub entry for this amount within a month of this date.</div>}
      {ignoring && (
        <div className="flex flex-wrap items-center gap-2 pl-4">
          <Input className="min-h-11 w-[280px]" aria-label="Why set aside" placeholder="Bank fee / interest / duplicate…" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button size="sm" className="min-h-11" disabled={reason.trim().length < 3 || busy} onClick={() => { onIgnore(reason.trim()); setIgnoring(false); setReason(""); }}>Confirm</Button>
          <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setIgnoring(false)}>Cancel</Button>
        </div>
      )}
    </li>
  );
}

function VoidImportButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [reason, setReason] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => callRpc("void_bank_import", { p_import: id, p_reason: reason ?? "" }),
    onSuccess: () => { toast({ title: "Import removed" }); setReason(null); onDone(); },
    onError: (e) => refusal(e, "Could not remove the import"),
  });
  if (reason === null) return <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setReason("")}>Remove</Button>;
  return (
    <span className="inline-flex items-center gap-1">
      <Input className="min-h-11 w-[200px]" aria-label="Why remove" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      <Button size="sm" className="min-h-11" disabled={reason.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>Confirm</Button>
      <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setReason(null)}>Cancel</Button>
    </span>
  );
}

const COLS = ["date_col", "description_col", "in_col", "out_col", "signed_col", "balance_col"] as const;
const COL_LABEL: Record<(typeof COLS)[number], string> = { date_col: "Date", description_col: "Description", in_col: "Money in", out_col: "Money out", signed_col: "Signed amount (+/−)", balance_col: "Balance after" };

function ImportDialog({ rec, onDone }: { rec: BankRec; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array; text: string; encoding: "utf-8" | "shift_jis" } | null>(null);
  const [profile, setProfile] = useState<ImportProfile>(rec.profile ?? DEFAULT_PROFILE);
  const openDialog = () => { setProfile(rec.profile ?? DEFAULT_PROFILE); setFile(null); setOpen(true); };
  const rows = useMemo(() => (file ? parseCsvRows(file.text, profile.delimiter) : []), [file, profile.delimiter]);
  const parsed: ParsedStatement | null = useMemo(() => (file ? buildStatementLines(rows, profile) : null), [rows, profile, file]);
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const imp = useMutation({
    mutationFn: async () => {
      if (!file || !parsed) throw new Error("no file");
      const sha = await sha256Hex(file.bytes);
      return callRpc("import_bank_statement", { p: importPayload(rec.account, file.name, sha, { ...profile, encoding: file.encoding }, parsed) });
    },
    onSuccess: (out) => { toast({ title: `${out.inserted} line${Number(out.inserted) === 1 ? "" : "s"} imported${Number(out.skipped) ? `, ${out.skipped} already known` : ""}${Number(out.auto_matched) ? ` · ${out.auto_matched} matched` : ""}` }); setOpen(false); setFile(null); onDone(); },
    onError: (e) => refusal(e, "Import failed"),
  });
  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast({ title: "That file is over 5 MB — export one month at a time.", variant: "destructive" }); return; }
    const bytes = new Uint8Array(await f.arrayBuffer());
    const { text, encoding } = decodeStatementBytes(bytes);
    setFile({ name: f.name, bytes, text, encoding });
    if (!rec.profile) setProfile((p) => ({ ...p, delimiter: sniffDelimiter(text), encoding }));
  };
  const setCol = (k: (typeof COLS)[number], v: string) => setProfile((p) => ({ ...p, [k]: v === "none" ? null : Number(v) }));
  const amountOk = profile.signed_col != null || profile.in_col != null || profile.out_col != null;
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setFile(null); }}>
      <Button size="sm" className="min-h-11" onClick={openDialog}><Upload className="h-4 w-4 mr-1" />Import statement</Button>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import {rec.name} statement</DialogTitle>
          <DialogDescription>The bank's own CSV export. The file is read in your browser; only the lines are stored. Say which column is which once — it is remembered for this account.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <Input type="file" accept=".csv,.txt,text/csv,text/plain" className="min-h-11" aria-label="Statement file" onChange={(e) => pick(e.target.files?.[0])} />
          {file && (
            <>
              <div className="text-xs text-muted-foreground">{file.name} · {rows.length} row{rows.length === 1 ? "" : "s"} · {file.encoding === "shift_jis" ? "Shift-JIS (Japanese bank)" : "UTF-8"} · {width} column{width === 1 ? "" : "s"}</div>
              <div className="overflow-x-auto rounded-md border">
                <table className="text-xs">
                  <thead><tr>{Array.from({ length: width }).map((_, i) => <th key={i} className="px-2 py-1 text-left text-muted-foreground border-b">col {i + 1}</th>)}</tr></thead>
                  <tbody>{rows.slice(0, 6).map((r, ri) => <tr key={ri} className={ri < profile.header_rows ? "opacity-50" : ""}>{Array.from({ length: width }).map((_, i) => <td key={i} className="px-2 py-1 whitespace-nowrap border-b">{r[i] ?? ""}</td>)}</tr>)}</tbody>
                </table>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <div><Label className="text-xs">Separator</Label>
                  <Select value={profile.delimiter} onValueChange={(v) => setProfile((p) => ({ ...p, delimiter: v as ImportProfile["delimiter"] }))}>
                    <SelectTrigger className="min-h-11" aria-label="Separator"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value=",">Comma</SelectItem><SelectItem value=";">Semicolon</SelectItem><SelectItem value={"\t"}>Tab</SelectItem></SelectContent>
                  </Select></div>
                <div><Label className="text-xs" htmlFor="hdr-rows">Header rows</Label><Input id="hdr-rows" inputMode="numeric" className="min-h-11" value={profile.header_rows} onChange={(e) => setProfile((p) => ({ ...p, header_rows: Math.max(0, Math.min(20, Number(e.target.value.replace(/\D/g, "")) || 0)) }))} /></div>
                <div><Label className="text-xs">Date order</Label>
                  <Select value={profile.date_format} onValueChange={(v) => setProfile((p) => ({ ...p, date_format: v as ImportProfile["date_format"] }))}>
                    <SelectTrigger className="min-h-11" aria-label="Date order"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="ymd">Year / month / day</SelectItem><SelectItem value="dmy">Day / month / year</SelectItem><SelectItem value="mdy">Month / day / year</SelectItem></SelectContent>
                  </Select></div>
                {COLS.map((k) => (
                  <div key={k}><Label className="text-xs">{COL_LABEL[k]}</Label>
                    <Select value={profile[k] == null ? "none" : String(profile[k])} onValueChange={(v) => setCol(k, v)}>
                      <SelectTrigger className="min-h-11" aria-label={COL_LABEL[k]}><SelectValue /></SelectTrigger>
                      <SelectContent>{k !== "date_col" && <SelectItem value="none">—</SelectItem>}{Array.from({ length: width }).map((_, i) => <SelectItem key={i} value={String(i)}>col {i + 1}{rows[0]?.[i] ? ` (${rows[0][i].slice(0, 14)})` : ""}</SelectItem>)}</SelectContent>
                    </Select></div>
                ))}
              </div>
              {!amountOk && <p className="text-xs text-destructive">Pick a Money in / Money out pair or a signed amount column.</p>}
              {parsed && (
                <div className="rounded-md border p-2 text-xs">
                  <div>{parsed.lines.length} line{parsed.lines.length === 1 ? "" : "s"} ready{parsed.skipped_rows ? ` · ${parsed.skipped_rows} empty row${parsed.skipped_rows === 1 ? "" : "s"} skipped` : ""}{parsed.problems.length ? ` · ${parsed.problems.length} row${parsed.problems.length === 1 ? "" : "s"} could not be read` : ""}</div>
                  {parsed.lines.slice(0, 3).map((l, i) => <div key={i} className="text-muted-foreground">{l.booked_on} · {l.description.slice(0, 40)} · {formatSigned(l.amount, rec.currency)}{l.balance_after != null ? ` · bal ${l.balance_after.toLocaleString("en-US")}` : ""}</div>)}
                  {parsed.problems.slice(0, 5).map((p) => <div key={p.row} className="text-destructive">Row {p.row}: {p.reason}</div>)}
                  {parsed.problems.length > 5 && <div className="text-destructive">…and {parsed.problems.length - 5} more</div>}
                  {parsed.problems.length > 0 && <div className="text-destructive mt-1">Fix the column map (or the header-row count) until every row reads — a statement with rows missing can never tie.</div>}
                </div>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" className="min-h-11" onClick={() => setOpen(false)}>Cancel</Button>
          <Button className="min-h-11" disabled={!file || !parsed || parsed.lines.length === 0 || parsed.problems.length > 0 || !amountOk || imp.isPending} onClick={() => imp.mutate()}>{imp.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Upload className="h-4 w-4 mr-1" />}Import {parsed?.lines.length ?? ""} line{parsed?.lines.length === 1 ? "" : "s"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
