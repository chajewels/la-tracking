import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown preview for the website post editor.
 *
 * Uses react-markdown + remark-gfm, both already dependencies (Help.tsx has
 * rendered the staff handbook with them since it shipped) — no new package.
 * Help keeps its own component map because it is a full documentation page
 * with 3xl headings; this one is sized for a preview pane sitting beside a
 * textarea, so the two do not share a map.
 *
 * This renders the Hub's PREVIEW. It is not what chajewelsjp.com will use, and
 * it makes no promise of being pixel-identical to it — its job is to show the
 * writer that their list is a list and their link is a link before they
 * publish.
 */
const components: Parameters<typeof ReactMarkdown>[0]["components"] = {
  h1: ({ children }) => <h2 className="mb-2 mt-4 text-lg font-semibold text-foreground first:mt-0">{children}</h2>,
  h2: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold text-foreground first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mb-1.5 mt-3 text-sm font-semibold text-foreground first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="my-2 text-sm leading-6 text-foreground/85">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 text-sm leading-6 text-foreground/85 marker:text-primary/60">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 text-sm leading-6 text-foreground/85 marker:text-primary/60">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-primary/40 pl-3 text-sm italic text-muted-foreground">{children}</blockquote>
  ),
  code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 text-[0.8em]">{children}</code>,
  hr: () => <hr className="my-4 border-border" />,
  // Every link in a post points off this screen, so they all open in a new tab
  // and carry noopener — a preview must never navigate the Hub away from an
  // unsaved draft.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
      {children}
    </a>
  ),
  img: ({ src, alt }) => (
    <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} loading="lazy" className="my-2 max-h-64 rounded-md object-contain" />
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto"><table className="w-full text-xs">{children}</table></div>
  ),
  th: ({ children }) => <th className="border-b border-border px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b border-border/40 px-2 py-1">{children}</td>,
};

export function Markdown({ children }: { children: string }) {
  const text = children.trim();
  if (!text) {
    return <p className="text-sm italic text-muted-foreground">Nothing to preview yet.</p>;
  }
  return (
    <div className="min-w-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  );
}
