import "server-only";

import {
  buildAnalyticsDashboardSnapshot,
  type AnalyticsDashboardSnapshot,
} from "@/lib/analytics-dashboard";
import { isoDate, previousPeriod, type PeriodFilter } from "@/lib/analytics";
import { AdminApiError } from "@/lib/admin/http";
import { createDatabaseReadServices } from "@/lib/db/services/runtime";

const PAGE_SIZE = 500;
const MAX_PAGES = 2_000;

export interface AnalyticsDashboardLoadResult {
  snapshot: AnalyticsDashboardSnapshot;
  timing: {
    databaseMs: number;
    calculationMs: number;
    totalMs: number;
  };
}

export async function loadAnalyticsDashboard(
  filter: PeriodFilter,
): Promise<AnalyticsDashboardLoadResult> {
  const startedAt = performance.now();
  const previous = previousPeriod(filter);
  const dataFrom = previous.from < filter.from ? previous.from : filter.from;
  const dataTo = previous.to > filter.to ? previous.to : filter.to;
  const expenseToInclusive = new Date(dataTo.getTime() - 1);
  const services = createDatabaseReadServices();

  const [
    orders,
    financeOperations,
    expenses,
    expenseCategories,
    skuMap,
    inventory,
    warehouses,
    lastSync,
  ] = await Promise.all([
    listAllPages("заказов Ozon", (offset) =>
      services.ozonOrders.list({ limit: PAGE_SIZE, offset })),
    listAllPages("финансовых операций Ozon", (offset) =>
      services.finance.list({
        limit: PAGE_SIZE,
        offset,
        from: dataFrom.toISOString(),
        to: dataTo.toISOString(),
      })),
    listAllPages("расходов", (offset) =>
      services.expenses.list({
        limit: PAGE_SIZE,
        offset,
        from: isoDate(dataFrom),
        to: isoDate(expenseToInclusive),
      })),
    services.catalog.listExpenseCategories(),
    services.finance.listOzonSkuProductMap(),
    listAllPages("остатков", (offset) =>
      services.inventory.listInventory({ limit: PAGE_SIZE, offset })),
    services.catalog.listWarehouses(),
    services.finance.lastSyncAt(),
  ]);
  const databaseFinishedAt = performance.now();

  const snapshot = buildAnalyticsDashboardSnapshot({
    filter,
    orders,
    financeOperations,
    expenses,
    expenseCategories,
    skuMap,
    inventory,
    warehouses,
    lastSync,
  });
  const finishedAt = performance.now();

  return {
    snapshot,
    timing: {
      databaseMs: roundMilliseconds(databaseFinishedAt - startedAt),
      calculationMs: roundMilliseconds(finishedAt - databaseFinishedAt),
      totalMs: roundMilliseconds(finishedAt - startedAt),
    },
  };
}

async function listAllPages<T>(
  label: string,
  fetchPage: (offset: number) => Promise<{ rows: T[]; hasMore: boolean }>,
): Promise<T[]> {
  const rows: T[] = [];

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const page = await fetchPage(pageNumber * PAGE_SIZE);
    rows.push(...page.rows);
    if (!page.hasMore) return rows;
  }

  throw new AdminApiError(
    500,
    "internal_error",
    `Полная загрузка ${label} превысила безопасный предел. Дашборд не показывает неполные данные.`,
  );
}

function roundMilliseconds(value: number) {
  return Math.round(value * 10) / 10;
}
