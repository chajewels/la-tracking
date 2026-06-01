import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Menu } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from '@/components/ui/sheet';
import { Separator } from '@/components/ui/separator';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import {
  HelpSection,
  HelpRole,
  getSectionsForRole,
  groupSectionsByCategory,
} from '@/help-content';

function pickHelpRole(roles: string[] | undefined): HelpRole | undefined {
  if (!roles || roles.length === 0) return undefined;
  const priority: HelpRole[] = ['admin', 'finance', 'staff', 'csr'];
  for (const r of priority) {
    if (roles.includes(r)) return r;
  }
  return undefined;
}

function TocList({
  groups,
  activeSlug,
  onSelect,
}: {
  groups: ReturnType<typeof groupSectionsByCategory>;
  activeSlug: string | undefined;
  onSelect: (slug: string) => void;
}) {
  return (
    <nav className="space-y-5">
      {groups.map(group => (
        <div key={group.category}>
          <h3 className="px-2 mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {group.label}
          </h3>
          <ul className="space-y-0.5">
            {group.items.map(item => {
              const isActive = item.slug === activeSlug;
              return (
                <li key={item.slug}>
                  <button
                    type="button"
                    onClick={() => onSelect(item.slug)}
                    className={cn(
                      'w-full text-left text-sm px-3 py-1.5 rounded-md transition-colors',
                      isActive
                        ? 'border-l-2 border-l-[#D4AF37] bg-[#D4AF37]/10 font-medium text-[#D4AF37]'
                        : 'text-foreground/70 hover:bg-[#D4AF37]/[0.06] hover:text-foreground'
                    )}
                  >
                    {item.title}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

const markdownComponents: Parameters<typeof ReactMarkdown>[0]['components'] = {
  h1: ({ children }) => (
    <h1 className="text-3xl font-bold text-foreground font-display mt-2 mb-5">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-xl font-semibold text-foreground mt-8 mb-3 border-b border-border pb-1.5">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-base font-semibold text-foreground mt-6 mb-2">{children}</h3>
  ),
  p: ({ children }) => (
    <p className="text-sm leading-7 text-foreground/85 my-3">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="list-disc pl-6 my-3 space-y-1 text-sm leading-7 text-foreground/85 marker:text-[#D4AF37]/60">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-6 my-3 space-y-1 text-sm leading-7 text-foreground/85 marker:text-[#D4AF37]/60">{children}</ol>
  ),
  li: ({ children }) => <li>{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target={href?.startsWith('http') ? '_blank' : undefined}
      rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
      className="text-[#D4AF37] no-underline hover:underline"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic text-foreground/80">{children}</em>,
  hr: () => <hr className="my-8 border-border" />,
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-2 border-[#D4AF37]/50 pl-4 text-sm text-foreground/70 italic">
      {children}
    </blockquote>
  ),
  code: ({ className, children }) => {
    const isBlock = /language-/.test(className || '');
    if (isBlock) return <code className={cn(className)}>{children}</code>;
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-4 overflow-x-auto rounded-lg bg-zinc-900 border border-border p-4 text-xs leading-6 text-zinc-100">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => (
    <tr className="border-b border-border last:border-b-0 even:bg-muted/30">{children}</tr>
  ),
  th: ({ children }) => (
    <th className="px-3 py-2 text-left font-semibold text-foreground">{children}</th>
  ),
  td: ({ children }) => <td className="px-3 py-2 text-foreground/85">{children}</td>,
};

export default function Help() {
  const { roles } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const helpRole = pickHelpRole(roles);
  const sections = useMemo(() => getSectionsForRole(helpRole), [helpRole]);
  const groups = useMemo(() => groupSectionsByCategory(sections), [sections]);

  const slugFromUrl = searchParams.get('slug') ?? undefined;
  const activeSection: HelpSection | undefined =
    sections.find(s => s.slug === slugFromUrl) ?? sections[0];

  const selectSlug = (slug: string) => {
    setSearchParams({ slug }, { replace: true });
  };

  return (
    <AppLayout>
      <div className="flex h-[calc(100vh-4rem)] w-full">
        {/* Desktop TOC */}
        <aside className="hidden md:flex md:flex-col md:w-64 md:shrink-0 border-r border-border bg-card/40">
          <div className="px-4 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Help Center</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {helpRole ? `Filtered for ${helpRole}` : 'Sign in to view'}
            </p>
          </div>
          <ScrollArea className="flex-1 px-2 py-3">
            <TocList groups={groups} activeSlug={activeSection?.slug} onSelect={selectSlug} />
          </ScrollArea>
        </aside>

        {/* Main content */}
        <main className="flex-1 min-w-0 overflow-y-auto">
          {/* Mobile header with hamburger */}
          <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-border sticky top-0 bg-background/95 backdrop-blur z-10">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Open help navigation">
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72 p-0">
                <SheetTitle className="sr-only">Help Sections</SheetTitle>
                <div className="px-4 py-4 border-b border-border">
                  <h2 className="text-sm font-semibold text-foreground">Help Center</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {helpRole ? `Filtered for ${helpRole}` : 'Sign in to view'}
                  </p>
                </div>
                <ScrollArea className="h-[calc(100vh-5rem)] px-2 py-3">
                  <TocList groups={groups} activeSlug={activeSection?.slug} onSelect={selectSlug} />
                </ScrollArea>
              </SheetContent>
            </Sheet>
            <h1 className="text-base font-semibold text-foreground truncate">
              {activeSection?.title ?? 'Help'}
            </h1>
          </div>

          <div className="mx-auto w-full max-w-3xl px-6 py-8">
            {activeSection ? (
              <article>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {activeSection.content}
                </ReactMarkdown>
                <Separator className="mt-10" />
                <p className="mt-4 text-xs text-muted-foreground">
                  Section <code className="font-mono">{activeSection.slug}</code> · category{' '}
                  <code className="font-mono">{activeSection.category}</code>
                </p>
              </article>
            ) : (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No help sections available for your role yet.
              </div>
            )}
          </div>
        </main>
      </div>
    </AppLayout>
  );
}
