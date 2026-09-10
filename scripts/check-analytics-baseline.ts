import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  bucketize,
  bucketizeNonRedemption,
  bucketizeOrders,
  bucketizeOrdersRevenue,
  buildCostIndex,
  computePeriodMetrics,
  delta,
  expenseBreakdown,
  formatDateRange,
  nonRedemptionByProduct,
  ordersRevenueSummary,
  ordersSummary,
  presetRange,
  previousPeriod,
  suggestGranularity,
  topProductsByProfit,
  type Granularity,
} from "../src/lib/analytics";
import { buildStockValueSummary } from "../src/lib/analytics-stock";
import { buildAnalyticsDashboardSnapshot } from "../src/lib/analytics-dashboard";
import type {
  Expense,
  ExpenseCategory,
  Inventory,
  OzonFinanceOperation,
  OzonOrder,
  Product,
  Warehouse,
} from "../src/lib/types";

type PresetKey = "7d" | "30d" | "90d" | "mtd" | "ytd";

const AS_OF = new Date("2026-09-10T12:00:00.000Z");
const PRESETS: PresetKey[] = ["7d", "30d", "90d", "mtd", "ytd"];
const GRANULARITIES: Granularity[] = ["day", "week", "month"];

function product(
  id: string,
  sku: string,
  options: { cost: number; sale: number; blank?: boolean; decoration?: "print" | "embroidery" },
): Product {
  const decoration = options.decoration ?? "print";
  return {
    id,
    category_id: "cat-tshirt",
    fabric_id: "fabric-regular",
    color_id: "color-white",
    size_id: "size-m",
    design_id: options.blank ? null : `design-${id}`,
    decoration_type_id: options.blank ? null : `decoration-${decoration}`,
    sku,
    ozon_sku: null,
    design_version: null,
    hoodie_fit: null,
    hoodie_fabric: null,
    is_blank: options.blank ?? false,
    cost_price: options.cost,
    sale_price: options.sale,
    created_at: "2025-01-01T00:00:00.000Z",
    category: { id: "cat-tshirt", name: "Футболка", slug: "tshirt", created_at: "2025-01-01T00:00:00.000Z" },
    decoration_type: options.blank
      ? null
      : {
          id: `decoration-${decoration}`,
          name: decoration === "print" ? "Принт" : "Вышивка",
          slug: decoration,
          made_at: "own",
          created_at: "2025-01-01T00:00:00.000Z",
        },
  };
}

const printA = product("product-print-a", "D1-TSH-PRT-WHT-M", { cost: 700, sale: 5_100 });
const printB = product("product-print-b", "D2-TSH-PRT-BLK-L", { cost: 800, sale: 4_000 });
const embroidery = product("product-embroidery", "D3-TSH-EMB-WHT-XL", {
  cost: 1_200,
  sale: 5_500,
  decoration: "embroidery",
});
const blank = product("product-blank", "BLANK-TSH-WHT-M", { cost: 450, sale: 0, blank: true });

function order(
  id: string,
  date: string,
  status: string,
  itemProduct: Product,
  quantity: number,
  price: number,
): OzonOrder {
  return {
    id,
    posting_number: id,
    order_id: null,
    order_number: id,
    status,
    substatus: null,
    ozon_created_at: date,
    in_process_at: date,
    shipment_date: null,
    delivery_method: null,
    warehouse_name: null,
    customer_name: null,
    total_price: price * quantity,
    source: "fbs",
    synced_at: date,
    shipped_at: null,
    shipped_from_warehouse_id: null,
    workshop_order_id: null,
    notes: null,
    created_at: date,
    items: [
      {
        id: `${id}-item`,
        order_id: id,
        offer_id: itemProduct.sku ?? id,
        ozon_sku: itemProduct === printB ? "2002" : itemProduct === embroidery ? "3003" : "1001",
        name: itemProduct.sku,
        quantity,
        price,
        product_id: itemProduct.id,
        product: itemProduct,
      },
    ],
  };
}

const orders: OzonOrder[] = [
  order("posting-sep-10", "2026-09-10T08:00:00.000Z", "delivered", printA, 2, 5_100),
  order("posting-sep-09", "2026-09-09T08:00:00.000Z", "cancelled", printA, 1, 5_100),
  order("posting-sep-08", "2026-09-08T08:00:00.000Z", "awaiting_deliver", printB, 1, 4_000),
  order("posting-sep-01", "2026-09-01T08:00:00.000Z", "delivered", embroidery, 1, 5_500),
  order("posting-aug-25", "2026-08-25T08:00:00.000Z", "not_accepted", printB, 2, 4_000),
  order("posting-aug-20", "2026-08-20T08:00:00.000Z", "delivered", embroidery, 1, 5_500),
  order("posting-aug-01", "2026-08-01T08:00:00.000Z", "delivered", printA, 1, 5_100),
  order("posting-jul-01", "2026-07-01T08:00:00.000Z", "delivered", printA, 1, 5_100),
  order("posting-apr-10", "2026-04-10T08:00:00.000Z", "delivered", printA, 1, 5_100),
  order("posting-jan-10", "2026-01-10T08:00:00.000Z", "delivered", embroidery, 1, 5_500),
  order("posting-dec-20", "2025-12-20T08:00:00.000Z", "cancelled", printA, 1, 5_100),
];

let operationId = 0;
function finance(
  id: string,
  date: string,
  postingNumber: string | null,
  accrual: number,
  commission: number,
  amount: number,
  services: number[],
  sku?: string,
): OzonFinanceOperation {
  operationId += 1;
  return {
    id,
    operation_id: operationId,
    operation_type: accrual > 0 ? "OperationAgentDeliveredToCustomer" : accrual < 0 ? "ClientReturnAgentOperation" : "Other",
    operation_type_name: null,
    operation_date: date,
    posting_number: postingNumber,
    accruals_for_sale: accrual,
    sale_commission: commission,
    amount,
    services: services.map((price, index) => ({ name: `service-${index + 1}`, price })),
    items: sku ? [{ sku }] : null,
    synced_at: date,
  };
}

const financeOperations: OzonFinanceOperation[] = [
  finance("finance-sep-10", "2026-09-10T12:00:00.000Z", "posting-sep-10", 10_200, -3_000, 6_500, [-700]),
  finance("finance-sep-09", "2026-09-09T12:00:00.000Z", "posting-sep-09", -5_100, 1_500, -3_400, [200]),
  finance("finance-sep-08", "2026-09-08T12:00:00.000Z", null, 4_000, -1_000, 2_600, [-400], "2002"),
  finance("finance-sep-07-fee", "2026-09-07T12:00:00.000Z", null, 0, 0, -250, []),
  finance("finance-sep-01", "2026-09-01T12:00:00.000Z", "posting-sep-01", 5_500, -1_200, 3_800, [-500]),
  finance("finance-aug-25", "2026-08-25T12:00:00.000Z", "posting-aug-25", -8_000, 2_000, -5_200, [800]),
  finance("finance-aug-20", "2026-08-20T12:00:00.000Z", "posting-aug-20", 5_500, -1_200, 3_800, [-500]),
  finance("finance-aug-01", "2026-08-01T12:00:00.000Z", "posting-aug-01", 5_100, -1_300, 3_300, [-500]),
  finance("finance-jul-01", "2026-07-01T12:00:00.000Z", "posting-jul-01", 5_100, -1_300, 3_300, [-500]),
  finance("finance-apr-10", "2026-04-10T12:00:00.000Z", "posting-apr-10", 5_100, -1_300, 3_300, [-500]),
  finance("finance-jan-10", "2026-01-10T12:00:00.000Z", "posting-jan-10", 5_500, -1_200, 3_800, [-500]),
  finance("finance-dec-20", "2025-12-20T12:00:00.000Z", "posting-dec-20", -5_100, 1_300, -3_300, [500]),
];

const categories: ExpenseCategory[] = [
  { id: "marketing", name: "Маркетинг", color: "hsl(160 60% 45%)", sort_order: 1, archived: false, created_at: "2025-01-01T00:00:00.000Z" },
  { id: "supplies", name: "Расходники", color: null, sort_order: 2, archived: false, created_at: "2025-01-01T00:00:00.000Z" },
];

const expenses: Expense[] = [
  { id: "expense-sep", category_id: "marketing", amount: 300, occurred_at: "2026-09-08", description: null, created_at: "2026-09-08T00:00:00.000Z" },
  { id: "expense-aug", category_id: null, amount: 200, occurred_at: "2026-08-25", description: null, created_at: "2026-08-25T00:00:00.000Z" },
  { id: "expense-apr", category_id: "supplies", amount: 150, occurred_at: "2026-04-10", description: null, created_at: "2026-04-10T00:00:00.000Z" },
  { id: "expense-jan", category_id: "marketing", amount: 100, occurred_at: "2026-01-10", description: null, created_at: "2026-01-10T00:00:00.000Z" },
];

const warehouses: Warehouse[] = [
  { id: "own", name: "Мой склад", type: "own", address: null, contact: null, notes: null, created_at: "2025-01-01T00:00:00.000Z" },
  { id: "workshop", name: "Цех", type: "workshop", address: null, contact: null, notes: null, created_at: "2025-01-01T00:00:00.000Z" },
];

const inventory: Inventory[] = [
  { id: "inv-blank", product_id: blank.id, warehouse_id: "own", quantity: 12, updated_at: "2026-09-10T00:00:00.000Z", product: blank },
  { id: "inv-print", product_id: printA.id, warehouse_id: "own", quantity: 3, updated_at: "2026-09-10T00:00:00.000Z", product: printA },
  { id: "inv-emb", product_id: embroidery.id, warehouse_id: "workshop", quantity: 2, updated_at: "2026-09-10T00:00:00.000Z", product: embroidery },
  { id: "inv-zero", product_id: printB.id, warehouse_id: "workshop", quantity: 0, updated_at: "2026-09-10T00:00:00.000Z", product: printB },
];

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function productProfitView(rows: ReturnType<typeof topProductsByProfit>) {
  return rows.map(({ product, ...row }) => ({ ...row, sku: product?.sku ?? null }));
}

function productNonRedemptionView(rows: ReturnType<typeof nonRedemptionByProduct>) {
  return rows.map(({ product, ...row }) => ({ ...row, productId: product?.id ?? null }));
}

function buildPresetBaseline(preset: PresetKey) {
  const filter = presetRange(preset, AS_OF);
  const prevFilter = previousPeriod(filter);
  const costIndex = buildCostIndex(orders, [{ ozon_sku: "2002", product: printB }]);
  const metrics = computePeriodMetrics(financeOperations, expenses, costIndex, filter, orders);
  const prevMetrics = computePeriodMetrics(financeOperations, expenses, costIndex, prevFilter, orders);
  const granularity = suggestGranularity(filter);
  const ordersStats = ordersSummary(orders, filter);
  const prevOrdersStats = ordersSummary(orders, prevFilter);
  const revenueStats = ordersRevenueSummary(orders, filter);
  const prevRevenueStats = ordersRevenueSummary(orders, prevFilter);
  const breakdown = expenseBreakdown(metrics, expenses, categories, filter);
  const topProducts = productProfitView(topProductsByProfit(
    financeOperations,
    costIndex,
    filter,
    {
      tax: metrics.tax,
      ozonOther: metrics.ozonOther,
      otherExpenses: metrics.otherExpenses,
      totalRevenue: metrics.revenue,
    },
    8,
  ));

  const fullView = {
    metrics,
    prevMetrics,
    metricDeltas: {
      revenue: delta(metrics.revenue, prevMetrics.revenue),
      orders: delta(metrics.ordersCount, prevMetrics.ordersCount),
      expenses: delta(metrics.totalExpenses, prevMetrics.totalExpenses),
      profit: delta(metrics.netProfit, prevMetrics.netProfit),
    },
    buckets: bucketize(financeOperations, expenses, costIndex, filter, granularity, orders),
    breakdown,
    ordersBuckets: bucketizeOrders(orders, filter, granularity),
    prevOrdersBuckets: bucketizeOrders(orders, prevFilter, granularity),
    ordersStats,
    prevOrdersStats,
    nonRedemptionRate: ordersStats.delivered + ordersStats.cancelled > 0
      ? ordersStats.cancelled / (ordersStats.delivered + ordersStats.cancelled)
      : 0,
    prevNonRedemptionRate: prevOrdersStats.delivered + prevOrdersStats.cancelled > 0
      ? prevOrdersStats.cancelled / (prevOrdersStats.delivered + prevOrdersStats.cancelled)
      : 0,
    revenueBuckets: bucketizeOrdersRevenue(orders, filter, granularity),
    prevRevenueBuckets: bucketizeOrdersRevenue(orders, prevFilter, granularity),
    revenueStats,
    prevRevenueStats,
    nonRedemptionBuckets: bucketizeNonRedemption(orders, filter, granularity),
    prevNonRedemptionBuckets: bucketizeNonRedemption(orders, prevFilter, granularity),
    productNonRedemption: productNonRedemptionView(nonRedemptionByProduct(orders, filter, 12)),
    topProducts,
  };

  const serverSnapshot = buildAnalyticsDashboardSnapshot({
    filter,
    orders,
    financeOperations,
    expenses,
    expenseCategories: categories,
    skuMap: [{ ozon_sku: "2002", product: printB }],
    inventory,
    warehouses,
    lastSync: "2026-09-10T12:00:00.000Z",
  });
  const serverGranularity = serverSnapshot.granularities[granularity];
  const serverFullView = {
    metrics: serverSnapshot.metrics,
    prevMetrics: serverSnapshot.prevMetrics,
    metricDeltas: {
      revenue: delta(serverSnapshot.metrics.revenue, serverSnapshot.prevMetrics.revenue),
      orders: delta(serverSnapshot.metrics.ordersCount, serverSnapshot.prevMetrics.ordersCount),
      expenses: delta(serverSnapshot.metrics.totalExpenses, serverSnapshot.prevMetrics.totalExpenses),
      profit: delta(serverSnapshot.metrics.netProfit, serverSnapshot.prevMetrics.netProfit),
    },
    buckets: serverGranularity.buckets,
    breakdown: serverSnapshot.breakdown,
    ordersBuckets: serverGranularity.ordersBuckets,
    prevOrdersBuckets: serverGranularity.prevOrdersBuckets,
    ordersStats: serverSnapshot.ordersStats,
    prevOrdersStats: serverSnapshot.prevOrdersStats,
    nonRedemptionRate:
      serverSnapshot.ordersStats.delivered + serverSnapshot.ordersStats.cancelled > 0
        ? serverSnapshot.ordersStats.cancelled
          / (serverSnapshot.ordersStats.delivered + serverSnapshot.ordersStats.cancelled)
        : 0,
    prevNonRedemptionRate:
      serverSnapshot.prevOrdersStats.delivered + serverSnapshot.prevOrdersStats.cancelled > 0
        ? serverSnapshot.prevOrdersStats.cancelled
          / (serverSnapshot.prevOrdersStats.delivered + serverSnapshot.prevOrdersStats.cancelled)
        : 0,
    revenueBuckets: serverGranularity.revenueBuckets,
    prevRevenueBuckets: serverGranularity.prevRevenueBuckets,
    revenueStats: serverSnapshot.revenueStats,
    prevRevenueStats: serverSnapshot.prevRevenueStats,
    nonRedemptionBuckets: serverGranularity.nonRedemptionBuckets,
    prevNonRedemptionBuckets: serverGranularity.prevNonRedemptionBuckets,
    productNonRedemption: productNonRedemptionView(serverSnapshot.productNonRedemption),
    topProducts: productProfitView(serverSnapshot.topProducts),
  };
  assert.deepStrictEqual(serverFullView, fullView);
  assert.deepStrictEqual(serverSnapshot.stock, buildStockValueSummary(inventory, warehouses));

  return {
    period: formatDateRange(filter),
    previousPeriod: formatDateRange(prevFilter),
    granularity,
    kpis: {
      revenue: metrics.revenue,
      orders: metrics.ordersCount,
      expenses: metrics.totalExpenses,
      netProfit: metrics.netProfit,
      margin: metrics.margin,
    },
    bucketCounts: {
      finance: fullView.buckets.length,
      orders: fullView.ordersBuckets.length,
      revenue: fullView.revenueBuckets.length,
      nonRedemption: fullView.nonRedemptionBuckets.length,
    },
    granularityHashes: Object.fromEntries(
      GRANULARITIES.map((candidate) => [
        candidate,
        digest({
          finance: bucketize(financeOperations, expenses, costIndex, filter, candidate, orders),
          orders: bucketizeOrders(orders, filter, candidate),
          previousOrders: bucketizeOrders(orders, prevFilter, candidate),
          revenue: bucketizeOrdersRevenue(orders, filter, candidate),
          previousRevenue: bucketizeOrdersRevenue(orders, prevFilter, candidate),
          nonRedemption: bucketizeNonRedemption(orders, filter, candidate),
          previousNonRedemption: bucketizeNonRedemption(orders, prevFilter, candidate),
        }),
      ]),
    ),
    fullViewHash: digest(fullView),
  };
}

const actual = {
  version: 1,
  asOf: AS_OF.toISOString(),
  presets: Object.fromEntries(PRESETS.map((preset) => [preset, buildPresetBaseline(preset)])),
  stock: buildStockValueSummary(inventory, warehouses),
};

if (process.argv.includes("--print")) {
  process.stdout.write(`${JSON.stringify(actual, null, 2)}\n`);
} else {
  const fixturePath = fileURLToPath(new URL("../tests/fixtures/analytics/dashboard-baseline.json", import.meta.url));
  const expected = JSON.parse(readFileSync(fixturePath, "utf8"));
  assert.deepStrictEqual(actual, expected);
  console.log("Analytics dashboard baseline: OK (5 presets, 3 granularities, stock totals)");
}
