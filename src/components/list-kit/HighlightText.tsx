/**
 * Highlights case-insensitive matches of `query` inside `text`.
 * Used by the list search surfaces (AccountList, CashOrdersList, DataTable)
 * so a debounced search visibly explains why a row matched.
 */
export default function HighlightText({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let hit = lower.indexOf(needle);
  if (hit === -1) return <>{text}</>;
  while (hit !== -1) {
    if (hit > i) parts.push(text.slice(i, hit));
    parts.push(
      <mark key={hit} className="bg-gold-300/25 text-gold-300 rounded-[2px]">
        {text.slice(hit, hit + needle.length)}
      </mark>,
    );
    i = hit + needle.length;
    hit = lower.indexOf(needle, i);
  }
  if (i < text.length) parts.push(text.slice(i));
  return <>{parts}</>;
}
