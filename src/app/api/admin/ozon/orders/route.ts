import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson, assertNoSupabaseError, parseLimitParam } from "@/lib/admin/http";
import { adminDbQuery, hasAdminPostgres } from "@/lib/admin/postgres";
import { ADMIN_PRODUCT_JSON, ADMIN_PRODUCT_RELATION_JOINS } from "@/lib/admin/product-sql";
import { ADMIN_PRODUCT_SELECT_INLINE } from "@/lib/admin/selects";
import { getAdminSupabaseClient } from "@/lib/supabase/server";
import type { OzonOrder, OzonOrderItem, WorkshopOrder } from "@/lib/types";

export const dynamic = "force-dynamic";

const QUERY_TIMEOUT_MS = 12_000;
const ORDER_ITEM_CHUNK_SIZE = 5;
const WORKSHOP_ORDER_CHUNK_SIZE = 25;

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const params = request.nextUrl.searchParams;
    const limit = parseLimitParam(params.get("limit"), { defaultValue: 50, max: 200 });
    const status = params.get("status")?.trim();
    const source = params.get("source")?.trim();

    if (hasAdminPostgres()) {
      const data = await listOrdersViaPostgres({ limit, status: status || null, source: source || null });
      return adminJson({ data, meta: { limit } });
    }

    let query = getAdminSupabaseClient()
      .from("merch_ozon_orders")
      .select("*")
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

    const [itemsByOrderId, workshopOrdersById] = await Promise.all([
      fetchItemsByOrderId(orders.map((order) => order.id)),
      fetchWorkshopOrdersById(orders.map((order) => order.workshop_order_id).filter(Boolean) as string[]),
    ]);

    return adminJson({
      data: orders.map((order) => ({
        ...order,
        items: itemsByOrderId.get(order.id) ?? [],
        workshop_order: order.workshop_order_id ? workshopOrdersById.get(order.workshop_order_id) ?? null : null,
      })),
      meta: { limit },
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

async function listOrdersViaPostgres({
  limit,
  status,
  source,
}: {
  limit: number;
  status: string | null;
  source: string | null;
}) {
  const ordersResult = await adminDbQuery<OzonOrder>(
    `
      SELECT *
      FROM merch_ozon_orders
      WHERE ($2::text IS NULL OR status = $2)
        AND ($3::text IS NULL OR source::text = $3)
      ORDER BY in_process_at DESC NULLS LAST, created_at DESC
      LIMIT $1
    `,
    [limit, status, source],
  );
  const orders = ordersResult.rows;
  const orderIds = orders.map((order) => order.id);

  const [itemsByOrderId, workshopOrdersById] = await Promise.all([
    fetchItemsByOrderIdViaPostgres(orderIds),
    fetchWorkshopOrdersByIdViaPostgres(
      orders.map((order) => order.workshop_order_id).filter(Boolean) as string[],
    ),
  ]);

  return orders.map((order) => ({
    ...order,
    items: itemsByOrderId.get(order.id) ?? [],
    workshop_order: order.workshop_order_id
      ? workshopOrdersById.get(order.workshop_order_id) ?? null
      : null,
  }));
}

async function fetchItemsByOrderIdViaPostgres(orderIds: string[]) {
  const itemsByOrderId = new Map<string, OzonOrderItem[]>();
  if (orderIds.length === 0) return itemsByOrderId;

  const result = await adminDbQuery<{ order_id: string; item: OzonOrderItem }>(
    `
      SELECT
        i.order_id,
        to_jsonb(i) || jsonb_build_object('product', ${ADMIN_PRODUCT_JSON}) AS item
      FROM merch_ozon_order_items i
      LEFT JOIN merch_products p ON p.id = i.product_id
      ${ADMIN_PRODUCT_RELATION_JOINS}
      WHERE i.order_id = ANY($1::uuid[])
      ORDER BY i.id
    `,
    [orderIds],
  );

  for (const row of result.rows) {
    const list = itemsByOrderId.get(row.order_id) ?? [];
    list.push(row.item);
    itemsByOrderId.set(row.order_id, list);
  }

  return itemsByOrderId;
}

async function fetchWorkshopOrdersByIdViaPostgres(ids: string[]) {
  const out = new Map<string, WorkshopOrder>();
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) return out;

  const result = await adminDbQuery<WorkshopOrder>(
    `
      SELECT *
      FROM merch_workshop_orders
      WHERE id = ANY($1::uuid[])
    `,
    [uniqueIds],
  );
  for (const row of result.rows) out.set(row.id, row);
  return out;
}

async function fetchItemsByOrderId(orderIds: string[]) {
  const itemsByOrderId = new Map<string, OzonOrderItem[]>();
  if (orderIds.length === 0) return itemsByOrderId;

  for (const ids of chunk(orderIds, ORDER_ITEM_CHUNK_SIZE)) {
    const items = await queryWithRetry(`ozon order items ${ids[0]}`, async (signal) => {
      const { data, error } = await getAdminSupabaseClient()
        .from("merch_ozon_order_items")
        .select(`*, product:merch_products(${ADMIN_PRODUCT_SELECT_INLINE})`)
        .in("order_id", ids)
        .abortSignal(signal);
      if (error) throw error;
      return ((data ?? []) as unknown) as OzonOrderItem[];
    });

    for (const item of items) {
      const list = itemsByOrderId.get(item.order_id) ?? [];
      list.push(item);
      itemsByOrderId.set(item.order_id, list);
    }
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
        .select("*")
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
