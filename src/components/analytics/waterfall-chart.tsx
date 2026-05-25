"use client";

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltipCard } from "@/components/ui/chart";
import { formatMoney } from "@/lib/utils";
import type { WaterfallStep } from "@/lib/analytics";

interface Row {
  label: string;
  base: number;
  value: number;
  color: string;
  runningAfter: number;
  signed: number;
  kind: WaterfallStep["kind"];
}

function buildRows(steps: WaterfallStep[]): Row[] {
  const out: Row[] = [];
  let running = 0;
  for (const s of steps) {
    if (s.kind === "start") {
      running = s.amount;
      out.push({ label: s.label, base: 0, value: s.amount, color: s.color, runningAfter: running, signed: s.amount, kind: s.kind });
    } else if (s.kind === "subtract") {
      const v = Math.abs(s.amount);
      const newRunning = running - v;
      const base = Math.min(running, newRunning);
      out.push({ label: s.label, base, value: v, color: s.color, runningAfter: newRunning, signed: s.amount, kind: s.kind });
      running = newRunning;
    } else {
      out.push({ label: s.label, base: 0, value: Math.max(0, s.amount), color: s.color, runningAfter: s.amount, signed: s.amount, kind: s.kind });
    }
  }
  return out;
}

export function WaterfallChart({ steps, height = 320 }: { steps: WaterfallStep[]; height?: number }) {
  const rows = buildRows(steps);
  if (rows.length === 0) return null;

  return (
    <ChartContainer style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 24, right: 8, left: 8, bottom: 4 }}>
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            interval={0}
            tick={{ fontSize: 11 }}
            angle={-18}
            height={56}
            textAnchor="end"
          />
          <YAxis
            tickFormatter={(v) => formatTick(v)}
            tickLine={false}
            axisLine={false}
            width={64}
          />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted) / 0.4)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const r = payload[0].payload as Row;
              return (
                <ChartTooltipCard
                  title={r.label}
                  rows={[
                    { key: "v", label: r.kind === "subtract" ? "Сумма" : "Итог", value: formatMoney(Math.abs(r.signed)), color: r.color, emphasized: true },
                    { key: "after", label: r.kind === "subtract" ? "Остаток" : "Накопл.", value: formatMoney(r.runningAfter) },
                  ]}
                />
              );
            }}
          />
          <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="value" stackId="w" isAnimationActive={false} radius={[3, 3, 0, 0]}>
            {rows.map((r, i) => (
              <Cell key={i} fill={r.color} fillOpacity={r.kind === "subtract" ? 0.85 : 1} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartContainer>
  );
}

function formatTick(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(".0", "")}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
  return String(v);
}
