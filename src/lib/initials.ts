/** Customer initials for a monogram — display only. First letter of the first
 *  and last word, ignoring any parenthesised reading; Array.from keeps
 *  Japanese / accented first characters whole. */
export function initialsOf(name: string | null | undefined): string {
  // A parenthesised part is a reading or nickname ("Bernadette （たかはし）"),
  // not a surname — drop it so the monogram doesn't mix scripts.
  const base = (name ?? '').replace(/[（(].*$/u, '').trim() || (name ?? '').trim();
  const parts = base.split(/\s+/).map((w) => w.replace(/^[\p{P}\p{S}]+/u, '')).filter(Boolean);
  if (parts.length === 0) return 'CJ';
  const first = Array.from(parts[0])[0] ?? '';
  const second = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] ?? '' : '';
  return (first + second).toUpperCase();
}
