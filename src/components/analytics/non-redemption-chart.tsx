"use client";

import { Bar, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltipCard, type TooltipRow } from "@/components/ui/chart";
import type { NonRedemptionBucket } from "@/lib/analytics";

const RATE_COLOR = "hsl(var(--state-danger-fg))";
const VOLUME_COLOR = "hsl(var(--state-neutral-bg))";
const PREV_COLOR = "hsl(var(--muted-foreground))";
const PREV_KEY = "prevRatePct";

interface Row extends NonRedemptionBucket {
  ratePct: number;
  prevRatePct?: number;
  prevLabel?: string;
  prevTerminal?: number;
  prevNonRedeemed?: number;
}

export function NonRedemptionChart({
  buckets,
  prevBuckets,
  height = 280,
}: {
  buckets: NonRedemptionBucket[];
  prevBuckets?: NonRedemptionBucket[];
  height?: number;
}) {
  const rows: Row[] = buckets.map((b, i) => {
    const prev = prevBuckets?.[i];
    return {
      ...b,
      ratePct: roundPct(b.rate),
      prevRatePct: prev ? roundPct(prev.rate) : undefined,
      prevLabel: prev?.label,
      prevTerminal: prev?.terminal,
      prevNonRedeemed: prev?.nonRedeemed,
    };
  });

  return (
    <div className="space-y-3">
      <ChartContainer style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 8, bottom: 4 }}>
            <XAxis dataKey="label" tickLine={false} axisLine={false} />
            <YAxis yAxisId="rate" tickFormatter={(v) => `${v}%`} tickLine={false} axisLine={false} width={42} />
            <YAxis yAxisId="volume" orientation="right" tickLine={false} axisLine={false} allowDecimals={false} width={36} />
            <Tooltip
              cursor={{ fill: "hsl(var(--muted) / 0.4)" }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const r = payload[0].payload as Row;
                const tooltipRows: TooltipRow[] = [
                  { key: "rate", label: "Невыкуп", value: `${r.ratePct.toFixed(1)}%`, emphasized: true, color: RATE_COLOR },
                  { key: "nonRedeemed", label: "Не выкупили", value: String(r.nonRedeemed), color: RATE_COLOR },
                  { key: "delivered", label: "Доставлено", value: String(r.delivered) },
                  { key: "terminal", label: "Финализировано", value: String(r.terminal) },
                  { key: "inflight", label: "Ещё в процессе", value: String(r.inflight) },
                ];
                if (r.prevRatePct != null) {
                  tooltipRows.push({
                    key: "prev",
                    label: r.prevLabel ? `Пред. период (${r.prevLabel})` : "Пред. период",
                    value: `${r.prevRatePct.toFixed(1)}%`,
                    color: PREV_COLOR,
                  });
                }
                return <ChartTooltipCard title={label} rows={tooltipRows} />;
              }}
            />
            <Bar
              yAxisId="volume"
              dataKey="terminal"
              name="Финализировано"
              fill={VOLUME_COLOR}
              isAnimationActive={false}
              radius={[2, 2, 0, 0]}
            />
            <Line
              yAxisId="rate"
              type="monotone"
              dataKey="ratePct"
              name="Невыкуп"
              stroke={RATE_COLOR}
              strokeWidth={2}
              dot={{ r: 3, fill: "hsl(var(--background))", stroke: RATE_COLOR, strokeWidth: 2 }}
              isAnimationActive={false}
            />
            {prevBuckets && (
              <Line
                yAxisId="rate"
                type="monotone"
                dataKey={PREV_KEY}
                name="Пред. период"
                stroke={PREV_COLOR}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={{ r: 2, fill: "hsl(var(--background))", stroke: PREV_COLOR, strokeWidth: 1.5 }}
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartContainer>

      <div className="flex flex-wrap gap-x-3 gap-y-1.5 justify-center px-2">
        <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1">
          <span className="h-0.5 w-3.5 rounded-sm shrink-0" style={{ background: RATE_COLOR, height: 2 }} />
          <span>Невыкуп</span>
        </span>
        <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1">
          <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: VOLUME_COLOR }} />
          <span>Финализировано</span>
        </span>
        {prevBuckets && (
          <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1">
            <span className="h-0.5 w-3.5 rounded-sm shrink-0" style={{ background: PREV_COLOR, height: 2 }} />
            <span>Пред. период</span>
          </span>
        )}
      </div>
    </div>
  );
}

function roundPct(rate: number): number {
  return Math.round(rate * 1000) / 10;
}
