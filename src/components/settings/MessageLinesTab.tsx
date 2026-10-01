import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Lock, MessageSquareText, Pencil, Plus } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  POOL_GROUPS, allowedPlaceholders, requiredPlaceholders, lineProblem, previewLine, splitPool, isLockedLine,
} from '@/lib/message-lines-admin';

/**
 * Settings → Message lines: the random opening/closing words of Copy Message
 * (public.message_lines, src/lib/message-lines.ts) and the review invite.
 *
 * - Pools are fixed (only what the code reads); lines are added, edited or
 *   switched off. Nothing is deleted — the table has no DELETE policy.
 * - Line 1 of every pool is LOCKED (owner decision 2026-10-01): today's exact
 *   wording and the code fallback, so a pool always keeps the original.
 * - Save is refused with the reason when the readers would skip the line
 *   (lineProblem = the readers' isValidLine, with words).
 * - Every write logs an audit row with the OLD and NEW text (as the FAQ
 *   editor does), and invalidates the 10-minute pool cache, so the next Copy
 *   Message uses the change at once.
 *
 * Admin only: the tab is rendered for admins; RLS (UPDATE/INSERT admin) is the
 * real gate. message_lines is not in the generated types — cast at the call
 * site, like every other reader of this table.
 */

type LineRow = {
  id: string;
  message_type: string;
  part: string;
  body: string;
  active: boolean;
  sort: number;
  updated_at: string;
};

type Draft = { id: string | null; pool: string; body: string; sort: number; active: boolean };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as unknown as { from: (table: string) => any };

export default function MessageLinesTab() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const lines = useQuery<LineRow[]>({
    queryKey: ['message_lines_admin'],
    queryFn: async () => {
      const { data, error } = await db
        .from('message_lines')
        .select('id, message_type, part, body, active, sort, updated_at')
        .order('message_type')
        .order('part')
        .order('sort');
      if (error) throw error;
      return (data ?? []) as LineRow[];
    },
    staleTime: 60 * 1000,
  });

  const byPool = useMemo(() => {
    const m = new Map<string, LineRow[]>();
    for (const r of lines.data ?? []) {
      const k = `${r.message_type}:${r.part}`;
      (m.get(k) ?? m.set(k, []).get(k)!).push(r);
    }
    return m;
  }, [lines.data]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['message_lines_admin'] });
    qc.invalidateQueries({ queryKey: ['message_lines'] });
  };

  const audit = (entityId: string, action: string, oldV: unknown, newV: unknown) =>
    supabase.from('audit_logs').insert([{
      entity_type: 'message_line',
      entity_id: entityId,
      action,
      old_value_json: (oldV ?? null) as never,
      new_value_json: (newV ?? null) as never,
      performed_by_user_id: user?.id ?? null,
    }]);

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const problem = lineProblem(d.pool, d.body);
      if (problem) throw new Error(problem);
      const body = d.body.trim();
      const { message_type, part } = splitPool(d.pool);
      if (d.id) {
        const before = (lines.data ?? []).find((r) => r.id === d.id);
        if (!before) throw new Error('This line no longer exists — reload the page.');
        if (isLockedLine(before.sort)) throw new Error('Line 1 is locked.');
        const { error } = await db.from('message_lines').update({ body }).eq('id', d.id);
        if (error) throw error;
        await audit(d.id, 'update', { pool: d.pool, body: before.body }, { pool: d.pool, body });
        return;
      }
      const pool = byPool.get(d.pool) ?? [];
      const sort = pool.reduce((m, r) => Math.max(m, r.sort), 0) + 1;
      const { data, error } = await db
        .from('message_lines')
        .insert({ message_type, part, body, active: true, sort })
        .select('id')
        .single();
      if (error) throw error;
      await audit((data as { id: string }).id, 'create', null, { pool: d.pool, body, sort });
    },
    onSuccess: () => {
      toast({ title: 'Saved', description: 'The next Copy Message can use this line.' });
      setEditing(null);
      invalidate();
    },
    onError: (e: Error) => toast({ title: 'Not saved', description: e.message, variant: 'destructive' }),
  });

  const toggle = useMutation({
    mutationFn: async (r: LineRow) => {
      if (isLockedLine(r.sort)) throw new Error('Line 1 is locked.');
      setBusyId(r.id);
      const { error } = await db.from('message_lines').update({ active: !r.active }).eq('id', r.id);
      if (error) throw error;
      await audit(r.id, r.active ? 'deactivate' : 'activate', { active: r.active, body: r.body }, { active: !r.active, body: r.body });
    },
    onSettled: () => setBusyId(null),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast({ title: 'Not changed', description: e.message, variant: 'destructive' }),
  });

  const draftProblem = editing ? lineProblem(editing.pool, editing.body) : null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquareText className="h-4 w-4 text-primary" />
            Message lines
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            The opening and closing words of Copy Message are picked at random from these lines each time a
            message is opened. Figures, links, PIN line and policy sentences never change. Line 1 of every
            pool is the original wording and is locked; add new lines or switch yours off. A switched-off line
            is kept so past messages can be traced.
          </p>
        </CardHeader>
        <CardContent className="space-y-8">
          {lines.isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading lines…</div>
          )}
          {lines.error && (
            <p className="text-sm text-destructive">Could not load the lines: {(lines.error as Error).message}</p>
          )}
          {lines.data && POOL_GROUPS.map((g) => (
            <section key={g.group} className="space-y-4">
              <h3 className="font-display text-sm uppercase tracking-wider text-muted-foreground hairline-b pb-1">{g.group}</h3>
              {g.pools.map((p) => {
                const rows = byPool.get(p.key) ?? [];
                const activeCount = rows.filter((r) => r.active).length;
                return (
                  <div key={p.key} className="rounded-md border border-border/60 p-3 space-y-2" data-pool={p.key}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{p.label}</span>
                        <Badge variant="outline" className="text-xs">{activeCount} active</Badge>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditing({ id: null, pool: p.key, body: '', sort: 0, active: true })}
                      >
                        <Plus className="h-3.5 w-3.5 mr-1" /> Add line
                      </Button>
                    </div>
                    <ul className="divide-y divide-border/50">
                      {rows.map((r) => {
                        const locked = isLockedLine(r.sort);
                        return (
                          <li key={r.id} className={`flex items-start gap-3 py-2 ${r.active ? '' : 'opacity-60'}`}>
                            <span className="mt-0.5 w-6 shrink-0 text-xs text-muted-foreground tabular-nums">{r.sort}</span>
                            <p className="flex-1 whitespace-pre-wrap text-sm leading-relaxed break-words">{r.body}</p>
                            <div className="flex shrink-0 items-center gap-2">
                              {locked ? (
                                <span className="flex items-center gap-1 text-xs text-muted-foreground" title="Line 1 is the original wording and cannot be changed">
                                  <Lock className="h-3.5 w-3.5" /> Locked
                                </span>
                              ) : (
                                <>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label="Edit line"
                                    onClick={() => setEditing({ id: r.id, pool: p.key, body: r.body, sort: r.sort, active: r.active })}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                  <Switch
                                    checked={r.active}
                                    disabled={busyId === r.id}
                                    aria-label={r.active ? 'Switch line off' : 'Switch line on'}
                                    onCheckedChange={() => toggle.mutate(r)}
                                  />
                                </>
                              )}
                            </div>
                          </li>
                        );
                      })}
                      {rows.length === 0 && (
                        <li className="py-2 text-sm text-muted-foreground">No lines yet — the built-in wording is used.</li>
                      )}
                    </ul>
                  </div>
                );
              })}
            </section>
          ))}
        </CardContent>
      </Card>

      <Sheet open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          {editing && (
            <div className="space-y-5">
              <SheetHeader>
                <SheetTitle>{editing.id ? 'Edit line' : 'Add line'}</SheetTitle>
                <p className="text-sm text-muted-foreground">
                  {POOL_GROUPS.flatMap((g) => g.pools).find((p) => p.key === editing.pool)?.label}
                </p>
              </SheetHeader>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Placeholders you can use</Label>
                <div className="flex flex-wrap gap-1.5">
                  {allowedPlaceholders(editing.pool).map((k) => {
                    const req = requiredPlaceholders(editing.pool).includes(k);
                    return (
                      <button
                        key={k}
                        type="button"
                        className="rounded-sm border border-border px-2 py-0.5 font-mono text-xs hover:bg-muted"
                        title={req ? 'Required — exactly once' : 'Optional'}
                        onClick={() => setEditing((e) => (e ? { ...e, body: `${e.body}{${k}}` } : e))}
                      >
                        {`{${k}}`}{req ? ' *' : ''}
                      </button>
                    );
                  })}
                </div>
                {requiredPlaceholders(editing.pool).length > 0 && (
                  <p className="text-xs text-muted-foreground">* must appear exactly once in this message.</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="message-line-body">Line</Label>
                <Textarea
                  id="message-line-body"
                  rows={5}
                  maxLength={1000}
                  value={editing.body}
                  onChange={(e) => setEditing((d) => (d ? { ...d, body: e.target.value } : d))}
                  placeholder="Type the line as the customer should read it…"
                />
                {draftProblem ? (
                  <p className="text-xs text-destructive" role="alert">{draftProblem}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">Looks good.</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Preview (sample customer)</Label>
                <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-sm whitespace-pre-wrap leading-relaxed min-h-[3rem]">
                  {editing.body ? previewLine(editing.pool, editing.body) : <span className="text-muted-foreground">—</span>}
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                <Button onClick={() => save.mutate(editing)} disabled={!!draftProblem || save.isPending}>
                  {save.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Save
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
