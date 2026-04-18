import { memo } from 'react';
import { Search } from 'lucide-react';

const VaultSearchBar = memo(function VaultSearchBar({ onSearch }: { onSearch: (v: string) => void }) {
  return (
    <div className="p-3 border-b border-border">
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
        <input
          className="flex h-8 w-full rounded-md border border-input bg-card px-3 py-1 pl-8 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          placeholder="Search name or invoice…"
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>
    </div>
  );
});

VaultSearchBar.displayName = 'VaultSearchBar';
export default VaultSearchBar;
