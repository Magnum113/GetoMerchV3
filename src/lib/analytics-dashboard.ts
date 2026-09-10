import {
  bucketize,
  bucketizeNonRedemption,
  bucketizeOrders,
  bucketizeOrdersRevenue,
  buildCostIndex,
  computePeriodMetrics,
  expenseBreakdown,
  nonRedemptionByProduct,
  ordersRevenueSummary,
  ordersSummary,
  previousPeriod,
  suggestGranularity,
  topProductsByProfit,
  type ExpenseBreakdownEntry,
  type Granularity,
  type NonRedemptionBucket,
  type OrdersBucket,
  type OrdersRevenueBucket,
  type OrdersRevenueSummary,
  type OrdersSummary,
  type PeriodFilter,
  type PeriodMetrics,
  type ProductNonRedemptionRow,
  type ProductProfitEntry,
  type TimeBucket,
} from "@/lib/analytics";
import { buildStockValueSummary, type StockValueSummary } from "@/lib/analytics-stock";
import type {
  Expense,
  ExpenseCategory,
  Inventory,
  OzonFinanceOperation,
  OzonOrder,
  Product,
  Warehouse,
} from "@/lib/types";

export const ANALYTICS_GRANULARITIES = ["day", "week", "month"] as const;

export interface SerializedPeriodFilter {
  from: string;
  to: string;
}

export interface AnalyticsGranularityView {
  buckets: TimeBucket[];
  ordersBuckets: OrdersBucket[];
  prevOrdersBuckets: OrdersBucket[];
  revenueBuckets: OrdersRevenueBucket[];
  prevRevenueBuckets: OrdersRevenueBucket[];
  nonRedemptionBuckets: NonRedemptionBucket[];
  prevNonRedemptionBuckets: NonRedemptionBucket[];
}

export interface AnalyticsDashboardSnapshot {
  period: SerializedPeriodFilter;
  previousPeriod: SerializedPeriodFilter;
  suggestedGranularity: Granularity;
  metrics: PeriodMetrics;
  prevMetrics: PeriodMetrics;
  breakdown: ExpenseBreakdownEntry[];
  ordersStats: OrdersSummary;
  prevOrdersStats: OrdersSummary;
  revenueStats: OrdersRevenueSummary;
  prevRevenueStats: OrdersRevenueSummary;
  productNonRedemption: ProductNonRedemptionRow[];
  topProducts: ProductProfitEntry[];
  stock: StockValueSummary;
  warehouses: Warehouse[];
  lastSync: string | null;
  sourceCounts: {
    orders: number;
    financeOperations: number;
    expenses: number;
    inventory: number;
  };
  granularities: Record<Granularity, AnalyticsGranularityView>;
}

export interface AnalyticsDashboardInput {
  filter: PeriodFilter;
  orders: OzonOrder[];
  financeOperations: OzonFinanceOperation[];
  expenses: Expense[];
  expenseCategories: ExpenseCategory[];
  skuMap: Array<{ ozon_sku: string; product: Product }>;
  inventory: Inventory[];
  warehouses: Warehouse[];
  lastSync: string | null;
}

export function buildAnalyticsDashboardSnapshot(
  input: AnalyticsDashboardInput,
): AnalyticsDashboardSnapshot {
  const prevFilter = previousPeriod(input.filter);
  const costIndex = buildCostIndex(input.orders, input.skuMap);
  const metrics = computePeriodMetrics(
    input.financeOperations,
    input.expenses,
    costIndex,
    input.filter,
    input.orders,
  );
  const prevMetrics = computePeriodMetrics(
    input.financeOperations,
    input.expenses,
    costIndex,
    prevFilter,
    input.orders,
  );

  const granularities = Object.fromEntries(
    ANALYTICS_GRANULARITIES.map((granularity) => [
      granularity,
      buildGranularityView(input, costIndex, prevFilter, granularity),
    ]),
  ) as Record<Granularity, AnalyticsGranularityView>;

  return {
    period: serializePeriod(input.filter),
    previousPeriod: serializePeriod(prevFilter),
    suggestedGranularity: suggestGranularity(input.filter),
    metrics,
    prevMetrics,
    breakdown: expenseBreakdown(
      metrics,
      input.expenses,
      input.expenseCategories,
      input.filter,
    ),
    ordersStats: ordersSummary(input.orders, input.filter),
    prevOrdersStats: ordersSummary(input.orders, prevFilter),
    revenueStats: ordersRevenueSummary(input.orders, input.filter),
    prevRevenueStats: ordersRevenueSummary(input.orders, prevFilter),
    productNonRedemption: nonRedemptionByProduct(input.orders, input.filter, 12),
    topProducts: topProductsByProfit(
      input.financeOperations,
      costIndex,
      input.filter,
      {
        tax: metrics.tax,
        ozonOther: metrics.ozonOther,
        otherExpenses: metrics.otherExpenses,
        totalRevenue: metrics.revenue,
      },
      8,
    ),
    stock: buildStockValueSummary(input.inventory, input.warehouses),
    warehouses: input.warehouses,
    lastSync: input.lastSync,
    sourceCounts: {
      orders: input.orders.length,
      financeOperations: input.financeOperations.length,
      expenses: input.expenses.length,
      inventory: input.inventory.length,
    },
    granularities,
  };
}

function buildGranularityView(
  input: AnalyticsDashboardInput,
  costIndex: ReturnType<typeof buildCostIndex>,
  prevFilter: PeriodFilter,
  granularity: Granularity,
): AnalyticsGranularityView {
  return {
    buckets: bucketize(
      input.financeOperations,
      input.expenses,
      costIndex,
      input.filter,
      granularity,
      input.orders,
    ),
    ordersBuckets: bucketizeOrders(input.orders, input.filter, granularity),
    prevOrdersBuckets: bucketizeOrders(input.orders, prevFilter, granularity),
    revenueBuckets: bucketizeOrdersRevenue(input.orders, input.filter, granularity),
    prevRevenueBuckets: bucketizeOrdersRevenue(input.orders, prevFilter, granularity),
    nonRedemptionBuckets: bucketizeNonRedemption(input.orders, input.filter, granularity),
    prevNonRedemptionBuckets: bucketizeNonRedemption(input.orders, prevFilter, granularity),
  };
}

function serializePeriod(filter: PeriodFilter): SerializedPeriodFilter {
  return {
    from: filter.from.toISOString(),
    to: filter.to.toISOString(),
  };
}
