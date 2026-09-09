import "server-only";

import { isRetryableOzonError, ozonPost } from "@/lib/ozon/client";

const MAX_PAGES_PER_DAY = 10_000;
const REQUEST_PAUSE_MS = 125;
const BALANCE_TOLERANCE = 0.02;

type Money = {
  amount?: string | number;
  currency?: string;
};

type AccrualFee = {
  type_id?: number | string;
  accrued?: Money | null;
};

type AccrualProduct = {
  sku?: number | string;
  delivery?: {
    total_accrued?: Money | null;
    services?: AccrualFee[] | null;
  } | null;
  commission?: {
    seller_price?: Money | null;
    sale_commission?: Money | null;
  } | null;
};

export type OzonFinanceAccrual = {
  accrual_id?: number | string;
  date?: string;
  total_amount?: Money | null;
  unit_number?: string;
  accrued_category?: string;
  posting?: {
    delivery_schema?: string;
    products?: AccrualProduct[] | null;
  } | null;
  item_fees?: {
    fees?: Array<{
      sku?: number | string;
      fees?: AccrualFee[] | null;
    }> | null;
  } | null;
  non_item_fee?: AccrualFee | null;
  container_fees?: {
    fees?: AccrualFee[] | null;
  } | null;
  [key: string]: unknown;
};

type AccrualType = {
  id?: number | string;
  name?: string;
  description?: string;
};

type AccrualTypeInfo = {
  name: string;
  description: string;
};

export type FinanceOperation = {
  operation_id: number;
  operation_type: string;
  operation_type_name: string;
  operation_date: string;
  accruals_for_sale: number;
  sale_commission: number;
  amount: number;
  posting: { posting_number: string } | null;
  items: Array<{ sku: number | string }>;
  services: Array<{ name: string; price: number }>;
  raw: OzonFinanceAccrual & { _getomerch_source: "finance_accrual_by_day" };
};

export type FinanceAccrualRange = {
  requestedFrom: string;
  requestedTo: string;
  replaceFrom: string;
  replaceTo: string;
  dates: string[];
};

export type FinanceAccrualFetchResult = FinanceAccrualRange & {
  operations: FinanceOperation[];
  accrualTypeCount: number;
};

type FetchOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: Record<string, unknown>, event?: string) => Promise<void> | void;
};

let cachedAccrualTypes: ReadonlyMap<number, AccrualTypeInfo> | null = null;

export async function fetchFinanceAccrualRange(
  from: string,
  to: string,
  options: FetchOptions = {},
): Promise<FinanceAccrualFetchResult> {
  const range = normalizeFinanceAccrualRange(from, to);
  const typeMap = await fetchAccrualTypes(options);
  const operations = new Map<number, FinanceOperation>();

  await options.onProgress?.({
    phase: "fetch",
    source: "finance_accrual_by_day",
    from: range.replaceFrom,
    to: range.replaceTo,
    days: range.dates.length,
    fetched: 0,
  }, "fetch_started");

  for (let dayIndex = 0; dayIndex < range.dates.length; dayIndex += 1) {
    assertNotCancelled(options.signal);
    const date = range.dates[dayIndex];
    const accruals = await fetchAccrualDay(date, options);
    for (const accrual of accruals) {
      const operation = mapFinanceAccrual(accrual, typeMap);
      if (operations.has(operation.operation_id)) {
        throw new Error(`Duplicate Ozon accrual_id ${operation.operation_id}`);
      }
      operations.set(operation.operation_id, operation);
    }
    if ((dayIndex + 1) % 7 === 0 || dayIndex + 1 === range.dates.length) {
      await options.onProgress?.({
        phase: "fetch_finance_day",
        source: "finance_accrual_by_day",
        day: dayIndex + 1,
        days: range.dates.length,
        date,
        fetched: operations.size,
      });
    }
    if (dayIndex + 1 < range.dates.length) await sleep(REQUEST_PAUSE_MS);
  }

  return {
    ...range,
    operations: Array.from(operations.values()),
    accrualTypeCount: typeMap.size,
  };
}

async function fetchAccrualTypes(options: FetchOptions) {
  if (cachedAccrualTypes) return cachedAccrualTypes;
  try {
    const response = await ozonPost<{ accrual_types?: AccrualType[] }>(
      "/v1/finance/accrual/types",
      {},
      { ...retryOptions(options), attempts: 1 },
    );
    cachedAccrualTypes = buildTypeMap(response.accrual_types ?? []);
  } catch (error) {
    if (!isRetryableOzonError(error)) throw error;
    await options.onProgress?.({
      phase: "finance_accrual_types_unavailable",
      source: "finance_accrual_by_day",
    }, "finance_accrual_types_unavailable");
    // Do not cache a transient failure: the next job should retry the
    // human-readable type dictionary without blocking this money sync.
    return new Map();
  }
  return cachedAccrualTypes;
}

export function normalizeFinanceAccrualRange(from: string, to: string): FinanceAccrualRange {
  const requestedFrom = new Date(from);
  const requestedTo = new Date(to);
  if (
    !Number.isFinite(requestedFrom.getTime())
    || !Number.isFinite(requestedTo.getTime())
    || requestedFrom >= requestedTo
  ) {
    throw new Error("Finance sync range is empty or invalid");
  }

  const firstDay = startOfUtcDay(requestedFrom);
  const lastIncludedDay = startOfUtcDay(new Date(requestedTo.getTime() - 1));
  const afterLastDay = addUtcDays(lastIncludedDay, 1);
  const dates: string[] = [];
  for (let cursor = firstDay; cursor < afterLastDay; cursor = addUtcDays(cursor, 1)) {
    dates.push(formatUtcDate(cursor));
  }

  return {
    requestedFrom: requestedFrom.toISOString(),
    requestedTo: requestedTo.toISOString(),
    replaceFrom: firstDay.toISOString(),
    replaceTo: afterLastDay.toISOString(),
    dates,
  };
}

export function mapFinanceAccrual(
  accrual: OzonFinanceAccrual,
  typeMap: ReadonlyMap<number, AccrualTypeInfo>,
): FinanceOperation {
  const operationId = Number(accrual.accrual_id);
  if (!Number.isSafeInteger(operationId) || operationId <= 0) {
    throw new Error(`Invalid Ozon accrual_id ${String(accrual.accrual_id)}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(accrual.date ?? ""))) {
    throw new Error(`Invalid date for Ozon accrual_id ${operationId}`);
  }

  const products = accrual.posting?.products ?? [];
  const accrualsForSale = sum(products.map((product) => money(product.commission?.seller_price, operationId)));
  const saleCommission = sum(products.map((product) => money(product.commission?.sale_commission, operationId)));
  const deliveryFees = products.flatMap((product) => product.delivery?.services ?? []);
  const itemGroups = accrual.item_fees?.fees ?? [];
  const itemFees = itemGroups.flatMap((group) => group.fees ?? []);
  const containerFees = accrual.container_fees?.fees ?? [];
  const serviceFees = [...deliveryFees, ...itemFees];
  const amount = money(accrual.total_amount, operationId);
  const componentTotal = accrualsForSale
    + saleCommission
    + sum(serviceFees.map((fee) => money(fee.accrued, operationId)))
    + money(accrual.non_item_fee?.accrued, operationId)
    + sum(containerFees.map((fee) => money(fee.accrued, operationId)));

  if (Math.abs(amount - componentTotal) > BALANCE_TOLERANCE) {
    throw new Error(
      `Ozon accrual ${operationId} is unbalanced: total=${amount}, components=${roundMoney(componentTotal)}`,
    );
  }

  const allFees = [...serviceFees, ...(accrual.non_item_fee ? [accrual.non_item_fee] : []), ...containerFees];
  const descriptions = unique(allFees.map((fee) => feeTypeInfo(fee.type_id, typeMap).description));
  const itemSkus = [
    ...products.map((product) => product.sku),
    ...itemGroups.map((group) => group.sku),
  ].filter((sku): sku is number | string => sku !== null && sku !== undefined && sku !== "");

  return {
    operation_id: operationId,
    operation_type: operationType(accrual),
    operation_type_name: descriptions.join(", ") || String(accrual.accrued_category || "Начисление Ozon"),
    operation_date: `${accrual.date}T00:00:00.000Z`,
    accruals_for_sale: roundMoney(accrualsForSale),
    sale_commission: roundMoney(saleCommission),
    amount: roundMoney(amount),
    posting: accrual.posting && accrual.unit_number
      ? { posting_number: String(accrual.unit_number) }
      : null,
    items: itemSkus.map((sku) => ({ sku })),
    // This exactly preserves the old dashboard split: delivery and item fees
    // are Ozon services; non-item/container fees stay in the residual bucket.
    services: serviceFees.map((fee) => ({
      name: feeTypeInfo(fee.type_id, typeMap).name,
      price: roundMoney(money(fee.accrued, operationId)),
    })),
    raw: { ...accrual, _getomerch_source: "finance_accrual_by_day" },
  };
}

async function fetchAccrualDay(date: string, options: FetchOptions) {
  const output: OzonFinanceAccrual[] = [];
  const seenCursors = new Set<string>();
  let lastId = "";
  for (let page = 1; page <= MAX_PAGES_PER_DAY; page += 1) {
    assertNotCancelled(options.signal);
    const response = await ozonPost<{ accruals?: OzonFinanceAccrual[]; last_id?: string }>(
      "/v1/finance/accrual/by-day",
      { date, last_id: lastId },
      retryOptions(options),
    );
    const accruals = response.accruals ?? [];
    output.push(...accruals);
    const next = String(response.last_id ?? "");
    if (!next) return output;
    if (seenCursors.has(next)) throw new Error(`Ozon finance cursor repeated for ${date}`);
    if (accruals.length === 0) throw new Error(`Ozon finance returned an empty cursor page for ${date}`);
    seenCursors.add(next);
    lastId = next;
    await sleep(REQUEST_PAUSE_MS);
  }
  throw new Error(`Finance pagination exceeded safety guard for ${date}`);
}

function retryOptions(options: FetchOptions) {
  return {
    signal: options.signal,
    attempts: 6,
    onRetry: ({ path, attempt, delayMs, status }: {
      path: string;
      attempt: number;
      delayMs: number;
      status: number | null;
    }) => options.onProgress?.(
      { phase: "ozon_retry", path, attempt, delayMs, status },
      "ozon_retry",
    ),
  };
}

function buildTypeMap(types: AccrualType[]) {
  const result = new Map<number, AccrualTypeInfo>();
  for (const type of types) {
    const id = Number(type.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    result.set(id, {
      name: String(type.name || `AccrualType${id}`),
      description: String(type.description || type.name || `Начисление ${id}`),
    });
  }
  return result;
}

function feeTypeInfo(typeId: number | string | undefined, types: ReadonlyMap<number, AccrualTypeInfo>) {
  const id = Number(typeId);
  return types.get(id) ?? {
    name: Number.isSafeInteger(id) ? `AccrualType${id}` : "AccrualTypeUnknown",
    description: Number.isSafeInteger(id) ? `Начисление ${id}` : "Неизвестное начисление",
  };
}

function operationType(accrual: OzonFinanceAccrual) {
  if (accrual.posting) return "FinanceAccrualPosting";
  if (accrual.item_fees) return "FinanceAccrualItem";
  if (accrual.non_item_fee) return "FinanceAccrualNonItem";
  if (accrual.container_fees) return "FinanceAccrualContainer";
  return `FinanceAccrual${String(accrual.accrued_category || "Unknown")}`;
}

function money(value: Money | null | undefined, operationId: number) {
  if (!value) return 0;
  if (value.currency && value.currency !== "RUB") {
    throw new Error(`Unsupported currency ${value.currency} for Ozon accrual ${operationId}`);
  }
  const amount = Number(value.amount ?? 0);
  if (!Number.isFinite(amount)) throw new Error(`Invalid amount for Ozon accrual ${operationId}`);
  return amount;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function startOfUtcDay(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addUtcDays(value: Date, days: number) {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function formatUtcDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function assertNotCancelled(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Job cancelled");
  }
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
