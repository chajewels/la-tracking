import { memo } from 'react';
import { Search } from 'lucide-react';

const ProofsSearchBar = memo(function ProofsSearchBar({ onSearch }: { onSearch: (v: string) => void }) {
  return (
    <div className="relative w-full max-w-xs">
      <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
      <input
        className="flex h-9 w-full rounded-md border border-input bg-card px-3 py-2 pl-8 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        placeholder="Search customer, invoice, sender, reference…"
        onChange={e => onSearch(e.target.value)}
      />
    </div>
  );
});

ProofsSearchBar.displayName = 'ProofsSearchBar';
export default ProofsSearchBar;
