"use client";

import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";

export function Sparkline({ data, color = "hsl(var(--primary))" }: { data: number[]; color?: string }) {
  if (!data.length) return <div className="h-8" />;
  const rows = data.map((v, i) => ({ i, v }));
  return (
    <div className="h-8 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={`spark-${color.replace(/[^a-z0-9]/gi, "")}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#spark-${color.replace(/[^a-z0-9]/gi, "")})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
