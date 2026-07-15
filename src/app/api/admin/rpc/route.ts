import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { AdminApiError, adminErrorResponse, adminJson } from "@/lib/admin/http";
import { api as adminSupabaseApi } from "@/lib/admin/supabase-api";

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

export async function POST(request: NextRequest) {
  try {
    await requireAdminSession();

    const body = await request.json().catch(() => null);
    const action = typeof body?.action === "string" ? body.action : "";
    const args = Array.isArray(body?.args) ? body.args : [];

    if (!isAdminRpcAction(action)) {
      throw new AdminApiError(400, "bad_request", "Unknown admin API action");
    }
    if (args.length > 3) {
      throw new AdminApiError(400, "bad_request", "Too many admin API arguments");
    }

    const method = adminSupabaseApi[action] as (...input: unknown[]) => Promise<unknown>;
    const data = await method(...args);
    return adminJson({ data: data ?? null });
  } catch (error) {
    return adminErrorResponse(toAdminRpcError(error));
  }
}

function isAdminRpcAction(action: string): action is AdminRpcAction {
  return ADMIN_RPC_ACTION_SET.has(action);
}

function toAdminRpcError(error: unknown) {
  if (error instanceof AdminApiError) return error;
  if (error instanceof Error && isSafeBusinessError(error.message)) {
    return new AdminApiError(422, "bad_request", error.message);
  }

  console.error("[admin-rpc] action failed", safeErrorForLog(error));
  return new AdminApiError(500, "internal_error", "Admin API request failed");
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
