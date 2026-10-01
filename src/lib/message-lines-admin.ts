import { FALLBACK, REQUIRED, fillLine, isValidLine } from '@/lib/message-lines';

/**
 * Pure helpers for the Hub editor of public.message_lines
 * (Settings → Message lines). No network, no React — tested in
 * src/test/message-lines-admin.test.ts.
 *
 * The editor only edits pools the code reads: the 37 Copy Message pools of
 * src/lib/message-lines.ts plus the review invite pool
 * (components/reviews/ReviewLinkDialog.tsx). A pool nothing reads cannot be
 * created here.
 *
 * Validation here is the SAME rule the readers apply (isValidLine), with a
 * reason attached, so a line that saves is a line that gets picked. Line 1 of
 * every pool is LOCKED (owner decision 2026-10-01): it is today's exact
 * wording and the code fallback, so every pool always keeps the original.
 */

export const REVIEW_POOL = 'review_invite:full';

/** Placeholders a pool may use. */
export function allowedPlaceholders(pool: string): string[] {
  if (pool === REVIEW_POOL) return ['first_name', 'piece', 'link'];
  return ['name', 'first_name', 'invoice', 'due_date', 'days_ago', 'link'];
}

/** Placeholders a pool must use exactly once. */
export function requiredPlaceholders(pool: string): string[] {
  if (pool === REVIEW_POOL) return ['link'];
  return REQUIRED[pool] ?? [];
}

/** Every pool the editor shows, in display order, with a plain-English label. */
export const POOL_GROUPS: { group: string; pools: { key: string; label: string }[] }[] = [
  {
    group: 'Payments',
    pools: [
      { key: 'payment_received:opening', label: 'Payment received — opening' },
      { key: 'payment_received_multi:opening', label: 'Split payment received — opening' },
      { key: 'thanks_trust:closing', label: 'Thank you (trust) — closing' },
      { key: 'thanks_business:closing', label: 'Thank you (business) — closing' },
      { key: 'thanks_choosing:closing', label: 'Thank you for choosing — closing' },
    ],
  },
  {
    group: 'Accounts',
    pools: [
      { key: 'accounts_all_completed:opening', label: 'All accounts completed — opening' },
      { key: 'new_account_split_payment:opening', label: 'New account, split payment — opening' },
      { key: 'new_account_split_payment:closing', label: 'New account, split payment — closing' },
      { key: 'contact_us:closing', label: 'Contact us — closing' },
      { key: 'settlement_contact:closing', label: 'Settlement contact — closing' },
      { key: 'extension_closing:closing', label: 'Extension — closing' },
    ],
  },
  {
    group: 'Portal',
    pools: [
      { key: 'portal_activation:opening', label: 'Portal activated — opening' },
      { key: 'portal_activation:closing', label: 'Portal activated — closing' },
      { key: 'portal_link_share:full', label: 'Share portal link — whole message' },
      { key: 'portal_setup_invite:full', label: 'Portal setup invite — whole message' },
    ],
  },
  {
    group: 'Reminders',
    pools: [
      { key: 'reminder_upcoming:opening', label: 'Upcoming payment — opening' },
      { key: 'reminder_upcoming:closing', label: 'Upcoming payment — closing' },
      { key: 'reminder_due_today:opening', label: 'Due today — opening' },
      { key: 'reminder_grace:opening', label: 'Grace period — opening' },
      { key: 'reminder_overdue:opening', label: 'Overdue — opening' },
      { key: 'reminder_overdue:closing', label: 'Overdue — closing' },
    ],
  },
  {
    group: 'Penalty follow-ups',
    pools: [1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [
      { key: `penalty_p${n}:opening`, label: `Penalty stage ${n} — opening` },
      { key: `penalty_p${n}:closing`, label: `Penalty stage ${n} — closing` },
    ]),
  },
  {
    group: 'Reviews',
    pools: [{ key: REVIEW_POOL, label: 'Review invite — whole message' }],
  },
];

export const ALL_POOLS: string[] = POOL_GROUPS.flatMap((g) => g.pools.map((p) => p.key));

export function splitPool(pool: string): { message_type: string; part: string } {
  const i = pool.indexOf(':');
  return { message_type: pool.slice(0, i), part: pool.slice(i + 1) };
}

/** Sample values for the preview — never real customer data. */
export const SAMPLE_VARS = {
  name: 'Maria Santos',
  first_name: 'Maria',
  invoice: '19500',
  due_date: 'Oct 05, 2026',
  days_ago: '3 days ago',
  link: 'https://portal.chajewelsjp.com/portal',
  piece: 'K18 Akoya pearl necklace',
};

/** The line as a customer would read it. */
export function previewLine(pool: string, body: string): string {
  if (pool === REVIEW_POOL) {
    return body
      .replace('{first_name}', SAMPLE_VARS.first_name)
      .replace('{piece}', SAMPLE_VARS.piece)
      .replace('{link}', SAMPLE_VARS.link);
  }
  return fillLine(body, SAMPLE_VARS);
}

/**
 * null when the line is valid for its pool; otherwise the reason, in the
 * words the editor shows. Mirrors isValidLine so the editor never saves a
 * line the readers would skip.
 */
export function lineProblem(pool: string, body: string): string | null {
  const text = body ?? '';
  if (!text.trim()) return 'The line is empty.';
  if (text.length > 1000) return 'The line is longer than 1,000 characters.';
  const allowed = allowedPlaceholders(pool);
  const required = requiredPlaceholders(pool);
  const tokens = text.match(/\{[^{}]*\}/g) ?? [];
  for (const t of tokens) {
    const k = t.slice(1, -1);
    if (!allowed.includes(k)) return `Unknown placeholder ${t}. Allowed here: ${allowed.map((a) => `{${a}}`).join(' ')}.`;
  }
  if (/[{}]/.test(text.replace(/\{[^{}]*\}/g, ''))) return 'A stray { or } — every placeholder must be written like {name}.';
  for (const r of required) {
    const n = tokens.filter((t) => t === `{${r}}`).length;
    if (n === 0) return `{${r}} is required in this message.`;
    if (n > 1) return `{${r}} must appear only once.`;
  }
  if (pool !== REVIEW_POOL && !isValidLine(text, required)) return 'The line would be skipped by the message builder.';
  return null;
}

/** True for the locked line (line 1 of its pool). */
export function isLockedLine(sort: number): boolean {
  return sort === 1;
}

/** The fallback wording for a pool, shown beside the locked line. */
export function fallbackFor(pool: string): string | undefined {
  return FALLBACK[pool];
}
