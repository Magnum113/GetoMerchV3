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
  ozonOther: number;
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
  bySku: Map<string, Product>;
  productById: Map<string, Product>;
}

export function buildCostIndex(orders: OzonOrder[], skuMap?: Array<{ ozon_sku: string; product: Product }>): CostIndex {
  const byPosting = new Map<string, PostingCost>();
  const productById = new Map<string, Product>();
  const bySku = new Map<string, Product>();
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
      // Build SKU map from order items as we go — covers most of catalog cheaply.
      if (it.ozon_sku && it.product) {
        bySku.set(String(it.ozon_sku), it.product);
        productById.set(it.product.id, it.product);
      }
    }
    byPosting.set(o.posting_number, { totalCost, units, productUnits });
  }
  // Allow explicit override / addition (e.g. snapshot directly queried)
  for (const entry of skuMap ?? []) {
    if (entry.ozon_sku && entry.product) {
      bySku.set(String(entry.ozon_sku), entry.product);
      productById.set(entry.product.id, entry.product);
    }
  }
  return { byPosting, bySku, productById };
}

// Resolve cost for a finance operation. Priority: exact posting match in our
// orders → fallback to Ozon SKU lookup from items. Ozon's
// /v3/finance/transaction/list items only carry {sku, name} — no quantity —
// so for a single-item op we infer qty from accruals_for_sale / sale_price
// when possible (otherwise default to 1).
function lookupCost(op: OzonFinanceOperation, cost: CostIndex): PostingCost | null {
  if (op.posting_number) {
    const c = cost.byPosting.get(op.posting_number);
    if (c) return c;
  }
  const items = op.items ?? [];
  if (items.length === 0) return null;
  const acc = Math.abs(Number(op.accruals_for_sale ?? 0));
  let totalCost = 0;
  let units = 0;
  const productUnits = new Map<string, number>();

  // Single-item fallback: try to infer quantity from price.
  if (items.length === 1 && items[0].sku != null) {
    const product = cost.bySku.get(String(items[0].sku));
    if (product) {
      const sale = Number(product.sale_price ?? 0);
      let qty = 1;
      if (sale > 0 && acc > 0) {
        const ratio = acc / sale;
        // accept inference only when accruals are a near-integer multiple of sale_price
        if (ratio >= 0.5 && Math.abs(ratio - Math.round(ratio)) < 0.15) {
          qty = Math.max(1, Math.round(ratio));
        }
      }
      const unitCost = Number(product.cost_price ?? 0);
      return {
        totalCost: unitCost * qty,
        units: qty,
        productUnits: new Map([[product.id, qty]]),
      };
    }
  }

  // Multi-item op: assume 1 per item entry (best we can do without qty data).
  for (const it of items) {
    if (it.sku == null) continue;
    const product = cost.bySku.get(String(it.sku));
    if (!product) continue;
    const c = Number(product.cost_price ?? 0);
    totalCost += c;
    units += 1;
    productUnits.set(product.id, (productUnits.get(product.id) ?? 0) + 1);
  }
  if (units === 0) return null;
  return { totalCost, units, productUnits };
}

export function computePeriodMetrics(
  ops: OzonFinanceOperation[],
  expenses: Expense[],
  cost: CostIndex,
  filter: PeriodFilter,
  orders: OzonOrder[] = [],
): PeriodMetrics {
  let revenue = 0;
  let returns = 0;
  let ozonCommission = 0;
  let ozonServices = 0;
  let cashFromOzon = 0;
  let cogs = 0;
  let unitsSold = 0;

  for (const op of ops) {
    const d = new Date(op.operation_date);
    if (d < filter.from || d >= filter.to) continue;

    cashFromOzon += Number(op.amount ?? 0);

    const acc = Number(op.accruals_for_sale ?? 0);
    if (acc > 0) {
      revenue += acc;
      const c = lookupCost(op, cost);
      if (c) {
        cogs += c.totalCost;
        unitsSold += c.units;
      }
    } else if (acc < 0) {
      returns += -acc;
      const c = lookupCost(op, cost);
      if (c) {
        cogs -= c.totalCost;
        unitsSold -= c.units;
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

  // Заказы — суммируем КОЛИЧЕСТВО единиц товара в заказах за период (по дате
  // создания в Ozon, in_process_at). Это то, что владельцу важно: сколько
  // штук людям продали. Если в одном отправлении 3 футболки — это 3, а не 1.
  // Финопы с продажами падают позже (когда заказ доставлен), поэтому через
  // них считать заказы неправильно.
  let ordersCount = 0;
  for (const o of orders) {
    const dStr = o.in_process_at ?? o.ozon_created_at ?? o.created_at;
    if (!dStr) continue;
    const d = new Date(dStr);
    if (d < filter.from || d >= filter.to) continue;
    ordersCount += orderItemsUnits(o);
  }

  // Residual: everything Ozon withheld that's NOT explicit commission/services
  // (fines, return-handling fees, acquiring, subscriptions, packaging, etc.).
  // Derived so the waterfall balances cashFromOzon perfectly.
  const ozonOther = Math.max(0, revenue - returns - cashFromOzon - ozonCommission - ozonServices);
  const tax = Math.max(0, cashFromOzon) * TAX_RATE;
  // Returns reduce profit just like an expense → include them in totalExpenses
  // so the "Выручка − Расходы = Прибыль" mental model holds in KPIs and donut.
  const totalExpenses = returns + cogs + ozonCommission + ozonServices + ozonOther + tax + otherExpenses;
  const netProfit = cashFromOzon - cogs - tax - otherExpenses;
  const margin = revenue > 0 ? netProfit / revenue : 0;

  return {
    revenue,
    returns,
    netRevenue: revenue - returns,
    ozonCommission,
    ozonServices,
    ozonOther,
    ozonFeesTotal: ozonCommission + ozonServices + ozonOther,
    cashFromOzon,
    cogs,
    tax,
    otherExpenses,
    totalExpenses,
    netProfit,
    margin,
    ordersCount,
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
  orders: OzonOrder[] = [],
): TimeBucket[] {
  const opsByKey = new Map<string, OzonFinanceOperation[]>();
  const expensesByKey = new Map<string, Expense[]>();
  const ordersByKey = new Map<string, OzonOrder[]>();
  for (const k of enumerateBuckets(filter, gran)) {
    opsByKey.set(k, []);
    expensesByKey.set(k, []);
    ordersByKey.set(k, []);
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
  for (const o of orders) {
    const dStr = o.in_process_at ?? o.ozon_created_at ?? o.created_at;
    if (!dStr) continue;
    const d = new Date(dStr);
    if (d < filter.from || d >= filter.to) continue;
    const k = bucketKey(d, gran);
    if (!ordersByKey.has(k)) ordersByKey.set(k, []);
    ordersByKey.get(k)!.push(o);
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
      ordersByKey.get(k) ?? [],
    );
    out.push({ key: k, label: bucketLabel(k, gran), metrics: m });
  }
  return out;
}

// Классификация статуса Ozon-заказа для воронки доставки.
//  - delivered:   доставлен
//  - cancelled:   отменён / не принят (выкуп не состоится)
//  - inflight:    всё остальное — в работе у нас или в логистике
export type OrderFunnelStage = "delivered" | "cancelled" | "inflight";

export function classifyOrderStatus(status: string): OrderFunnelStage {
  if (status === "delivered") return "delivered";
  if (status === "cancelled" || status === "not_accepted") return "cancelled";
  return "inflight";
}

function orderItemsUnits(o: OzonOrder): number {
  let n = 0;
  for (const it of o.items ?? []) n += Number(it.quantity ?? 0);
  return n || 1; // если позиции не подгружены — считаем минимум 1
}

export interface OrdersBucket {
  key: string;
  label: string;
  total: number;        // единицы товара
  delivered: number;
  cancelled: number;
  inflight: number;
  orders: number;       // сколько отправлений за этот день (для тултипа)
}

export function bucketizeOrders(
  orders: OzonOrder[],
  filter: PeriodFilter,
  gran: Granularity,
): OrdersBucket[] {
  const byKey = new Map<string, OrdersBucket>();
  for (const k of enumerateBuckets(filter, gran)) {
    byKey.set(k, { key: k, label: bucketLabel(k, gran), total: 0, delivered: 0, cancelled: 0, inflight: 0, orders: 0 });
  }
  for (const o of orders) {
    const dStr = o.in_process_at ?? o.ozon_created_at ?? o.created_at;
    if (!dStr) continue;
    const d = new Date(dStr);
    if (d < filter.from || d >= filter.to) continue;
    const k = bucketKey(d, gran);
    if (!byKey.has(k)) byKey.set(k, { key: k, label: bucketLabel(k, gran), total: 0, delivered: 0, cancelled: 0, inflight: 0, orders: 0 });
    const b = byKey.get(k)!;
    const units = orderItemsUnits(o);
    b.total += units;
    b[classifyOrderStatus(o.status)] += units;
    b.orders += 1;
  }
  return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
}

export interface OrdersSummary {
  total: number;        // единицы товара
  delivered: number;
  cancelled: number;
  inflight: number;
  orders: number;       // отправлений
  // Доля доставленных единиц среди финализированных (доставлено + отменено).
  // «В процессе» исключаем — про них пока ничего не известно.
  fulfillmentRate: number;
}

export function ordersSummary(orders: OzonOrder[], filter: PeriodFilter): OrdersSummary {
  let total = 0, delivered = 0, cancelled = 0, inflight = 0, ordersCount = 0;
  for (const o of orders) {
    const dStr = o.in_process_at ?? o.ozon_created_at ?? o.created_at;
    if (!dStr) continue;
    const d = new Date(dStr);
    if (d < filter.from || d >= filter.to) continue;
    const units = orderItemsUnits(o);
    total += units;
    ordersCount += 1;
    const cat = classifyOrderStatus(o.status);
    if (cat === "delivered") delivered += units;
    else if (cat === "cancelled") cancelled += units;
    else inflight += units;
  }
  const terminal = delivered + cancelled;
  return {
    total,
    delivered,
    cancelled,
    inflight,
    orders: ordersCount,
    fulfillmentRate: terminal > 0 ? delivered / terminal : 0,
  };
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
  ozonOther: "hsl(200 50% 45%)",
  returns: "hsl(0 65% 50%)",
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
  if (metrics.returns > 0) {
    entries.push({ key: "returns", label: "Возвраты покупателей", color: BUILTIN_EXPENSE_COLORS.returns, amount: metrics.returns, pct: 0 });
  }
  if (metrics.cogs > 0) {
    entries.push({ key: "cogs", label: "Себестоимость", color: BUILTIN_EXPENSE_COLORS.cogs, amount: metrics.cogs, pct: 0 });
  }
  if (metrics.ozonCommission > 0) {
    entries.push({ key: "commission", label: "Комиссия Ozon", color: BUILTIN_EXPENSE_COLORS.commission, amount: metrics.ozonCommission, pct: 0 });
  }
  if (metrics.ozonServices > 0) {
    entries.push({ key: "services", label: "Логистика и услуги Ozon", color: BUILTIN_EXPENSE_COLORS.services, amount: metrics.ozonServices, pct: 0 });
  }
  if (metrics.ozonOther > 0) {
    entries.push({ key: "ozonOther", label: "Прочие удержания Ozon (штрафы, возвраты, эквайринг)", color: BUILTIN_EXPENSE_COLORS.ozonOther, amount: metrics.ozonOther, pct: 0 });
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
  ozonFees: number;       // commission + services, прямая атрибуция по op
  allocatedOverhead: number; // налог + «прочие удержания Ozon» + ручные расходы, пропорция от выручки
  netProfit: number;      // revenue - cogs - ozonFees - allocatedOverhead
  marginPct: number;
}

// Per-SKU чистая прибыль с аллокацией всех расходов:
// - Себестоимость — прямая (per unit × unit cost)
// - Комиссия Ozon + услуги Ozon — прямая по каждой операции, распределяется
//   между товарами заказа пропорционально количеству
// - Налог УСН 6%, «Прочие удержания Ozon», ручные расходы — общие, поэтому
//   распределяются пропорционально доле товара в общей выручке периода
export function topProductsByProfit(
  ops: OzonFinanceOperation[],
  cost: CostIndex,
  filter: PeriodFilter,
  overhead: { tax: number; ozonOther: number; otherExpenses: number; totalRevenue: number },
  limit = 10,
): ProductProfitEntry[] {
  const stats = new Map<string, { units: number; revenue: number; cogs: number; ozonFees: number }>();
  for (const op of ops) {
    const d = new Date(op.operation_date);
    if (d < filter.from || d >= filter.to) continue;
    const acc = Number(op.accruals_for_sale ?? 0);
    // Only "sale" or "return" operations represent product flow.
    // Fees/fines/acquiring with the same posting_number must not move COGS.
    if (acc === 0) continue;
    const c = lookupCost(op, cost);
    if (!c) continue;
    const totalUnits = c.units;
    if (totalUnits === 0) continue;
    const sign = acc > 0 ? 1 : -1;

    // Расходы Ozon для этой операции (положительное число = вычет).
    // При возврате (acc < 0) комиссия часто возвращается с положительным sale_commission —
    // тогда opCommission < 0 (вычитаемое уменьшается). Это правильно: возврат
    // отдаёт комиссию обратно.
    const opCommission = -Number(op.sale_commission ?? 0);
    let opServices = 0;
    for (const s of op.services ?? []) opServices += -Number(s.price ?? 0);
    const opFees = opCommission + opServices;

    for (const [pid, units] of c.productUnits) {
      const share = units / totalUnits;
      const entry = stats.get(pid) ?? { units: 0, revenue: 0, cogs: 0, ozonFees: 0 };
      entry.units += sign * units;
      entry.revenue += acc * share;
      const product = cost.productById.get(pid);
      const unitCost = Number(product?.cost_price ?? 0);
      entry.cogs += sign * unitCost * units;
      entry.ozonFees += opFees * share;
      stats.set(pid, entry);
    }
  }
  const out: ProductProfitEntry[] = [];
  const allOverhead = overhead.tax + overhead.ozonOther + overhead.otherExpenses;
  for (const [pid, s] of stats) {
    const revenueShare = overhead.totalRevenue > 0 ? s.revenue / overhead.totalRevenue : 0;
    const allocatedOverhead = allOverhead * revenueShare;
    const netProfit = s.revenue - s.cogs - s.ozonFees - allocatedOverhead;
    out.push({
      productId: pid,
      product: cost.productById.get(pid),
      unitsSold: s.units,
      revenue: s.revenue,
      cogs: s.cogs,
      ozonFees: s.ozonFees,
      allocatedOverhead,
      netProfit,
      marginPct: s.revenue > 0 ? netProfit / s.revenue : 0,
    });
  }
  out.sort((a, b) => b.netProfit - a.netProfit);
  return out.slice(0, limit);
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
