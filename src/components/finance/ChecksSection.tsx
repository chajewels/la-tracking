import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Play, XCircle } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { callRpc } from "@/components/finance/useBookedMonths";
import { LEDGER_STATUS_KEY, ledgerRefusal } from "@/components/finance/ledger";
import { CHECKS_KEY, CHECK_KIND_LABEL, type CheckIssue, controlsRefusal, groupIssues, issueHref, lastCheckLabel, normaliseChecks } from "@/components/finance/controls";

/**
 * Finance → Ledger → Checks (Expenses Phase 8, D5). The nightly completeness check (01:10 JST) and "Run check now":
 * errors are what the engine cannot fix on its own (unposted / orphan events, a failed run, a duplicate or unbalanced
 * journal, a trial balance that is off); warnings are housekeeping (open months, suspense, unmapped spellings,
 * expenses without Paid from, old drafts, accounts not reconciled). The bell that staff see carries counts only.
 */
export default function ChecksSection() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: CHECKS_KEY, staleTime: 15_000,
    queryFn: async () => normaliseChecks(await callRpc("get_ledger_checks", { p_limit: 30 })),
  });
  const run = useMutation({
    mutationFn: () => callRpc("run_ledger_check"),
    onSuccess: (out) => {
      const e = Number(out.errors ?? 0); const w = Number(out.warnings ?? 0);
      toast({ title: e + w === 0 ? "All clear" : `${e} error${e === 1 ? "" : "s"}, ${w} warning${w === 1 ? "" : "s"}` });
      qc.invalidateQueries({ queryKey: CHECKS_KEY }); qc.invalidateQueries({ queryKey: LEDGER_STATUS_KEY });
    },
    onError: (e) => { const code = (e as { code?: string })?.code ?? ""; toast({ title: controlsRefusal(code) || ledgerRefusal(code) || "The check could not run", variant: "destructive" }); },
  });
  const d = q.data;
  const latest = d?.latest ?? null;
  const groups = groupIssues(latest?.issues ?? []);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Ledger checks</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">Runs every night at 01:10 after the posting run. {latest ? lastCheckLabel(latest) : ""}</p>
            </div>
            {d?.can_post && (
              <Button size="sm" className="min-h-11" onClick={() => run.mutate()} disabled={run.isPending}>
                {run.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Play className="h-4 w-4 mr-1" />}Run check now
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {q.isLoading && <div className="text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin mr-2" />Loading…</div>}
          {q.isError && <div className="text-sm text-destructive">Could not load the checks.</div>}
          {d && !latest && <p className="text-sm text-muted-foreground">No check has run yet. It runs tonight, or press Run check now.</p>}
          {latest && groups.errors.length === 0 && groups.warnings.length === 0 && (
            <div className="flex items-center gap-2 text-sm text-success"><CheckCircle2 className="h-4 w-4" />Everything the engine should have posted is posted, every journal balances, and nothing is waiting.</div>
          )}
          {groups.errors.length > 0 && <IssueList title="Needs attention before any month can close" issues={groups.errors} tone="error" />}
          {groups.warnings.length > 0 && <IssueList title="Housekeeping" issues={groups.warnings} tone="warning" />}
        </CardContent>
      </Card>
      {d && d.runs.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">History</CardTitle></CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground"><tr><th className="text-left py-1">When</th><th className="text-left py-1">Run by</th><th className="text-right py-1">Errors</th><th className="text-right py-1">Warnings</th><th className="text-right py-1">Bell</th></tr></thead>
              <tbody>
                {d.runs.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="py-1">{new Date(r.ran_at).toLocaleString("en-GB", { timeZone: "Asia/Tokyo", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                    <td className="py-1 text-muted-foreground">{r.trigger === "cron" ? "nightly" : "by hand"}</td>
                    <td className={`py-1 text-right tabular-nums ${r.errors ? "text-destructive font-medium" : ""}`}>{r.errors}</td>
                    <td className="py-1 text-right tabular-nums">{r.warnings}</td>
                    <td className="py-1 text-right">{r.bell_rung ? <Badge variant="outline">rang</Badge> : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function IssueList({ title, issues, tone }: { title: string; issues: CheckIssue[]; tone: "error" | "warning" }) {
  return (
    <div className={`rounded-md border p-3 text-sm ${tone === "error" ? "border-destructive/40 bg-destructive/5" : "border-amber-300 bg-amber-50 dark:bg-amber-950/30"}`}>
      <div className="flex items-center gap-2 font-medium">{tone === "error" ? <XCircle className="h-4 w-4 text-destructive" /> : <AlertTriangle className="h-4 w-4 text-amber-600" />}{title} ({issues.length})</div>
      <ul className="mt-2 space-y-2">
        {issues.map((i, idx) => (
          <li key={`${i.kind}-${i.ref ?? idx}`} className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div>{i.label}</div>
              <div className="text-xs text-muted-foreground">{CHECK_KIND_LABEL[i.kind]?.action ?? ""}</div>
            </div>
            <Button asChild size="sm" variant="ghost" className="min-h-11"><Link to={issueHref(i)}>Open</Link></Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
