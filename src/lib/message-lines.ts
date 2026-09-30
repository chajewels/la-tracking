import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Random Copy Message lines (owner decision 2026-10-01).
 * Only greeting/opening and closing/thank-you words vary; they come from
 * public.message_lines. Everything else in every message is fixed.
 * Line sort=1 of every pool (docs/sql/20261001100000_message_lines_seed.sql)
 * equals the FALLBACK below, which is today's exact text.
 *
 * message_lines is not in the generated types — cast at the call site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as unknown as { from: (table: string) => any };

export type MessagePools = Record<string, string[]>;
export type LineVars = {
  name?: string;
  first_name?: string;
  invoice?: string;
  due_date?: string;
  days_ago?: string;
  link?: string;
};

const ALLOWED = ['name', 'first_name', 'invoice', 'due_date', 'days_ago', 'link'] as const;

const ID = ['invoice', 'due_date'];
const IDD = ['invoice', 'due_date', 'days_ago'];

/** Required placeholders per pool (each must appear exactly once). */
export const REQUIRED: Record<string, string[]> = {
  'portal_link_share:full': ['link'],
  'portal_setup_invite:full': ['link'],
  'reminder_upcoming:opening': ID,
  'reminder_due_today:opening': ID,
  'reminder_grace:opening': IDD,
  'reminder_overdue:opening': IDD,
  'penalty_p2:opening': ID,
  'penalty_p3:opening': ID,
  'penalty_p4:opening': ID,
  'penalty_p5:opening': ID,
  'penalty_p6:opening': ID,
  'penalty_p7:opening': ID,
  'penalty_p8:opening': ID,
};

/** Today's exact text = line sort=1 of each pool. */
export const FALLBACK: Record<string, string> = {
  'payment_received:opening': 'Thank you for your payment.',
  'payment_received_multi:opening': 'Thank you for your payments.',
  'thanks_trust:closing': 'Thank you for your continued trust in Cha Jewels! 🧡',
  'thanks_business:closing': 'Thank you for your continued trust in Cha Jewels. We appreciate your business! 🧡',
  'accounts_all_completed:opening': 'Dear {name},\n\nAll your layaway accounts have been completed. 🎉',
  'new_account_split_payment:opening': 'Dear {name},\n\nThank you for your payment.',
  'new_account_split_payment:closing': 'Thank you for your continued trust in Cha Jewels. We appreciate your business! 💛',
  'contact_us:closing': 'For any questions, please contact Cha Jewels directly.',
  'settlement_contact:closing': 'For any questions, please contact Cha Jewels directly. 💛',
  'extension_closing:closing': 'Please settle promptly to avoid permanent forfeiture. 💛',
  'portal_activation:opening': 'Hi {name} 💛\n\nYour Cha Jewels Hub Portal has been successfully created.',
  'portal_activation:closing': 'If you have any questions or need assistance, feel free to message us anytime.',
  'portal_link_share:full': "Hi {name}! Here's your Cha Jewels Hub portal: {link}",
  'portal_setup_invite:full': 'Hi {name}! Set up your Cha Jewels portal access here: {link}',
  'reminder_upcoming:opening': 'Hi {name}! 👋\n\nThis is a friendly heads-up from Cha Jewels — your next layaway payment for INV #{invoice} is coming up on {due_date}.',
  'reminder_upcoming:closing': 'Thank you for staying on track! 💎',
  'reminder_due_today:opening': 'Hi {name} 💎\n\nYour layaway payment for Invoice #{invoice} is due TODAY, {due_date}.',
  'reminder_grace:opening': 'Hi {name} 💎\n\nYour layaway payment for Invoice #{invoice} was due on {due_date} ({days_ago}).',
  'thanks_choosing:closing': 'Thank you for choosing Cha Jewels 💛',
  'reminder_overdue:opening': 'Hi {name}! 👋\n\nThis is a friendly reminder from Cha Jewels that your layaway payment for INV #{invoice} was due on {due_date} ({days_ago}).',
  'reminder_overdue:closing': 'Thank you! 💎',
  'penalty_p1:opening': 'Hi {name}! 👋\n\nThis is a gentle reminder that your payment for:',
  'penalty_p1:closing': 'Thank you for your continued trust 💛',
  'penalty_p2:opening': 'Hi {name},\n\nYour payment for INV #{invoice} is now 14 days overdue (due {due_date}) and penalties are increasing.',
  'penalty_p2:closing': 'We kindly request your prompt attention to this matter.',
  'penalty_p3:opening': 'Hi {name},\n\nYour layaway payment for INV #{invoice} is now 1 month overdue (due {due_date}). Immediate action is advised.',
  'penalty_p3:closing': 'Please contact us to discuss your payment plan.',
  'penalty_p4:opening': 'Hi {name},\n\nIMPORTANT: Your payment for INV #{invoice} has been overdue for over 6 weeks (due {due_date}).',
  'penalty_p4:closing': 'Please settle immediately to avoid account risk.',
  'penalty_p5:opening': 'Dear {name},\n\nYour layaway payment for INV #{invoice} is now 2 months overdue (due {due_date}).',
  'penalty_p5:closing': 'Your account is significantly overdue with penalties. Immediate payment is required.',
  'penalty_p6:opening': 'Dear {name},\n\nThis is your FINAL WARNING regarding INV #{invoice} (due {due_date}).',
  'penalty_p6:closing': 'Further action will be taken if not settled immediately.',
  'penalty_p7:opening': 'Dear {name},\n\nYour layaway account for INV #{invoice} is 3 months overdue (due {due_date}) and at HIGH RISK of forfeiture.',
  'penalty_p7:closing': 'Please contact us IMMEDIATELY to resolve your account.',
  'penalty_p8:opening': 'Dear {name},\n\nYour layaway account for INV #{invoice} has been overdue since {due_date} and is SUBJECT FOR FORFEITURE if not settled immediately.',
  'penalty_p8:closing': 'This is your final notice before permanent account forfeiture.',
};

export function firstName(fullName: string | null | undefined): string {
  const w = (fullName ?? '').trim().split(/\s+/)[0];
  return w || 'there';
}

/** A line is valid when every {token} is allowed and each required one appears exactly once. */
export function isValidLine(body: string, required: string[] = []): boolean {
  const tokens = body.match(/\{[^{}]*\}/g) ?? [];
  for (const t of tokens) {
    if (!(ALLOWED as readonly string[]).includes(t.slice(1, -1))) return false;
  }
  if (/[{}]/.test(body.replace(/\{[^{}]*\}/g, ''))) return false;
  for (const r of required) {
    if (tokens.filter((t) => t === `{${r}}`).length !== 1) return false;
  }
  return true;
}

export function pickLine(
  pools: MessagePools | undefined,
  type: string,
  part: string,
  fallback: string = FALLBACK[`${type}:${part}`] ?? '',
  required: string[] = REQUIRED[`${type}:${part}`] ?? [],
): string {
  const valid = (pools?.[`${type}:${part}`] ?? []).filter((b) => isValidLine(b, required));
  if (valid.length === 0) return fallback;
  return valid[Math.floor(Math.random() * valid.length)];
}

export function fillLine(body: string, vars: LineVars): string {
  const v: LineVars = { ...vars };
  if (v.first_name === undefined && v.name !== undefined) v.first_name = firstName(v.name);
  return body.replace(/\{(name|first_name|invoice|due_date|days_ago|link)\}/g, (m, k: keyof LineVars) =>
    v[k] !== undefined ? String(v[k]) : m,
  );
}

/** pick + fill in one step. */
export function line(pools: MessagePools | undefined, type: string, part: string, vars: LineVars = {}): string {
  return fillLine(pickLine(pools, type, part), vars);
}

async function fetchPools(): Promise<MessagePools> {
  const { data, error } = await db
    .from('message_lines')
    .select('message_type, part, body, sort')
    .eq('active', true)
    .order('sort', { ascending: true });
  if (error) throw error;
  const pools: MessagePools = {};
  for (const r of (data ?? []) as { message_type: string; part: string; body: string }[]) {
    (pools[`${r.message_type}:${r.part}`] ??= []).push(r.body);
  }
  return pools;
}

/**
 * Pools keyed "type:part"; undefined while loading or on error (→ fallbacks).
 * Only call inside the message-building pages/dialogs, never app-wide.
 * Not fetched under vitest, so page read-parity tests see today's reads.
 */
export function useMessagePools(): MessagePools | undefined {
  const { data } = useQuery({
    queryKey: ['message_lines'],
    queryFn: fetchPools,
    staleTime: 10 * 60 * 1000,
    retry: 1,
    enabled: import.meta.env.MODE !== 'test',
  });
  return data;
}

/**
 * Stable picks per open: returns pick(type, part) that picks once per key after
 * pools arrive and never re-rolls until resetKey changes (e.g. a dialog reopens).
 * Before pools arrive it returns the fallback (not cached).
 */
export function useStablePicker(pools: MessagePools | undefined, resetKey?: unknown) {
  const cache = useRef<Record<string, string>>({});
  const [, force] = useState(0);
  const lastReset = useRef(resetKey);
  if (lastReset.current !== resetKey) {
    lastReset.current = resetKey;
    cache.current = {};
  }
  useEffect(() => { if (pools) force((n) => n + 1); }, [pools]);
  return useCallback(
    (type: string, part: string): string => {
      const k = `${type}:${part}`;
      if (!pools) return FALLBACK[k] ?? '';
      if (cache.current[k] === undefined) cache.current[k] = pickLine(pools, type, part);
      return cache.current[k];
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pools, resetKey],
  );
}
