"use client";

import { useState } from "react";
import { Bar, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltipCard, type TooltipRow } from "@/components/ui/chart";
import { cn, formatMoney } from "@/lib/utils";
import type { OrdersRevenueBucket } from "@/lib/analytics";

const BAR_COLOR = "hsl(var(--state-info-fg))";
const PREV_COLOR = "hsl(var(--muted-foreground))";
const PREV_KEY = "prevRevenue";

interface Row extends OrdersRevenueBucket {
  prevRevenue?: number;
  prevOrders?: number;
  prevLabel?: string;
}

export function RevenueChart({
  buckets,
  prevBuckets,
  height = 280,
}: {
  buckets: OrdersRevenueBucket[];
  prevBuckets?: OrdersRevenueBucket[];
  height?: number;
}) {
  const [prevHidden, setPrevHidden] = useState(false);

  const rows: Row[] = buckets.map((b, i) => {
    const prev = prevBuckets?.[i];
    return {
      ...b,
      revenue: round(b.revenue),
      prevRevenue: prev ? round(prev.revenue) : undefined,
      prevOrders: prev?.orders,
      prevLabel: prev?.label,
    };
  });

  const showPrev = !!prevBuckets && !prevHidden;

  return (
    <div className="space-y-3">
      <ChartContainer style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 8, bottom: 4 }}>
            <XAxis dataKey="label" tickLine={false} axisLine={false} />
            <YAxis tickFormatter={formatTick} tickLine={false} axisLine={false} width={56} />
            <Tooltip
              cursor={{ fill: "hsl(var(--muted) / 0.4)" }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const r = payload[0].payload as Row;
                const tooltipRows: TooltipRow[] = [
                  { key: "revenue", label: "Выручка", value: formatMoney(r.revenue), emphasized: true, color: BAR_COLOR },
                  { key: "orders", label: "Заказов", value: String(r.orders) },
                  { key: "units", label: "Единиц", value: String(r.units) },
                ];
                if (showPrev && r.prevRevenue != null) {
                  tooltipRows.push({
                    key: "prev",
                    label: r.prevLabel ? `Пред. период (${r.prevLabel})` : "Пред. период",
                    value: formatMoney(r.prevRevenue),
                    color: PREV_COLOR,
                  });
                }
                return <ChartTooltipCard title={label} rows={tooltipRows} />;
              }}
            />
            <Bar
              dataKey="revenue"
              name="Выручка"
              fill={BAR_COLOR}
              isAnimationActive={false}
              radius={[2, 2, 0, 0]}
            />
            {prevBuckets && (
              <Line
                type="monotone"
                dataKey={PREV_KEY}
                name="Пред. период"
                stroke={PREV_COLOR}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={{ r: 2, fill: "hsl(var(--background))", stroke: PREV_COLOR, strokeWidth: 1.5 }}
                hide={prevHidden}
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartContainer>

      <div className="flex flex-wrap gap-x-3 gap-y-1.5 justify-center px-2">
        <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1">
          <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: BAR_COLOR }} />
          <span>Выручка</span>
        </span>
        {prevBuckets && (
          <button
            type="button"
            onClick={() => setPrevHidden((v) => !v)}
            className={cn(
              "inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-md transition-colors hover:bg-muted",
              prevHidden && "opacity-40",
            )}
            title={prevHidden ? "Показать" : "Скрыть"}
          >
            <span className="h-0.5 w-3.5 rounded-sm shrink-0" style={{ background: PREV_COLOR, height: 2 }} />
            <span className={cn(prevHidden && "line-through")}>Пред. период</span>
          </button>
        )}
      </div>
    </div>
  );
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function formatTick(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(".0", "")}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
  return String(v);
}
