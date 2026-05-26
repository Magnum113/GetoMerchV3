"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { ChartContainer, ChartTooltipCard } from "@/components/ui/chart";
import { formatMoney } from "@/lib/utils";
import type { ExpenseBreakdownEntry } from "@/lib/analytics";

export function ExpenseDonut({ entries, height = 340 }: { entries: ExpenseBreakdownEntry[]; height?: number }) {
  if (entries.length === 0) {
    return <div className="text-center text-sm text-muted-foreground py-8">За период расходов нет</div>;
  }
  const total = entries.reduce((s, e) => s + e.amount, 0);
  return (
    <div className="space-y-4">
      <div className="relative">
        <ChartContainer style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={entries}
                dataKey="amount"
                nameKey="label"
                innerRadius="62%"
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

        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="text-xs text-muted-foreground">Всего расходов</div>
          <div className="text-2xl font-bold tabular-nums tracking-tight">{formatMoney(total)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-y-2 text-sm">
        {entries.map((e) => (
          <div key={e.key} className="flex items-center gap-2.5">
            <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: e.color }} />
            <span className="truncate flex-1" title={e.label}>{e.label}</span>
            <span className="tabular-nums text-muted-foreground shrink-0 text-xs">
              {(e.pct * 100).toFixed(0)}%
            </span>
            <span className="tabular-nums font-semibold shrink-0 min-w-[80px] text-right">
              {formatMoney(e.amount)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
