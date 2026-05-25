"use client";

import { Bar, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";
import { ChartContainer, ChartTooltipCard } from "@/components/ui/chart";
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
  profit: number;
}

const SERIES: { key: keyof Pick<Row, "cogs" | "ozonFees" | "tax" | "other">; label: string; color: string }[] = [
  { key: "cogs", label: "Себестоимость", color: BUILTIN_EXPENSE_COLORS.cogs },
  { key: "ozonFees", label: "Расходы Ozon", color: BUILTIN_EXPENSE_COLORS.commission },
  { key: "tax", label: "Налог 6%", color: BUILTIN_EXPENSE_COLORS.tax },
  { key: "other", label: "Прочие", color: "hsl(160 60% 45%)" },
];

export function PeriodChart({ buckets, height = 320 }: { buckets: TimeBucket[]; height?: number }) {
  const rows: Row[] = buckets.map((b) => ({
    label: b.label,
    revenue: round(b.metrics.revenue),
    cogs: round(b.metrics.cogs),
    ozonFees: round(b.metrics.ozonFeesTotal),
    tax: round(b.metrics.tax),
    other: round(b.metrics.otherExpenses),
    profit: round(b.metrics.netProfit),
  }));

  return (
    <ChartContainer style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 8, bottom: 4 }}>
          <XAxis dataKey="label" tickLine={false} axisLine={false} />
          <YAxis tickFormatter={(v) => formatTick(v)} tickLine={false} axisLine={false} width={64} />
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
                    ...SERIES.map((s) => ({ key: s.key, label: s.label, value: formatMoney(r[s.key]), color: s.color })),
                    { key: "profit", label: "Чистая прибыль", value: formatMoney(r.profit), emphasized: true, color: "hsl(var(--state-success-fg))" },
                  ]}
                />
              );
            }}
          />
          <Legend
            iconType="square"
            iconSize={9}
            wrapperStyle={{ fontSize: 12 }}
            formatter={(value) => <span className="text-muted-foreground">{value}</span>}
          />
          {SERIES.map((s) => (
            <Bar key={s.key} dataKey={s.key} stackId="exp" name={s.label} fill={s.color} isAnimationActive={false} radius={[0, 0, 0, 0]} />
          ))}
          <Line
            type="monotone"
            dataKey="profit"
            name="Чистая прибыль"
            stroke="hsl(var(--foreground))"
            strokeWidth={2}
            dot={{ r: 3, fill: "hsl(var(--background))", stroke: "hsl(var(--foreground))", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartContainer>
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
