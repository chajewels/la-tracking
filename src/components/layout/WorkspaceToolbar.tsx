import React from 'react';
import { Search, Download } from 'lucide-react';
import { cn } from '@/lib/utils';

interface WorkspaceToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  onExport?: () => void;
  showExport?: boolean;
  splitButton?: React.ReactNode;
  className?: string;
}

export default function WorkspaceToolbar({
  searchValue,
  onSearchChange,
  searchPlaceholder,
  onExport,
  showExport = true,
  splitButton,
  className,
}: WorkspaceToolbarProps) {
  return (
    <div className={cn('flex w-full items-center gap-2', className)}>
      {/* Wide search field */}
      <div className="flex h-10 flex-1 items-center gap-2 rounded-md border border-border bg-card px-3">
        <Search className="h-4 w-4 text-muted-foreground" aria-hidden />
        <input
          type="text"
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder ?? 'Search...'}
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      {/* Export icon */}
      {showExport && (
        <button
          type="button"
          onClick={onExport}
          aria-label="Export"
          className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:text-foreground hover:bg-muted/40"
        >
          <Download className="h-4 w-4" />
        </button>
      )}

      {/* Split-button slot */}
      {splitButton && <div className="flex-shrink-0">{splitButton}</div>}
    </div>
  );
}
