import type {
  Expense,
  ExpenseCategory,
  OzonFinanceOperation,
  OzonOrder,
  Product,
} from "@/lib/types";

export const TAX_RATE = 0.06;

export type Granularity = "day" | "week" | "month";

export interface PeriodFilter {
  from: Date;
  to: Date;
}

export interface PeriodMetrics {
  revenue: number;
  returns: number;
  netRevenue: number;
  ozonCommission: number;
  ozonServices: number;
  ozonFeesTotal: number;
  cashFromOzon: number;
  cogs: number;
  tax: number;
  otherExpenses: number;
  totalExpenses: number;
  netProfit: number;
  margin: number;
  ordersCount: number;
  unitsSold: number;
}

export interface PostingCost {
  totalCost: number;
  units: number;
  productUnits: Map<string, number>;
}

export interface CostIndex {
  byPosting: Map<string, PostingCost>;
  productById: Map<string, Product>;
}

export function buildCostIndex(orders: OzonOrder[]): CostIndex {
  const byPosting = new Map<string, PostingCost>();
  const productById = new Map<string, Product>();
  for (const o of orders) {
    if (!o.posting_number) continue;
    let totalCost = 0;
    let units = 0;
    const productUnits = new Map<string, number>();
    for (const it of o.items ?? []) {
      const cost = Number(it.product?.cost_price ?? 0) * it.quantity;
      totalCost += cost;
      units += it.quantity;
      if (it.product_id) {
        productUnits.set(it.product_id, (productUnits.get(it.product_id) ?? 0) + it.quantity);
        if (it.product) productById.set(it.product_id, it.product);
      }
    }
    byPosting.set(o.posting_number, { totalCost, units, productUnits });
  }
  return { byPosting, productById };
}

export function computePeriodMetrics(
  ops: OzonFinanceOperation[],
  expenses: Expense[],
  cost: CostIndex,
  filter: PeriodFilter,
): PeriodMetrics {
  let revenue = 0;
  let returns = 0;
  let ozonCommission = 0;
  let ozonServices = 0;
  let cashFromOzon = 0;
  let cogs = 0;
  let unitsSold = 0;
  const orderNumbers = new Set<string>();

  for (const op of ops) {
    const d = new Date(op.operation_date);
    if (d < filter.from || d >= filter.to) continue;

    cashFromOzon += Number(op.amount ?? 0);

    const acc = Number(op.accruals_for_sale ?? 0);
    if (acc > 0) {
      revenue += acc;
      if (op.posting_number) {
        orderNumbers.add(op.posting_number);
        const c = cost.byPosting.get(op.posting_number);
        if (c) {
          cogs += c.totalCost;
          unitsSold += c.units;
        }
      }
    } else if (acc < 0) {
      returns += -acc;
      if (op.posting_number) {
        const c = cost.byPosting.get(op.posting_number);
        if (c) {
          cogs -= c.totalCost;
          unitsSold -= c.units;
        }
      }
    }

    const com = Number(op.sale_commission ?? 0);
    if (com < 0) ozonCommission += -com;
    else ozonCommission -= com;

    for (const s of op.services ?? []) {
      const p = Number(s.price ?? 0);
      if (p < 0) ozonServices += -p;
      else ozonServices -= p;
    }
  }

  let otherExpenses = 0;
  for (const e of expenses) {
    const d = new Date(e.occurred_at);
    if (d < filter.from || d >= filter.to) continue;
    otherExpenses += Number(e.amount);
  }

  const tax = Math.max(0, cashFromOzon) * TAX_RATE;
  const totalExpenses = cogs + ozonCommission + ozonServices + tax + otherExpenses;
  const netProfit = cashFromOzon - cogs - tax - otherExpenses;
  const margin = revenue > 0 ? netProfit / revenue : 0;

  return {
    revenue,
    returns,
    netRevenue: revenue - returns,
    ozonCommission,
    ozonServices,
    ozonFeesTotal: ozonCommission + ozonServices,
    cashFromOzon,
    cogs,
    tax,
    otherExpenses,
    totalExpenses,
    netProfit,
    margin,
    ordersCount: orderNumbers.size,
    unitsSold: Math.max(0, unitsSold),
  };
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function startOfWeekMonday(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = x.getUTCDay(); // 0=Sun
  const diff = (dow + 6) % 7; // monday = 0
  x.setUTCDate(x.getUTCDate() - diff);
  return x;
}

export function bucketKey(d: Date, gran: Granularity): string {
  if (gran === "day") return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (gran === "month") return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  const w = startOfWeekMonday(d);
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`;
}

const MONTH_LABELS = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"];

export function bucketLabel(key: string, gran: Granularity): string {
  const parts = key.split("-").map(Number);
  if (gran === "month") return `${MONTH_LABELS[parts[1] - 1]} ${parts[0]}`;
  return `${pad(parts[2])}.${pad(parts[1])}`;
}

export interface TimeBucket {
  key: string;
  label: string;
  metrics: PeriodMetrics;
}

function enumerateBuckets(filter: PeriodFilter, gran: Granularity): string[] {
  const out: string[] = [];
  const cur = new Date(Date.UTC(filter.from.getUTCFullYear(), filter.from.getUTCMonth(), filter.from.getUTCDate()));
  const end = filter.to;
  while (cur < end) {
    out.push(bucketKey(cur, gran));
    if (gran === "day") cur.setUTCDate(cur.getUTCDate() + 1);
    else if (gran === "week") cur.setUTCDate(cur.getUTCDate() + 7);
    else cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return Array.from(new Set(out));
}

export function bucketize(
  ops: OzonFinanceOperation[],
  expenses: Expense[],
  cost: CostIndex,
  filter: PeriodFilter,
  gran: Granularity,
): TimeBucket[] {
  const keys = enumerateBuckets(filter, gran);
  const opsByKey = new Map<string, OzonFinanceOperation[]>();
  const expensesByKey = new Map<string, Expense[]>();
  for (const k of keys) {
    opsByKey.set(k, []);
    expensesByKey.set(k, []);
  }
  for (const op of ops) {
    const d = new Date(op.operation_date);
    if (d < filter.from || d >= filter.to) continue;
    const k = bucketKey(d, gran);
    if (!opsByKey.has(k)) opsByKey.set(k, []);
    opsByKey.get(k)!.push(op);
  }
  for (const e of expenses) {
    const d = new Date(e.occurred_at);
    if (d < filter.from || d >= filter.to) continue;
    const k = bucketKey(d, gran);
    if (!expensesByKey.has(k)) expensesByKey.set(k, []);
    expensesByKey.get(k)!.push(e);
  }
  const out: TimeBucket[] = [];
  for (const k of Array.from(opsByKey.keys()).sort()) {
    const parts = k.split("-").map(Number);
    const bucketStart = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] ?? 1));
    const bucketEnd = new Date(bucketStart);
    if (gran === "day") bucketEnd.setUTCDate(bucketEnd.getUTCDate() + 1);
    else if (gran === "week") bucketEnd.setUTCDate(bucketEnd.getUTCDate() + 7);
    else bucketEnd.setUTCMonth(bucketEnd.getUTCMonth() + 1);
    const m = computePeriodMetrics(
      opsByKey.get(k) ?? [],
      expensesByKey.get(k) ?? [],
      cost,
      { from: bucketStart, to: bucketEnd },
    );
    out.push({ key: k, label: bucketLabel(k, gran), metrics: m });
  }
  return out;
}

export interface PeriodDelta {
  abs: number;
  pct: number | null;
}

export function delta(current: number, prev: number): PeriodDelta {
  const abs = current - prev;
  const pct = prev !== 0 ? abs / Math.abs(prev) : current !== 0 ? null : 0;
  return { abs, pct };
}

export function previousPeriod(filter: PeriodFilter): PeriodFilter {
  const span = filter.to.getTime() - filter.from.getTime();
  return {
    from: new Date(filter.from.getTime() - span),
    to: new Date(filter.from.getTime()),
  };
}

export interface ExpenseBreakdownEntry {
  key: string;
  label: string;
  color: string;
  amount: number;
  pct: number;
}

// Stable palette for built-in expense types — works in light/dark.
export const BUILTIN_EXPENSE_COLORS = {
  cogs: "hsl(220 70% 50%)",
  commission: "hsl(340 75% 55%)",
  services: "hsl(280 65% 60%)",
  tax: "hsl(30 90% 55%)",
} as const;

// Fallback palette for user categories without a configured color.
const CATEGORY_FALLBACK_PALETTE = [
  "hsl(160 60% 45%)",
  "hsl(45 85% 50%)",
  "hsl(200 70% 50%)",
  "hsl(15 75% 55%)",
  "hsl(265 60% 60%)",
  "hsl(100 50% 45%)",
  "hsl(330 60% 55%)",
];

export function expenseBreakdown(
  metrics: PeriodMetrics,
  expenses: Expense[],
  categories: ExpenseCategory[],
  filter: PeriodFilter,
): ExpenseBreakdownEntry[] {
  const entries: ExpenseBreakdownEntry[] = [];
  if (metrics.cogs > 0) {
    entries.push({ key: "cogs", label: "Себестоимость", color: BUILTIN_EXPENSE_COLORS.cogs, amount: metrics.cogs, pct: 0 });
  }
  if (metrics.ozonCommission > 0) {
    entries.push({ key: "commission", label: "Комиссия Ozon", color: BUILTIN_EXPENSE_COLORS.commission, amount: metrics.ozonCommission, pct: 0 });
  }
  if (metrics.ozonServices > 0) {
    entries.push({ key: "services", label: "Логистика и услуги Ozon", color: BUILTIN_EXPENSE_COLORS.services, amount: metrics.ozonServices, pct: 0 });
  }
  if (metrics.tax > 0) {
    entries.push({ key: "tax", label: "Налог УСН 6%", color: BUILTIN_EXPENSE_COLORS.tax, amount: metrics.tax, pct: 0 });
  }

  const byCategory = new Map<string, number>();
  const noCategoryTotal = { value: 0 };
  for (const e of expenses) {
    const d = new Date(e.occurred_at);
    if (d < filter.from || d >= filter.to) continue;
    if (e.category_id) byCategory.set(e.category_id, (byCategory.get(e.category_id) ?? 0) + Number(e.amount));
    else noCategoryTotal.value += Number(e.amount);
  }
  let paletteIdx = 0;
  for (const cat of categories) {
    const amount = byCategory.get(cat.id) ?? 0;
    if (amount <= 0) continue;
    const color = cat.color || CATEGORY_FALLBACK_PALETTE[paletteIdx++ % CATEGORY_FALLBACK_PALETTE.length];
    entries.push({ key: `cat:${cat.id}`, label: cat.name, color, amount, pct: 0 });
  }
  if (noCategoryTotal.value > 0) {
    entries.push({ key: "no-category", label: "Без категории", color: "hsl(0 0% 55%)", amount: noCategoryTotal.value, pct: 0 });
  }

  const total = entries.reduce((s, x) => s + x.amount, 0);
  for (const x of entries) x.pct = total > 0 ? x.amount / total : 0;
  entries.sort((a, b) => b.amount - a.amount);
  return entries;
}

export interface ProductProfitEntry {
  productId: string;
  product: Product | undefined;
  unitsSold: number;
  revenue: number;
  cogs: number;
  profit: number;
  marginPct: number;
}

export function topProductsByProfit(
  ops: OzonFinanceOperation[],
  cost: CostIndex,
  filter: PeriodFilter,
  limit = 10,
): ProductProfitEntry[] {
  const stats = new Map<string, { units: number; revenue: number; cogs: number }>();
  for (const op of ops) {
    const d = new Date(op.operation_date);
    if (d < filter.from || d >= filter.to) continue;
    const acc = Number(op.accruals_for_sale ?? 0);
    // Only "sale" or "return" operations represent product flow.
    // Fees/fines/acquiring with the same posting_number must not move COGS.
    if (acc === 0) continue;
    if (!op.posting_number) continue;
    const c = cost.byPosting.get(op.posting_number);
    if (!c) continue;
    const totalUnits = c.units;
    if (totalUnits === 0) continue;
    const sign = acc > 0 ? 1 : -1;
    for (const [pid, units] of c.productUnits) {
      const share = units / totalUnits;
      const entry = stats.get(pid) ?? { units: 0, revenue: 0, cogs: 0 };
      entry.units += sign * units;
      entry.revenue += acc * share;
      const product = cost.productById.get(pid);
      const unitCost = Number(product?.cost_price ?? 0);
      entry.cogs += sign * unitCost * units;
      stats.set(pid, entry);
    }
  }
  const out: ProductProfitEntry[] = [];
  for (const [pid, s] of stats) {
    const profit = s.revenue - s.cogs;
    out.push({
      productId: pid,
      product: cost.productById.get(pid),
      unitsSold: s.units,
      revenue: s.revenue,
      cogs: s.cogs,
      profit,
      marginPct: s.revenue > 0 ? profit / s.revenue : 0,
    });
  }
  out.sort((a, b) => b.profit - a.profit);
  return out.slice(0, limit);
}

export interface WaterfallStep {
  key: string;
  label: string;
  amount: number;
  kind: "start" | "subtract" | "end";
  color: string;
}

export function waterfallSteps(metrics: PeriodMetrics, breakdown: ExpenseBreakdownEntry[]): WaterfallStep[] {
  const steps: WaterfallStep[] = [];
  steps.push({ key: "revenue", label: "Выручка", amount: metrics.revenue, kind: "start", color: "hsl(var(--state-success-fg))" });
  if (metrics.returns > 0) {
    steps.push({ key: "returns", label: "Возвраты", amount: -metrics.returns, kind: "subtract", color: "hsl(var(--state-danger-fg))" });
  }
  for (const b of breakdown) {
    steps.push({ key: b.key, label: b.label, amount: -b.amount, kind: "subtract", color: b.color });
  }
  steps.push({ key: "net", label: "Чистая прибыль", amount: metrics.netProfit, kind: "end", color: metrics.netProfit >= 0 ? "hsl(var(--state-success-fg))" : "hsl(var(--state-danger-fg))" });
  return steps;
}

// Build [from, to) given a preset key, with `to` being start of tomorrow (exclusive).
export function presetRange(preset: "7d" | "30d" | "90d" | "mtd" | "ytd"): PeriodFilter {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const to = new Date(todayUtc);
  to.setUTCDate(to.getUTCDate() + 1);
  const from = new Date(todayUtc);
  switch (preset) {
    case "7d":
      from.setUTCDate(from.getUTCDate() - 6);
      break;
    case "30d":
      from.setUTCDate(from.getUTCDate() - 29);
      break;
    case "90d":
      from.setUTCDate(from.getUTCDate() - 89);
      break;
    case "mtd":
      from.setUTCDate(1);
      break;
    case "ytd":
      from.setUTCMonth(0, 1);
      break;
  }
  return { from, to };
}

export function suggestGranularity(filter: PeriodFilter): Granularity {
  const days = (filter.to.getTime() - filter.from.getTime()) / 86400000;
  if (days <= 31) return "day";
  if (days <= 120) return "week";
  return "month";
}

export function formatDateRange(filter: PeriodFilter): string {
  const fmt = (d: Date) => `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  const lastDay = new Date(filter.to.getTime() - 86400000);
  return `${fmt(filter.from)} — ${fmt(lastDay)}`;
}

export function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
