import { memo, useEffect } from 'react';
import { Search } from 'lucide-react';

const SubmissionsSearchBar = memo(function SubmissionsSearchBar({ onSearch }: { onSearch: (v: string) => void }) {
  useEffect(() => {
    console.log('[SubmissionsSearchBar] MOUNTED');
    return () => console.log('[SubmissionsSearchBar] UNMOUNTED');
  }, []);

  return (
    <div className="relative flex-1">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <input
        className="flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 pl-9 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        placeholder="Search customer, invoice, or reference…"
        onChange={(e) => onSearch(e.target.value)}
      />
    </div>
  );
});

SubmissionsSearchBar.displayName = 'SubmissionsSearchBar';
export default SubmissionsSearchBar;
