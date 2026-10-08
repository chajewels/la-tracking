import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MailWarning } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/hooks/use-toast";
import { formatPHTDisplay } from "@/lib/date-utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  STAFF_BELL_EMAILS_KEY, STAFF_BELL_EMAIL_CHOICES, type StaffBellEmailsState,
  invalidAddresses, parseAddresses, staffBellEmailsRefusal,
} from "@/components/settings/staff-bell-emails";

/**
 * Website → Settings → Staff bell emails (V11b, owner 2026-10-08). The bell
 * stays in the Hub for every member; the ticked types are ALSO emailed to the
 * addresses below plus every active user holding one of the roles (default
 * Brenda + admins). ADMIN ONLY to change — re-checked server-side by
 * set_staff_bell_emails, which writes the audit row; a trigger refuses every
 * other write. Neither RPC is in types.ts yet — hence the casts.
 */

const ROLE_CHOICES = ["admin", "finance", "staff", "csr"] as const;

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

export function StaffBellEmailsCard() {
  const qc = useQueryClient();
  const { roles } = useAuth();
  const isAdmin = !!roles?.includes("admin");
  const [types, setTypes] = useState<string[]>([]);
  const [roleSel, setRoleSel] = useState<string[]>([]);
  const [addrText, setAddrText] = useState("");

  const state = useQuery<StaffBellEmailsState>({
    queryKey: STAFF_BELL_EMAILS_KEY,
    queryFn: async () => (await callRpc("get_staff_bell_emails")) as unknown as StaffBellEmailsState,
    staleTime: 30_000,
  });
  const data = state.data;

  useEffect(() => {
    if (data) {
      setTypes(data.types ?? []);
      setRoleSel(data.roles ?? []);
      setAddrText((data.addresses ?? []).join("\n"));
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => callRpc("set_staff_bell_emails", {
      p_types: types, p_addresses: parseAddresses(addrText), p_roles: roleSel,
    }),
    onSuccess: (out) => {
      const rc = (out.resolved_recipients as string[] | undefined) ?? [];
      toast({
        title: out.changed ? "Staff bell emails saved" : "Nothing changed",
        description: rc.length ? `Emails go to: ${rc.join(", ")}` : "No recipient resolves — nobody will be emailed.",
      });
    },
    onError: (e: Error & { code?: string; entry?: string }) => {
      toast({ title: "Not changed", description: staffBellEmailsRefusal(e.code ?? e.message, e.entry), variant: "destructive" });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: STAFF_BELL_EMAILS_KEY }),
  });

  const canChange = isAdmin && data?.can_change !== false;
  const addrs = parseAddresses(addrText);
  const badAddrs = invalidAddresses(addrs);
  const dirty = !!data && (
    [...types].sort().join(",") !== [...(data.types ?? [])].sort().join(",")
    || [...roleSel].sort().join(",") !== [...(data.roles ?? [])].sort().join(",")
    || addrs.join("\n") !== (data.addresses ?? []).join("\n")
  );
  const extraTypes = (data?.types ?? []).filter((t) => !STAFF_BELL_EMAIL_CHOICES.some((c) => c.type === t));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <MailWarning className="h-4 w-4 text-primary" />
          Staff bell emails
          {data && (
            <Badge variant={(data.types ?? []).length > 0 ? "default" : "secondary"} data-testid="staff-bell-emails-state">
              {(data.types ?? []).length} bell type{(data.types ?? []).length === 1 ? "" : "s"} emailed
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Every bell stays in the Hub for every member. The types ticked here are also sent as an email,
          once per bell, to the addresses below plus every active user holding one of the ticked roles.
        </p>
        {state.isLoading && (
          <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        )}
        {state.isError && (
          <p className="text-destructive" data-testid="staff-bell-emails-read-error">Could not read the setting.</p>
        )}
        {data && !data.found && (
          <p className="text-destructive">The setting is missing — the staff-bell-emails migration is not applied.</p>
        )}
        {data && data.found && (
          <>
            <p className="text-xs text-muted-foreground" data-testid="staff-bell-emails-summary">
              Emails go to: {(data.resolved_recipients ?? []).join(", ") || "nobody"}.
              {" "}{data.sent_7d} sent in the last 7 days · {data.pending} waiting · {data.failed_7d} failed.
              {data.updated_by_name ? <> Last changed {data.updated_at ? formatPHTDisplay(data.updated_at) : ""} by {data.updated_by_name}.</> : null}
            </p>

            <div className="space-y-2">
              <Label className="text-xs">Bell types that are emailed</Label>
              {STAFF_BELL_EMAIL_CHOICES.map((c) => (
                <div key={c.type} className="flex items-start gap-2">
                  <Checkbox
                    id={`staff-bell-type-${c.type}`}
                    checked={types.includes(c.type)}
                    disabled={!canChange || save.isPending}
                    onCheckedChange={(v) => setTypes((cur) => v ? Array.from(new Set([...cur, c.type])) : cur.filter((t) => t !== c.type))}
                  />
                  <Label htmlFor={`staff-bell-type-${c.type}`} className="text-xs font-normal leading-5">
                    {c.label} <span className="text-muted-foreground">({c.type})</span>
                  </Label>
                </div>
              ))}
              {extraTypes.length > 0 && (
                <p className="text-xs text-muted-foreground">Also on the list (set elsewhere): {extraTypes.join(", ")}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Roles whose active members are emailed</Label>
              <div className="flex flex-wrap gap-4">
                {ROLE_CHOICES.map((r) => (
                  <div key={r} className="flex items-center gap-2">
                    <Checkbox
                      id={`staff-bell-role-${r}`}
                      checked={roleSel.includes(r)}
                      disabled={!canChange || save.isPending}
                      onCheckedChange={(v) => setRoleSel((cur) => v ? Array.from(new Set([...cur, r])) : cur.filter((x) => x !== r))}
                    />
                    <Label htmlFor={`staff-bell-role-${r}`} className="text-xs font-normal">{r}</Label>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="staff-bell-addresses" className="text-xs">Extra addresses (one per line)</Label>
              <Textarea
                id="staff-bell-addresses"
                value={addrText}
                onChange={(e) => setAddrText(e.target.value)}
                rows={2}
                disabled={!canChange || save.isPending}
                className="max-w-md font-mono text-xs"
              />
              {badAddrs.length > 0 && (
                <p className="text-xs text-destructive" data-testid="staff-bell-emails-address-error">Not an email address: {badAddrs.join(", ")}</p>
              )}
            </div>

            {canChange ? (
              <Button size="sm" disabled={!dirty || badAddrs.length > 0 || save.isPending} onClick={() => save.mutate()}>
                {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="staff-bell-emails-readonly">Only an admin can change this.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
