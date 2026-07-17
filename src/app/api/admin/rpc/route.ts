import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { AdminApiError, adminErrorResponse, adminJson } from "@/lib/admin/http";
import { api as adminSupabaseApi } from "@/lib/admin/supabase-api";
import { createDatabaseReadServices, type DatabaseReadServices } from "@/lib/db/services/runtime";
import { getDatabaseRuntimeConfig, getServerDatabaseUrl } from "@/lib/db/config";
import { DatabaseBusinessError } from "@/lib/db/errors";
import { dispatchServerAdminMutation } from "@/lib/db/mutations/service";
import type { Product } from "@/lib/types";
import { assertAdminWritesEnabled } from "@/lib/admin/maintenance";

export const dynamic = "force-dynamic";

type AdminRpcAction = (typeof ADMIN_RPC_ACTIONS)[number];

const ADMIN_RPC_ACTIONS = [
  "listWarehouses",
  "listCategories",
  "listFabrics",
  "listColors",
  "listSizes",
  "listDecorationTypes",
  "listDesigns",
  "listProducts",
  "findOrCreateProduct",
  "updateProductPrices",
  "updateProduct",
  "deleteProduct",
  "listInventory",
  "getInventoryFor",
  "adjustInventory",
  "listTransactions",
  "receive",
  "transfer",
  "sale",
  "writeoff",
  "adjust",
  "produce",
  "listPrintInventory",
  "getPrintInventoryFor",
  "adjustPrintInventory",
  "receivePrint",
  "writeoffPrint",
  "adjustPrint",
  "listWorkshopOrders",
  "createWorkshopOrder",
  "updateWorkshopOrderStatus",
  "getWorkshopOrder",
  "listOzonOrders",
  "findBlankFor",
  "shipOzonOrder",
  "unshipOzonOrder",
  "createWorkshopOrderFromOzon",
  "fulfillOzonViaWorkshop",
  "fulfillOzonViaProduction",
  "createDesign",
  "updateDesign",
  "deleteDesign",
  "createColor",
  "updateColor",
  "deleteColor",
  "createSize",
  "deleteSize",
  "createWarehouse",
  "updateWarehouse",
  "deleteWarehouse",
  "listExpenseCategories",
  "createExpenseCategory",
  "updateExpenseCategory",
  "deleteExpenseCategory",
  "listExpenses",
  "createExpense",
  "updateExpense",
  "deleteExpense",
  "listFinanceOperations",
  "listOzonSkuProductMap",
  "lastFinanceSyncAt",
] as const;

const ADMIN_RPC_ACTION_SET = new Set<string>(ADMIN_RPC_ACTIONS);
const READ_ACTION_SET = new Set<string>([
  "listWarehouses",
  "listCategories",
  "listFabrics",
  "listColors",
  "listSizes",
  "listDecorationTypes",
  "listDesigns",
  "listProducts",
  "listInventory",
  "getInventoryFor",
  "listTransactions",
  "listPrintInventory",
  "getPrintInventoryFor",
  "listWorkshopOrders",
  "getWorkshopOrder",
  "listOzonOrders",
  "findBlankFor",
  "listExpenseCategories",
  "listExpenses",
  "listFinanceOperations",
  "listOzonSkuProductMap",
  "lastFinanceSyncAt",
]);

export async function POST(request: NextRequest) {
  try {
    const session = await requireAdminSession();

    const body = await request.json().catch(() => null);
    const action = typeof body?.action === "string" ? body.action : "";
    const args = Array.isArray(body?.args) ? body.args : [];

    if (!isAdminRpcAction(action)) {
      throw new AdminApiError(400, "bad_request", "Unknown admin API action");
    }
    if (args.length > 3) {
      throw new AdminApiError(400, "bad_request", "Too many admin API arguments");
    }

    const data = READ_ACTION_SET.has(action)
      ? await dispatchReadAction(createDatabaseReadServices(), action, args)
      : await dispatchMutationAction(request, session, action, args);
    return adminJson({ data: data ?? null });
  } catch (error) {
    return adminErrorResponse(toAdminRpcError(error));
  }
}

async function dispatchMutationAction(
  request: NextRequest,
  session: { sub: string; sessionId: string },
  action: AdminRpcAction,
  args: unknown[],
) {
  assertAdminWritesEnabled();
  if (getDatabaseRuntimeConfig().writeSource === "server") {
    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim() ?? "";
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new AdminApiError(400, "bad_request", "Missing or invalid idempotency key");
    }
    const requestIdHeader = request.headers.get("x-request-id")?.trim();
    const requestId = requestIdHeader && isUuid(requestIdHeader)
      ? requestIdHeader
      : crypto.randomUUID();
    const requestedFault = request.headers.get("x-getomerch-fault-after")?.trim();
    const faultAfter = requestedFault && faultInjectionAllowed() ? requestedFault : undefined;
    return dispatchServerAdminMutation(action, args, {
      actor: session.sub,
      sessionId: session.sessionId,
      requestId,
      idempotencyKey,
      faultAfter,
    });
  }
  const method = adminSupabaseApi[action] as (...input: unknown[]) => Promise<unknown>;
  return method(...args);
}

async function dispatchReadAction(
  services: DatabaseReadServices,
  action: string,
  args: unknown[],
): Promise<unknown> {
  switch (action) {
    case "listWarehouses":
      return services.catalog.listWarehouses();
    case "listCategories":
      return services.catalog.listCategories();
    case "listFabrics":
      return services.catalog.listFabrics();
    case "listColors":
      return services.catalog.listColors();
    case "listSizes":
      return services.catalog.listSizes();
    case "listDecorationTypes":
      return services.catalog.listDecorationTypes();
    case "listDesigns": {
      const filters = objectArg(args[0]);
      const type = filters.type === "print" || filters.type === "embroidery"
        ? filters.type
        : undefined;
      return services.catalog.listDesigns(type);
    }
    case "listProducts": {
      const filters = objectArg(args[0]);
      return services.products.listAll({
        isBlank: typeof filters.is_blank === "boolean" ? filters.is_blank : undefined,
        designId: stringArg(filters.design_id),
      });
    }
    case "listInventory":
      return services.inventory.listInventory({ limit: 1000, warehouseId: stringArg(args[0]) });
    case "getInventoryFor":
      return services.inventory.getInventoryFor(requiredString(args[0]), requiredString(args[1]));
    case "listTransactions":
      return services.transactions.list(numberArg(args[0], 100, 500));
    case "listPrintInventory":
      return services.inventory.listPrintInventory(stringArg(args[0]));
    case "getPrintInventoryFor":
      return services.inventory.getPrintInventoryFor(
        requiredString(args[0]),
        requiredString(args[1]),
      );
    case "listWorkshopOrders":
      return services.workshop.list(500);
    case "getWorkshopOrder":
      return services.workshop.get(requiredString(args[0]));
    case "listOzonOrders":
      return services.ozonOrders.list({ limit: 200 });
    case "findBlankFor": {
      const product = objectArg(args[0]) as Partial<Product>;
      return services.products.findBlank({
        category_id: requiredString(product.category_id),
        fabric_id: requiredString(product.fabric_id),
        color_id: requiredString(product.color_id),
        size_id: requiredString(product.size_id),
      });
    }
    case "listExpenseCategories": {
      const options = objectArg(args[0]);
      return services.catalog.listExpenseCategories(options.includeArchived === true);
    }
    case "listExpenses": {
      const filters = objectArg(args[0]);
      return services.expenses.list({
        limit: 1000,
        from: stringArg(filters.from),
        to: stringArg(filters.to),
        categoryId: stringArg(filters.categoryId),
      });
    }
    case "listFinanceOperations": {
      const filters = objectArg(args[0]);
      return services.finance.list({
        limit: 1000,
        from: stringArg(filters.from),
        to: stringArg(filters.to),
      });
    }
    case "listOzonSkuProductMap":
      return services.finance.listOzonSkuProductMap();
    case "lastFinanceSyncAt":
      return services.finance.lastSyncAt();
    default:
      throw new AdminApiError(400, "bad_request", "Unknown read action");
  }
}

function objectArg(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArg(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown) {
  const parsed = stringArg(value);
  if (!parsed) throw new AdminApiError(400, "bad_request", "Invalid admin API argument");
  return parsed;
}

function numberArg(value: unknown, fallback: number, max: number) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

function isAdminRpcAction(action: string): action is AdminRpcAction {
  return ADMIN_RPC_ACTION_SET.has(action);
}

function toAdminRpcError(error: unknown) {
  if (error instanceof AdminApiError) return error;
  if (error instanceof DatabaseBusinessError) {
    const code = error.status === 503
      ? "maintenance"
      : error.status === 404
        ? "not_found"
        : error.status === 400
          ? "bad_request"
          : "conflict";
    return new AdminApiError(error.status, code, error.publicMessage);
  }
  if (error instanceof Error && isSafeBusinessError(error.message)) {
    return new AdminApiError(422, "bad_request", error.message);
  }

  console.error("[admin-rpc] action failed", safeErrorForLog(error));
  return new AdminApiError(500, "internal_error", "Admin API request failed");
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function faultInjectionAllowed() {
  if (process.env.GETOMERCH_DB_ALLOW_FAULT_INJECTION !== "true") return false;
  try {
    const database = new URL(getServerDatabaseUrl()).pathname.replace(/^\//, "");
    return /^getomerch_stage(?:7|9)_[a-z0-9_]+$/.test(database);
  } catch {
    return false;
  }
}

function isSafeBusinessError(message: string) {
  return [
    "Недостаточно",
    "Несколько вариантов",
    "Заказ",
    "Позиция",
    "Нет пустого SKU",
    "Не сопоставлен",
    "Новый SKU",
    "Товар с таким",
    "Введите",
  ].some((prefix) => message.startsWith(prefix));
}

function safeErrorForLog(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { message: String(error) };
}
