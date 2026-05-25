"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { ChartContainer, ChartTooltipCard } from "@/components/ui/chart";
import { formatMoney } from "@/lib/utils";
import type { ExpenseBreakdownEntry } from "@/lib/analytics";

export function ExpenseDonut({ entries, height = 240 }: { entries: ExpenseBreakdownEntry[]; height?: number }) {
  if (entries.length === 0) {
    return <div className="text-center text-sm text-muted-foreground py-8">За период расходов нет</div>;
  }
  const total = entries.reduce((s, e) => s + e.amount, 0);
  return (
    <div className="grid grid-cols-[1fr_auto] gap-4 items-center">
      <ChartContainer style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={entries}
              dataKey="amount"
              nameKey="label"
              innerRadius="60%"
              outerRadius="92%"
              paddingAngle={1.5}
              stroke="hsl(var(--background))"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {entries.map((e, i) => (
                <Cell key={i} fill={e.color} />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const e = payload[0].payload as ExpenseBreakdownEntry;
                return (
                  <ChartTooltipCard
                    title={e.label}
                    rows={[
                      { key: "v", label: "Сумма", value: formatMoney(e.amount), color: e.color, emphasized: true },
                      { key: "p", label: "Доля", value: `${(e.pct * 100).toFixed(1)}%` },
                    ]}
                  />
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      </ChartContainer>
      <div className="space-y-1.5 text-xs min-w-[180px]">
        <div className="flex items-baseline justify-between pb-1.5 border-b">
          <span className="text-muted-foreground">Всего расходов</span>
          <span className="font-semibold tabular-nums">{formatMoney(total)}</span>
        </div>
        {entries.map((e) => (
          <div key={e.key} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: e.color }} />
            <span className="truncate flex-1" title={e.label}>{e.label}</span>
            <span className="tabular-nums text-muted-foreground shrink-0">{(e.pct * 100).toFixed(0)}%</span>
            <span className="tabular-nums font-medium shrink-0 min-w-[68px] text-right">{formatMoney(e.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
