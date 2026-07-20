"use client";

import type {
  Color,
  Design,
  FabricType,
  Inventory,
  Product,
  ProductCategory,
  Size,
  Transaction,
  Warehouse,
  WorkshopOrder,
  DecorationType,
  DesignType,
  OzonOrder,
  OzonFinanceOperation,
  PrintInventory,
  Expense,
  ExpenseCategory,
  InventoryMatrix,
} from "@/lib/types";
import type { BackgroundJob } from "@/lib/jobs/types";
import type { OzonImportApplyResult, OzonImportPreview } from "@/lib/ozon-import";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error?: { code?: string; message?: string } };

type ApiSuccess<T> = { ok: true; data: T; meta?: Record<string, unknown> };

type ProductListFilters = {
  is_blank?: boolean;
  design_id?: string;
  search?: string;
};

type ProductPage = {
  items: Product[];
  nextCursor: string | null;
  hasMore: boolean;
};

type InventoryPage = {
  items: Inventory[];
  nextOffset: number | null;
  hasMore: boolean;
};

type OzonOrderPage = {
  items: OzonOrder[];
  nextOffset: number | null;
  hasMore: boolean;
};

type BlankMatchKey = {
  category_id: string;
  fabric_id: string;
  color_id: string;
  size_id: string;
};

type DesignProductCount = {
  design_id: string;
  count: number;
};

const ADMIN_REQUEST_TIMEOUT_MS = 30_000;

async function adminRpc<T>(action: string, args: unknown[] = []): Promise<T> {
  const idempotencyKey = crypto.randomUUID();
  const response = await adminFetch("/api/admin/rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": idempotencyKey,
      "X-Request-Id": crypto.randomUUID(),
    },
    body: JSON.stringify({ action, args }),
  });

  const payload = await readJson<ApiResponse<T>>(response);
  if (!response.ok || !payload?.ok) {
    throw apiError(response, payload);
  }

  return payload.data as T;
}

async function adminGet<T>(
  path: string,
  params: Record<string, string | number | boolean | null | undefined> = {},
  timeoutMs = ADMIN_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const payload = await adminGetPayload<T>(path, params, timeoutMs);
  return payload.data as T;
}

async function adminGetPayload<T>(
  path: string,
  params: Record<string, string | number | boolean | null | undefined> = {},
  timeoutMs = ADMIN_REQUEST_TIMEOUT_MS,
): Promise<ApiSuccess<T>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const href = search.size > 0 ? `${path}?${search.toString()}` : path;
  const response = await adminFetch(href, {}, timeoutMs);
  const payload = await readJson<ApiResponse<T> & { meta?: Record<string, unknown> }>(response);
  if (!response.ok || !payload?.ok) {
    throw apiError(response, payload);
  }
  return payload as ApiSuccess<T>;
}

async function adminPost<T>(path: string, body: unknown): Promise<T> {
  const response = await adminFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await readJson<ApiResponse<T>>(response);
  if (!response.ok || !payload?.ok) {
    throw apiError(response, payload);
  }
  return payload.data as T;
}

async function adminFetch(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = ADMIN_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Админка не получила ответ от сервера за ${Math.round(timeoutMs / 1000)} секунд. Обновите страницу или повторите действие.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function adminGetProductsPage(
  filters: ProductListFilters & { cursor?: string | null; limit?: number } = {},
): Promise<ProductPage> {
  const payload = await adminGetPayload<Product[]>("/api/admin/products", {
    limit: filters.limit ?? 50,
    cursor: filters.cursor ?? undefined,
    is_blank: filters.is_blank,
    design_id: filters.design_id,
    search: filters.search,
  });
  return {
    items: payload.data ?? [],
    nextCursor: typeof payload.meta?.nextCursor === "string" ? payload.meta.nextCursor : null,
    hasMore: payload.meta?.hasMore === true,
  };
}

async function adminGetAllProducts(filters?: ProductListFilters) {
  const pageSize = 200;
  const maxRows = 10000;
  const out: Product[] = [];
  let cursor: string | null = null;

  while (out.length < maxRows) {
    const page = await adminGetProductsPage({
      limit: pageSize,
      cursor,
      is_blank: filters?.is_blank,
      design_id: filters?.design_id,
      search: filters?.search,
    });
    out.push(...page.items);
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return out;
}

async function adminGetInventoryPage(warehouseId?: string, offset = 0): Promise<InventoryPage> {
  const payload = await adminGetPayload<Inventory[]>("/api/admin/inventory", {
    limit: 200,
    offset,
    warehouse_id: warehouseId,
  });
  return {
    items: payload.data ?? [],
    nextOffset: typeof payload.meta?.nextOffset === "number" ? payload.meta.nextOffset : null,
    hasMore: payload.meta?.hasMore === true,
  };
}

async function adminGetAllInventory(warehouseId?: string) {
  const maxRows = 10_000;
  const rows: Inventory[] = [];
  const seenIds = new Set<string>();
  let offset = 0;

  while (rows.length < maxRows) {
    const page = await adminGetInventoryPage(warehouseId, offset);
    for (const item of page.items) {
      if (seenIds.has(item.id)) {
        throw new Error("Остатки изменились во время загрузки. Обновите страницу, чтобы получить согласованные данные.");
      }
      seenIds.add(item.id);
      rows.push(item);
    }
    if (!page.hasMore || page.nextOffset == null) return rows;
    if (page.nextOffset <= offset) {
      throw new Error("Сервер вернул некорректную пагинацию остатков.");
    }
    offset = page.nextOffset;
  }

  throw new Error("Остатков больше 10 000 строк. Полная загрузка остановлена, чтобы не показать неполные данные.");
}

async function adminGetOzonOrdersPage(offset = 0): Promise<OzonOrderPage> {
  const payload = await adminGetPayload<OzonOrder[]>("/api/admin/ozon/orders", {
    limit: 200,
    offset,
  });
  return {
    items: payload.data ?? [],
    nextOffset: typeof payload.meta?.nextOffset === "number" ? payload.meta.nextOffset : null,
    hasMore: payload.meta?.hasMore === true,
  };
}

async function adminGetAllOzonOrders() {
  const maxRows = 10_000;
  const rows: OzonOrder[] = [];
  const seenIds = new Set<string>();
  let offset = 0;

  while (rows.length < maxRows) {
    const page = await adminGetOzonOrdersPage(offset);
    for (const item of page.items) {
      if (seenIds.has(item.id)) {
        throw new Error("Заказы изменились во время загрузки. Обновите страницу, чтобы получить согласованные данные.");
      }
      seenIds.add(item.id);
      rows.push(item);
    }
    if (!page.hasMore || page.nextOffset == null) return rows;
    if (page.nextOffset <= offset) {
      throw new Error("Сервер вернул некорректную пагинацию заказов.");
    }
    offset = page.nextOffset;
  }

  throw new Error("Заказов больше 10 000. Полная загрузка остановлена, чтобы не показать неполные данные.");
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await readJson<Record<string, unknown>>(response);

  if (!response.ok) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : typeof (payload?.error as { message?: unknown } | undefined)?.message === "string"
          ? String(((payload?.error as { message: string }) ?? {}).message)
          : "Request failed";
    throw new Error(message);
  }

  return payload as T;
}

type QueuedJobResponse = {
  queued: true;
  jobId: string;
  status: string;
  reused?: boolean;
};

async function startAndWaitForJob<T>(
  input: string,
  init: RequestInit = {},
): Promise<{ result: T; queued: boolean }> {
  const idempotencyKey = crypto.randomUUID();
  const response = await requestJson<T | QueuedJobResponse>(input, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      "X-Idempotency-Key": idempotencyKey,
      "X-Request-Id": crypto.randomUUID(),
    },
  });
  if (!isQueuedJobResponse(response)) return { result: response as T, queued: false };
  return { result: await waitForJobResult<T>(response.jobId), queued: true };
}

async function waitForJobResult<T>(jobId: string): Promise<T> {
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const job = await adminGet<BackgroundJob>(`/api/admin/jobs/${jobId}`);
    if (job.status === "succeeded") return job.result as T;
    if (job.status === "failed") {
      throw new Error(job.errorMessage || `Фоновое задание завершилось с ошибкой (${job.errorCode ?? "unknown"}).`);
    }
    if (job.status === "cancelled") throw new Error("Фоновое задание отменено.");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Фоновое задание выполняется дольше 20 минут. Его состояние сохранено на сервере.");
}

function isQueuedJobResponse(value: unknown): value is QueuedJobResponse {
  return Boolean(
    value
      && typeof value === "object"
      && (value as { queued?: unknown }).queued === true
      && typeof (value as { jobId?: unknown }).jobId === "string",
  );
}

async function readJson<T>(response: Response): Promise<T | null> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as T;
  } catch {
    if (!response.ok) throw new Error(text.slice(0, 240) || "Request failed");
    throw new Error("Server returned invalid JSON");
  }
}

function apiError<T>(response: Response, payload: ApiResponse<T> | null) {
  const message =
    payload && !payload.ok && payload.error?.message
      ? payload.error.message
      : response.status === 401
        ? "Нужно заново войти в админку."
        : response.status === 403
          ? "Недостаточно прав для действия."
          : response.status === 503
            ? "Админка временно работает только для чтения. Повторите действие после завершения обслуживания."
          : response.status === 409
            ? "Конфликт данных. Обновите страницу и повторите действие."
            : response.status === 422
              ? "Проверьте данные и повторите действие."
              : "Admin API request failed";

  const error = new Error(message) as Error & { status?: number; code?: string };
  error.status = response.status;
  if (payload && !payload.ok && payload.error?.code) error.code = payload.error.code;
  return error;
}

export const api = {
  // ---------- WAREHOUSES ----------
  listWarehouses: () => adminRpc<Warehouse[]>("listWarehouses"),

  // ---------- CATEGORIES / FABRICS / COLORS / SIZES / DECORATION ----------
  listCategories: () => adminRpc<ProductCategory[]>("listCategories"),
  listFabrics: () => adminRpc<FabricType[]>("listFabrics"),
  listColors: () => adminRpc<Color[]>("listColors"),
  listSizes: () => adminRpc<Size[]>("listSizes"),
  listDecorationTypes: () => adminRpc<DecorationType[]>("listDecorationTypes"),
  listDesigns: (filters?: { type?: DesignType }) => adminRpc<Design[]>("listDesigns", [filters]),

  // ---------- PRODUCTS ----------
  listProductsPage: (filters?: ProductListFilters & { cursor?: string | null; limit?: number }) =>
    adminGetProductsPage(filters),
  listAllProducts: (filters?: ProductListFilters) => adminGetAllProducts(filters),
  listProducts: (filters?: ProductListFilters) => adminGetProductsPage(filters).then((page) => page.items),
  listProductsForDesign: (designId: string) => adminGetAllProducts({ is_blank: false, design_id: designId }),
  listMatchingBlankProducts: (keys: BlankMatchKey[]) =>
    adminPost<Product[]>("/api/admin/products/blank-matches", { keys }),
  findOrCreateProduct: (input: {
    category_id: string;
    fabric_id: string;
    color_id: string;
    size_id: string;
    design_id?: string | null;
    decoration_type_id?: string | null;
    design_version?: string | null;
    hoodie_fit?: string | null;
    hoodie_fabric?: string | null;
  }) => adminRpc<Product>("findOrCreateProduct", [input]),
  updateProductPrices: (id: string, prices: { cost_price?: number | null; sale_price?: number | null }) =>
    adminRpc<void>("updateProductPrices", [id, prices]),
  updateProduct: (
    id: string,
    patch: { sku?: string | null; cost_price?: number | null; sale_price?: number | null; design_id?: string | null },
  ) => adminRpc<void>("updateProduct", [id, patch]),
  deleteProduct: (id: string) => adminRpc<void>("deleteProduct", [id]),

  // ---------- INVENTORY ----------
  listInventory: (warehouseId?: string) => adminGetAllInventory(warehouseId),
  listInventoryMatrix: () => adminGet<InventoryMatrix>("/api/admin/inventory/matrix", {}, 180_000),
  getInventoryFor: (productId: string, warehouseId: string) =>
    adminRpc<number>("getInventoryFor", [productId, warehouseId]),
  adjustInventory: (productId: string, warehouseId: string, delta: number) =>
    adminRpc<void>("adjustInventory", [productId, warehouseId, delta]),

  // ---------- TRANSACTIONS ----------
  listTransactions: (limit = 100) =>
    adminGet<Transaction[]>("/api/admin/inventory/movements", { limit }),
  receive: (args: { productId: string; warehouseId: string; quantity: number; notes?: string }) =>
    adminRpc<void>("receive", [args]),
  transfer: (args: {
    productId: string;
    fromWarehouseId: string;
    toWarehouseId: string;
    quantity: number;
    notes?: string;
  }) => adminRpc<void>("transfer", [args]),
  sale: (args: { productId: string; warehouseId: string; quantity: number; notes?: string }) =>
    adminRpc<void>("sale", [args]),
  writeoff: (args: { productId: string; warehouseId: string; quantity: number; notes?: string }) =>
    adminRpc<void>("writeoff", [args]),
  adjust: (args: { productId: string; warehouseId: string; delta: number; notes?: string }) =>
    adminRpc<void>("adjust", [args]),
  produce: (args: {
    blankProductId: string;
    finishedProductId: string;
    warehouseId: string;
    quantity: number;
    workshopOrderId?: string | null;
    notes?: string;
  }) => adminRpc<void>("produce", [args]),

  // ---------- PRINT INVENTORY ----------
  listPrintInventory: (warehouseId?: string) => adminRpc<PrintInventory[]>("listPrintInventory", [warehouseId]),
  getPrintInventoryFor: (designId: string, warehouseId: string) =>
    adminRpc<number>("getPrintInventoryFor", [designId, warehouseId]),
  adjustPrintInventory: (designId: string, warehouseId: string, delta: number) =>
    adminRpc<void>("adjustPrintInventory", [designId, warehouseId, delta]),
  receivePrint: (args: { designId: string; warehouseId: string; quantity: number; notes?: string }) =>
    adminRpc<void>("receivePrint", [args]),
  writeoffPrint: (args: { designId: string; warehouseId: string; quantity: number; notes?: string }) =>
    adminRpc<void>("writeoffPrint", [args]),
  adjustPrint: (args: { designId: string; warehouseId: string; delta: number; notes?: string }) =>
    adminRpc<void>("adjustPrint", [args]),

  // ---------- WORKSHOP ORDERS ----------
  listWorkshopOrders: () => adminGet<WorkshopOrder[]>("/api/admin/workshop/orders", { limit: 500 }),
  createWorkshopOrder: (args: {
    workshopId: string;
    notes?: string;
    ownWarehouseId?: string | null;
    items: {
      blankProductId: string;
      designId: string;
      decorationTypeId: string;
      quantity: number;
      notes?: string;
      designVersion?: string | null;
      hoodieFit?: string | null;
      hoodieFabric?: string | null;
    }[];
  }) => adminRpc<string>("createWorkshopOrder", [args]),
  updateWorkshopOrderStatus: (orderId: string, status: WorkshopOrder["status"], options?: { ownWarehouseId?: string }) =>
    adminRpc<void>("updateWorkshopOrderStatus", [orderId, status, options]),
  getWorkshopOrder: (id: string) => adminRpc<WorkshopOrder | null>("getWorkshopOrder", [id]),

  // ---------- OZON ORDERS ----------
  listOzonOrders: () => adminGetAllOzonOrders(),
  findBlankFor: (product: Product) => adminRpc<Product | null>("findBlankFor", [product]),
  shipOzonOrder: (orderId: string, preferredWarehouseId?: string) =>
    adminRpc<void>("shipOzonOrder", [orderId, preferredWarehouseId]),
  unshipOzonOrder: (orderId: string) => adminRpc<void>("unshipOzonOrder", [orderId]),
  createWorkshopOrderFromOzon: (args: { ozonOrderId: string; workshopId: string; ownWarehouseId?: string | null }) =>
    adminRpc<string>("createWorkshopOrderFromOzon", [args]),
  fulfillOzonViaWorkshop: (args: { ozonOrderId: string; ownWarehouseId?: string | null }) =>
    adminRpc<void>("fulfillOzonViaWorkshop", [args]),
  fulfillOzonViaProduction: (args: { ozonOrderId: string; ownWarehouseId: string }) =>
    adminRpc<void>("fulfillOzonViaProduction", [args]),
  async syncOzonOrders(
    opts: { days?: number; scope?: "active" | "all" } = {},
  ): Promise<{
    scope: "active" | "all";
    created: number;
    updated: number;
    fetched: number;
    unmatchedItems: number;
    unmatchedSamples: string[];
    failedOrders?: number;
    failedOrderSamples?: string[];
    failedItemOrders?: number;
    durationMs?: number;
  }> {
    const params = new URLSearchParams();
    if (opts.scope) params.set("scope", opts.scope);
    if (opts.days != null) params.set("days", String(opts.days));

    const response = await startAndWaitForJob<{
      scope: "active" | "all";
      created: number;
      updated: number;
      fetched: number;
      unmatchedItems: number;
      unmatchedSamples: string[];
      failedOrders?: number;
      failedOrderSamples?: string[];
      failedItemOrders?: number;
      durationMs?: number;
    }>(`/api/ozon/sync-orders?${params.toString()}`, { method: "POST" });
    return response.result;
  },

  async syncOzonPrices() {
    const response = await startAndWaitForJob<{
      total: number;
      updated: number;
      unchanged: number;
      notFound: number;
      notFoundSamples: string[];
    }>("/api/ozon/sync-prices", { method: "POST" });
    return response.result;
  },

  async createOzonImportPreview() {
    const response = await startAndWaitForJob<OzonImportPreview | { runId: string }>(
      "/api/ozon/import/preview",
      { method: "POST" },
    );
    if (!response.queued) return response.result as OzonImportPreview;
    const runId = (response.result as { runId?: unknown }).runId;
    if (typeof runId !== "string") throw new Error("Фоновый импорт не вернул runId.");
    return adminGet<OzonImportPreview>(`/api/admin/import/ozon/runs/${runId}`);
  },

  async applyOzonImport(
    runId: string,
    designOverrides: Record<string, { name?: string; imageUrl?: string | null }>,
  ) {
    const response = await startAndWaitForJob<OzonImportApplyResult>(
      "/api/ozon/import/apply",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, designOverrides }),
      },
    );
    return response.result;
  },

  // ---------- DESIGNS CRUD ----------
  listDesignProductCounts: () => adminGet<DesignProductCount[]>("/api/admin/designs/product-counts"),
  createDesign: (input: { name: string; type: DesignType; description?: string; image_url?: string }) =>
    adminRpc<Design>("createDesign", [input]),
  updateDesign: (id: string, input: Partial<Design>) => adminRpc<void>("updateDesign", [id, input]),
  deleteDesign: (id: string) => adminRpc<void>("deleteDesign", [id]),

  // ---------- REFERENCE CRUD ----------
  createColor: (input: { name: string; hex_code?: string }) => adminRpc<void>("createColor", [input]),
  updateColor: (id: string, patch: { name?: string; hex_code?: string | null }) =>
    adminRpc<void>("updateColor", [id, patch]),
  deleteColor: (id: string) => adminRpc<void>("deleteColor", [id]),
  createSize: (input: { name: string; sort_order: number }) => adminRpc<void>("createSize", [input]),
  deleteSize: (id: string) => adminRpc<void>("deleteSize", [id]),
  createWarehouse: (input: { name: string; type: "own" | "workshop"; address?: string; contact?: string }) =>
    adminRpc<void>("createWarehouse", [input]),
  updateWarehouse: (
    id: string,
    patch: { name?: string; type?: "own" | "workshop"; address?: string | null; contact?: string | null; notes?: string | null },
  ) => adminRpc<void>("updateWarehouse", [id, patch]),
  deleteWarehouse: (id: string) => adminRpc<void>("deleteWarehouse", [id]),

  // ---------- EXPENSES / FINANCE ----------
  listExpenseCategories: (opts?: { includeArchived?: boolean }) =>
    adminRpc<ExpenseCategory[]>("listExpenseCategories", [opts]),
  createExpenseCategory: (input: { name: string; color?: string | null; sort_order?: number }) =>
    adminRpc<ExpenseCategory>("createExpenseCategory", [input]),
  updateExpenseCategory: (
    id: string,
    patch: { name?: string; color?: string | null; sort_order?: number; archived?: boolean },
  ) => adminRpc<void>("updateExpenseCategory", [id, patch]),
  deleteExpenseCategory: (id: string) => adminRpc<void>("deleteExpenseCategory", [id]),
  listExpenses: (filters?: { from?: string; to?: string; categoryId?: string }) =>
    adminGet<Expense[]>("/api/admin/expenses", {
      limit: 1000,
      from: filters?.from,
      to: filters?.to,
      category_id: filters?.categoryId,
    }),
  createExpense: (input: { categoryId: string | null; amount: number; occurredAt: string; description?: string | null }) =>
    adminRpc<void>("createExpense", [input]),
  updateExpense: (
    id: string,
    patch: { categoryId?: string | null; amount?: number; occurredAt?: string; description?: string | null },
  ) => adminRpc<void>("updateExpense", [id, patch]),
  deleteExpense: (id: string) => adminRpc<void>("deleteExpense", [id]),
  listFinanceOperations: (filters?: { from?: string; to?: string }) =>
    adminGet<OzonFinanceOperation[]>("/api/admin/finance/ozon", {
      limit: 1000,
      from: filters?.from,
      to: filters?.to,
    }),
  listOzonSkuProductMap: () =>
    adminRpc<Array<{ ozon_sku: string; product: Product }>>("listOzonSkuProductMap"),
  lastFinanceSyncAt: () => adminRpc<string | null>("lastFinanceSyncAt"),
  syncOzonFinance: (opts: { from?: string; to?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.from) params.set("from", opts.from);
    if (opts.to) params.set("to", opts.to);
    return startAndWaitForJob<{ fetched: number; created: number; updated: number; from: string; to: string }>(
      `/api/ozon/sync-finance?${params.toString()}`,
      { method: "POST" },
    ).then((response) => response.result);
  },
};

export function productName(p?: Product | null): string {
  if (!p) return "-";
  const parts: string[] = [];
  if (p.category) parts.push(p.category.name);
  if (p.fabric) parts.push(p.fabric.name.toLowerCase());
  if (p.color) parts.push(p.color.name);
  if (p.size) parts.push(p.size.name);
  if (p.design && p.decoration_type) {
    parts.push(`· ${p.decoration_type.name}: ${p.design.name}`);
  } else if (p.is_blank) {
    parts.push("· пустая");
  }
  return parts.join(" ");
}
