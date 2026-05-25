"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// Minimal helpers around Recharts so charts inherit the design system.
// We don't wrap Recharts components themselves — pass them through directly.

export interface ChartConfigItem {
  label: string;
  color: string;
}
export type ChartConfig = Record<string, ChartConfigItem>;

interface ChartContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  config?: ChartConfig;
}

export function ChartContainer({ className, children, config, style, ...rest }: ChartContainerProps) {
  const cssVars = React.useMemo(() => {
    const vars: Record<string, string> = {};
    if (!config) return vars;
    for (const [key, item] of Object.entries(config)) {
      vars[`--chart-${key}`] = item.color;
    }
    return vars;
  }, [config]);

  return (
    <div
      className={cn(
        "w-full text-foreground [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-axis-tick_text]:text-xs [&_.recharts-cartesian-grid_line]:stroke-border/60 [&_.recharts-tooltip-cursor]:fill-muted/40 [&_.recharts-tooltip-cursor]:stroke-none [&_.recharts-reference-line_line]:stroke-border",
        className,
      )}
      style={{ ...cssVars, ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}

export interface TooltipRow {
  key: string;
  label: string;
  value: React.ReactNode;
  color?: string;
  emphasized?: boolean;
}

export function ChartTooltipCard({ title, rows }: { title?: React.ReactNode; rows: TooltipRow[] }) {
  return (
    <div className="rounded-md border bg-popover/95 backdrop-blur px-3 py-2 shadow-md text-xs min-w-[10rem]">
      {title != null && <div className="font-medium mb-1.5 text-foreground">{title}</div>}
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 min-w-0">
              {r.color && <span className="h-2 w-2 rounded-sm shrink-0" style={{ background: r.color }} />}
              <span className={cn("truncate", r.emphasized ? "text-foreground font-medium" : "text-muted-foreground")}>{r.label}</span>
            </div>
            <span className={cn("tabular-nums shrink-0", r.emphasized ? "font-semibold" : "")}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
