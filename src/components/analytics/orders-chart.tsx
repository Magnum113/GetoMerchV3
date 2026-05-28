"use client";

import { useState } from "react";
import { Bar, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltipCard, type TooltipRow } from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import type { OrdersBucket } from "@/lib/analytics";

interface SeriesDef {
  key: "delivered" | "inflight" | "cancelled";
  label: string;
  color: string;
}

const SERIES: SeriesDef[] = [
  { key: "delivered", label: "Доставлено", color: "hsl(var(--state-success-fg))" },
  { key: "inflight", label: "В процессе", color: "hsl(var(--state-info-fg))" },
  { key: "cancelled", label: "Отменено / невыкуп", color: "hsl(var(--state-danger-fg))" },
];

const PREV_KEY = "__prevTotal";
const PREV_COLOR = "hsl(var(--muted-foreground))";

interface Row extends OrdersBucket {
  [PREV_KEY]?: number;
  prevLabel?: string;
}

export function OrdersChart({
  buckets,
  prevBuckets,
  height = 280,
}: {
  buckets: OrdersBucket[];
  prevBuckets?: OrdersBucket[];
  height?: number;
}) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());

  function toggle(key: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  // Merge: previous period bucket overlaid on the same INDEX as current bucket.
  // Labels of prev period kept in prevLabel for tooltip.
  const rows: Row[] = buckets.map((b, i) => {
    const prev = prevBuckets?.[i];
    return {
      ...b,
      [PREV_KEY]: prev?.total,
      prevLabel: prev?.label,
    };
  });

  const showPrev = !!prevBuckets && !hidden.has(PREV_KEY);

  return (
    <div className="space-y-3">
      <ChartContainer style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 8, bottom: 4 }}>
            <XAxis dataKey="label" tickLine={false} axisLine={false} />
            <YAxis tickLine={false} axisLine={false} allowDecimals={false} width={36} />
            <Tooltip
              cursor={{ fill: "hsl(var(--muted) / 0.4)" }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const r = payload[0].payload as Row;
                const visible = SERIES.filter((s) => !hidden.has(s.key));
                const tooltipRows: TooltipRow[] = [
                  { key: "total", label: "Всего товаров", value: String(r.total), emphasized: true },
                  ...visible.map((s) => ({ key: s.key, label: s.label, value: String(r[s.key]), color: s.color })),
                  { key: "orders", label: "Отправлений", value: String(r.orders) },
                ];
                if (showPrev && r[PREV_KEY] != null) {
                  tooltipRows.push({
                    key: "prev",
                    label: r.prevLabel ? `Пред. период (${r.prevLabel})` : "Пред. период",
                    value: String(r[PREV_KEY]),
                    color: PREV_COLOR,
                  });
                }
                return <ChartTooltipCard title={label} rows={tooltipRows} />;
              }}
            />
            {SERIES.map((s) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                stackId="orders"
                name={s.label}
                fill={s.color}
                hide={hidden.has(s.key)}
                isAnimationActive={false}
                radius={[2, 2, 0, 0]}
              />
            ))}
            {prevBuckets && (
              <Line
                type="monotone"
                dataKey={PREV_KEY}
                name="Пред. период"
                stroke={PREV_COLOR}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={{ r: 2, fill: "hsl(var(--background))", stroke: PREV_COLOR, strokeWidth: 1.5 }}
                hide={hidden.has(PREV_KEY)}
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartContainer>

      <div className="flex flex-wrap gap-x-3 gap-y-1.5 justify-center px-2">
        {SERIES.map((s) => {
          const off = hidden.has(s.key);
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => toggle(s.key)}
              className={cn(
                "inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-md transition-colors hover:bg-muted",
                off && "opacity-40",
              )}
              title={off ? "Показать" : "Скрыть"}
            >
              <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
              <span className={cn(off && "line-through")}>{s.label}</span>
            </button>
          );
        })}
        {prevBuckets && (
          <button
            type="button"
            onClick={() => toggle(PREV_KEY)}
            className={cn(
              "inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-md transition-colors hover:bg-muted",
              hidden.has(PREV_KEY) && "opacity-40",
            )}
            title={hidden.has(PREV_KEY) ? "Показать" : "Скрыть"}
          >
            <span className="h-0.5 w-3.5 rounded-sm shrink-0" style={{ background: PREV_COLOR, height: 2 }} />
            <span className={cn(hidden.has(PREV_KEY) && "line-through")}>Пред. период</span>
          </button>
        )}
      </div>
    </div>
  );
}
