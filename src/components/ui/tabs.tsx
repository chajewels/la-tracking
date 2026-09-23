import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { motion } from "framer-motion";

import { cn } from "@/lib/utils";
import { transition } from "@/theme/motion";

/**
 * Tracks the active value so each trigger knows whether it owns the sliding
 * gold indicator. `layoutId` is namespaced per Tabs instance so separate
 * (or nested) tab sets never animate into each other.
 */
const TabsIndicatorContext = React.createContext<{
  layoutId: string;
  activeValue: string | undefined;
} | null>(null);

const Tabs = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>(({ value, defaultValue, onValueChange, ...props }, ref) => {
  const layoutId = `tabs-indicator-${React.useId()}`;
  const [uncontrolledValue, setUncontrolledValue] =
    React.useState(defaultValue);
  const activeValue = value ?? uncontrolledValue;

  const handleValueChange = React.useCallback(
    (next: string) => {
      if (value === undefined) setUncontrolledValue(next);
      onValueChange?.(next);
    },
    [value, onValueChange],
  );

  const indicator = React.useMemo(
    () => ({ layoutId, activeValue }),
    [layoutId, activeValue],
  );

  return (
    <TabsIndicatorContext.Provider value={indicator}>
      <TabsPrimitive.Root
        ref={ref}
        value={value}
        defaultValue={defaultValue}
        onValueChange={handleValueChange}
        {...props}
      />
    </TabsIndicatorContext.Provider>
  );
});
Tabs.displayName = TabsPrimitive.Root.displayName;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground",
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, children, ...props }, ref) => {
  const indicator = React.useContext(TabsIndicatorContext);
  const indicatorId =
    indicator && indicator.activeValue === props.value
      ? indicator.layoutId
      : null;

  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "relative inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      {indicatorId && (
        <motion.span
          layoutId={indicatorId}
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary"
          transition={transition.spatial}
        />
      )}
    </TabsPrimitive.Trigger>
  );
});
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
