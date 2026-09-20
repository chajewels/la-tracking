import { useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

export interface PickOption { id: string; label: string; hint?: string | null }

/**
 * Searchable multi-select: selected options as chips (× removes), a popover
 * with a filter box and a checklist below. Same Popover + cmdk shape as
 * customers/CountrySelect, made multi. Order of `value` is the order picked,
 * which the product editor persists as sort / sort_order.
 */
export function MultiPick({
  options, value, onChange, placeholder = "Search…", emptyText = "No match.", ariaLabel, buttonLabel = "Add",
}: {
  options: PickOption[];
  value: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  emptyText?: string;
  ariaLabel: string;
  buttonLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const byId = new Map(options.map((o) => [o.id, o]));
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={ariaLabel}>
          {value.map((id) => (
            <li key={id} className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-foreground">
              {byId.get(id)?.label ?? id}
              <button
                type="button" aria-label={`Remove ${byId.get(id)?.label ?? id}`}
                onClick={() => toggle(id)}
                className="rounded-sm text-muted-foreground hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" size="sm" role="combobox" aria-expanded={open} aria-label={ariaLabel} className="justify-between font-normal sm:min-w-[16rem]">
            {buttonLabel}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[280px] p-0" align="start">
          <Command>
            <CommandInput placeholder={placeholder} />
            <CommandList>
              <CommandEmpty>{emptyText}</CommandEmpty>
              <CommandGroup>
                {options.map((o) => {
                  const on = value.includes(o.id);
                  return (
                    <CommandItem key={o.id} value={`${o.label} ${o.hint ?? ""}`} onSelect={() => toggle(o.id)}>
                      <Check className={cn("mr-2 h-4 w-4", on ? "opacity-100" : "opacity-0")} />
                      <span className="flex-1 truncate">{o.label}</span>
                      {o.hint && <span className="ml-2 truncate text-xs text-muted-foreground" lang="ja">{o.hint}</span>}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
