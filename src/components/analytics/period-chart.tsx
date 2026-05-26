"use client";

import { useState } from "react";
import { Bar, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltipCard } from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/utils";
import type { TimeBucket } from "@/lib/analytics";
import { BUILTIN_EXPENSE_COLORS } from "@/lib/analytics";

interface Row {
  label: string;
  revenue: number;
  cogs: number;
  ozonFees: number;
  tax: number;
  other: number;
  returns: number;
  profit: number;
  orders: number;
}

type SeriesKind = "bar" | "line";

interface SeriesDef {
  key: keyof Row;
  label: string;
  color: string;
  kind: SeriesKind;
  axis: "left" | "right";
}

const SERIES: SeriesDef[] = [
  { key: "cogs", label: "Себестоимость", color: BUILTIN_EXPENSE_COLORS.cogs, kind: "bar", axis: "left" },
  { key: "ozonFees", label: "Расходы Ozon", color: BUILTIN_EXPENSE_COLORS.commission, kind: "bar", axis: "left" },
  { key: "tax", label: "Налог 6%", color: BUILTIN_EXPENSE_COLORS.tax, kind: "bar", axis: "left" },
  { key: "returns", label: "Возвраты", color: BUILTIN_EXPENSE_COLORS.returns, kind: "bar", axis: "left" },
  { key: "other", label: "Прочие", color: "hsl(160 60% 45%)", kind: "bar", axis: "left" },
  { key: "profit", label: "Чистая прибыль", color: "hsl(var(--foreground))", kind: "line", axis: "left" },
  { key: "orders", label: "Заказы", color: "hsl(var(--state-info-fg))", kind: "line", axis: "right" },
];

export function PeriodChart({ buckets, height = 340 }: { buckets: TimeBucket[]; height?: number }) {
  // По умолчанию "Заказы" выключены чтобы не загромождать; пользователь включит кликом.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(["orders"]));

  const rows: Row[] = buckets.map((b) => ({
    label: b.label,
    revenue: round(b.metrics.revenue),
    cogs: round(b.metrics.cogs),
    ozonFees: round(b.metrics.ozonFeesTotal),
    tax: round(b.metrics.tax),
    other: round(b.metrics.otherExpenses),
    returns: round(b.metrics.returns),
    profit: round(b.metrics.netProfit),
    orders: b.metrics.ordersCount,
  }));

  function toggle(key: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const visibleHasRight = SERIES.some((s) => s.axis === "right" && !hidden.has(s.key));

  return (
    <div className="space-y-3">
      <ChartContainer style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: visibleHasRight ? 12 : 8, left: 8, bottom: 4 }}>
            <XAxis dataKey="label" tickLine={false} axisLine={false} />
            <YAxis
              yAxisId="left"
              tickFormatter={(v) => formatTick(v)}
              tickLine={false}
              axisLine={false}
              width={64}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tickLine={false}
              axisLine={false}
              width={visibleHasRight ? 36 : 0}
              allowDecimals={false}
              hide={!visibleHasRight}
            />
            <Tooltip
              cursor={{ fill: "hsl(var(--muted) / 0.4)" }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const r = payload[0].payload as Row;
                return (
                  <ChartTooltipCard
                    title={label}
                    rows={[
                      { key: "revenue", label: "Выручка", value: formatMoney(r.revenue) },
                      ...SERIES.filter((s) => !hidden.has(s.key) && s.key !== "profit" && s.key !== "orders").map((s) => ({
                        key: s.key,
                        label: s.label,
                        value: formatMoney(r[s.key] as number),
                        color: s.color,
                      })),
                      ...(!hidden.has("orders")
                        ? [{ key: "orders", label: "Заказов", value: String(r.orders), color: "hsl(var(--state-info-fg))" }]
                        : []),
                      { key: "profit", label: "Чистая прибыль", value: formatMoney(r.profit), emphasized: true, color: "hsl(var(--state-success-fg))" },
                    ]}
                  />
                );
              }}
            />
            {SERIES.filter((s) => s.kind === "bar").map((s) => (
              <Bar
                key={s.key}
                yAxisId={s.axis}
                dataKey={s.key}
                stackId="exp"
                name={s.label}
                fill={s.color}
                hide={hidden.has(s.key)}
                isAnimationActive={false}
              />
            ))}
            {SERIES.filter((s) => s.kind === "line").map((s) => (
              <Line
                key={s.key}
                yAxisId={s.axis}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                strokeDasharray={s.key === "orders" ? "4 3" : undefined}
                dot={{ r: 3, fill: "hsl(var(--background))", stroke: s.color, strokeWidth: 2 }}
                hide={hidden.has(s.key)}
                isAnimationActive={false}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartContainer>

      {/* Кликабельная легенда — переключает видимость серии */}
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
              {s.kind === "line" ? (
                <span
                  className="h-0.5 w-3.5 rounded-sm shrink-0"
                  style={{
                    background: s.color,
                    borderTop: s.key === "orders" ? `2px dashed ${s.color}` : undefined,
                    height: s.key === "orders" ? 0 : 2,
                  }}
                />
              ) : (
                <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
              )}
              <span className={cn(off && "line-through")}>{s.label}</span>
            </button>
          );
        })}
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
