import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson, assertNoSupabaseError, parseLimitParam } from "@/lib/admin/http";
import { hydrateProducts } from "@/lib/admin/product-hydration";
import { getAdminSupabaseClient } from "@/lib/supabase/server";
import type { OzonOrder, OzonOrderItem, Product, WorkshopOrder } from "@/lib/types";

export const dynamic = "force-dynamic";

const QUERY_TIMEOUT_MS = 12_000;
const ORDER_ITEM_CHUNK_SIZE = 25;
const PRODUCT_CHUNK_SIZE = 25;
const WORKSHOP_ORDER_CHUNK_SIZE = 25;
const ORDER_SELECT =
  "id,posting_number,order_id,order_number,status,substatus,ozon_created_at,in_process_at,shipment_date,delivery_method,warehouse_name,customer_name,total_price,source,synced_at,shipped_at,shipped_from_warehouse_id,workshop_order_id,notes,created_at";
const ORDER_ITEM_SELECT =
  "id,order_id,offer_id,ozon_sku,name,quantity,price,product_id,created_at,shipped_from_warehouse_id";
const PRODUCT_SELECT =
  "id,category_id,fabric_id,color_id,size_id,design_id,decoration_type_id,sku,ozon_sku,legacy_skus,design_version,hoodie_fit,hoodie_fabric,is_blank,cost_price,sale_price,created_at";
const WORKSHOP_ORDER_SELECT =
  "id,order_number,workshop_id,status,notes,created_at,sent_at,completed_at,received_at";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const params = request.nextUrl.searchParams;
    const limit = parseLimitParam(params.get("limit"), { defaultValue: 50, max: 200 });
    const status = params.get("status")?.trim();
    const source = params.get("source")?.trim();

    const data = await listOrdersViaSupabase({ limit, status: status || null, source: source || null });
    return adminJson({ data, meta: { limit } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

async function listOrdersViaSupabase({
  limit,
  status,
  source,
}: {
  limit: number;
  status: string | null;
  source: string | null;
}) {
  let query = getAdminSupabaseClient()
    .from("merch_ozon_orders")
    .select(ORDER_SELECT)
    .order("in_process_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (status) query = query.eq("status", status);
  if (source) query = query.eq("source", source);

  const orders = await queryWithRetry("ozon orders", async (signal) => {
    const { data, error } = await query.abortSignal(signal);
    if (error) throw error;
    return (data ?? []) as OzonOrder[];
  });

  const orderIds = orders.map((order) => order.id);

  const [itemsByOrderId, workshopOrdersById] = await Promise.all([
    fetchItemsByOrderId(orderIds),
    fetchWorkshopOrdersById(orders.map((order) => order.workshop_order_id).filter(Boolean) as string[]),
  ]);

  return orders.map((order) => ({
    ...order,
    items: itemsByOrderId.get(order.id) ?? [],
    workshop_order: order.workshop_order_id
      ? workshopOrdersById.get(order.workshop_order_id) ?? null
      : null,
  }));
}

async function fetchProductsByIdsViaSupabase(ids: string[]) {
  const out = new Map<string, Product>();
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (uniqueIds.length === 0) return out;

  for (const chunkIds of chunk(uniqueIds, PRODUCT_CHUNK_SIZE)) {
    const products = await queryWithRetry(`ozon order products ${chunkIds[0]}`, async (signal) => {
      const { data, error } = await getAdminSupabaseClient()
        .from("merch_products")
        .select(PRODUCT_SELECT)
        .in("id", chunkIds)
        .abortSignal(signal);
      if (error) throw error;
      return (data ?? []) as Product[];
    });
    for (const product of await hydrateProducts(products)) out.set(product.id, product);
  }

  return out;
}

async function fetchItemsByOrderId(orderIds: string[]) {
  const itemsByOrderId = new Map<string, OzonOrderItem[]>();
  if (orderIds.length === 0) return itemsByOrderId;

  const allItems: Array<OzonOrderItem & { created_at?: string; shipped_from_warehouse_id?: string | null }> = [];

  for (const ids of chunk(orderIds, ORDER_ITEM_CHUNK_SIZE)) {
    const items = await queryWithRetry(`ozon order items ${ids[0]}`, async (signal) => {
      const { data, error } = await getAdminSupabaseClient()
        .from("merch_ozon_order_items")
        .select(ORDER_ITEM_SELECT)
        .in("order_id", ids)
        .order("id", { ascending: true })
        .abortSignal(signal);
      if (error) throw error;
      return (data ?? []) as Array<OzonOrderItem & { created_at?: string; shipped_from_warehouse_id?: string | null }>;
    });

    allItems.push(...items);
  }

  const productsById = await fetchProductsByIdsViaSupabase(
    allItems.map((item) => item.product_id).filter(Boolean) as string[],
  );

  for (const item of allItems) {
    const list = itemsByOrderId.get(item.order_id) ?? [];
    list.push({
      ...item,
      product: item.product_id ? productsById.get(item.product_id) ?? null : null,
    });
    itemsByOrderId.set(item.order_id, list);
  }

  return itemsByOrderId;
}

async function fetchWorkshopOrdersById(ids: string[]) {
  const out = new Map<string, WorkshopOrder>();
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) return out;

  for (const chunkIds of chunk(uniqueIds, WORKSHOP_ORDER_CHUNK_SIZE)) {
    const rows = await queryWithRetry(`workshop orders ${chunkIds[0]}`, async (signal) => {
      const { data, error } = await getAdminSupabaseClient()
        .from("merch_workshop_orders")
        .select(WORKSHOP_ORDER_SELECT)
        .in("id", chunkIds)
        .abortSignal(signal);
      if (error) throw error;
      return (data ?? []) as WorkshopOrder[];
    });
    for (const row of rows) out.set(row.id, row);
  }

  return out;
}

async function queryWithRetry<T>(label: string, query: (signal: AbortSignal) => Promise<T>) {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
    try {
      return await query(controller.signal);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 3) await delay(250 * attempt);
  }

  assertNoSupabaseError(lastError, `Failed to load ${label}`);
  throw lastError;
}

function chunk<T>(items: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
