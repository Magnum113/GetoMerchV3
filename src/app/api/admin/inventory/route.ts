import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import {
  adminErrorResponse,
  adminJson,
  assertNoSupabaseError,
  parseLimitParam,
  requireUuidParam,
} from "@/lib/admin/http";
import { adminDbQuery, hasAdminPostgres } from "@/lib/admin/postgres";
import { ADMIN_INVENTORY_JSON, ADMIN_PRODUCT_RELATION_JOINS } from "@/lib/admin/product-sql";
import { hydrateProducts } from "@/lib/admin/product-hydration";
import { getAdminSupabaseClient } from "@/lib/supabase/server";
import type { Inventory, Product, Warehouse } from "@/lib/types";

export const dynamic = "force-dynamic";

const QUERY_TIMEOUT_MS = 12_000;
const PRODUCT_CHUNK_SIZE = 25;
const WAREHOUSE_CHUNK_SIZE = 25;

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const params = request.nextUrl.searchParams;
    const limit = parseLimitParam(params.get("limit"), { defaultValue: 500, max: 1000 });
    const warehouseId = requireUuidParam(params.get("warehouse_id"), "warehouse_id");

    if (hasAdminPostgres()) {
      const data = await listInventoryViaPostgres(limit, warehouseId ?? null);
      return adminJson({ data, meta: { limit } });
    }

    let query = getAdminSupabaseClient()
      .from("merch_inventory")
      .select("*")
      .gt("quantity", 0)
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (warehouseId) query = query.eq("warehouse_id", warehouseId);

    const rows = await queryWithRetry("inventory rows", async (signal) => {
      const { data, error } = await query.abortSignal(signal);
      if (error) throw error;
      return (data ?? []) as Inventory[];
    });

    const [productsById, warehousesById] = await Promise.all([
      fetchProductsById(rows.map((row) => row.product_id)),
      fetchWarehousesById(rows.map((row) => row.warehouse_id)),
    ]);

    return adminJson({
      data: rows.map((row) => ({
        ...row,
        product: productsById.get(row.product_id),
        warehouse: warehousesById.get(row.warehouse_id),
      })),
      meta: { limit },
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

async function listInventoryViaPostgres(limit: number, warehouseId: string | null) {
  const result = await adminDbQuery<{ row: Inventory }>(
    `
      SELECT ${ADMIN_INVENTORY_JSON} AS row
      FROM merch_inventory i
      LEFT JOIN merch_products p ON p.id = i.product_id
      ${ADMIN_PRODUCT_RELATION_JOINS}
      LEFT JOIN merch_warehouses w ON w.id = i.warehouse_id
      WHERE i.quantity > 0
        AND ($2::uuid IS NULL OR i.warehouse_id = $2)
      ORDER BY i.updated_at DESC
      LIMIT $1
    `,
    [limit, warehouseId],
  );

  return result.rows.map((row) => row.row);
}

async function fetchProductsById(ids: string[]) {
  const out = new Map<string, Product>();
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) return out;

  for (const chunkIds of chunk(uniqueIds, PRODUCT_CHUNK_SIZE)) {
    const products = await queryWithRetry(`inventory products ${chunkIds[0]}`, async (signal) => {
      const { data, error } = await getAdminSupabaseClient()
        .from("merch_products")
        .select("*")
        .in("id", chunkIds)
        .abortSignal(signal);
      if (error) throw error;
      return (data ?? []) as Product[];
    });
    for (const product of await hydrateProducts(products)) out.set(product.id, product);
  }

  return out;
}

async function fetchWarehousesById(ids: string[]) {
  const out = new Map<string, Warehouse>();
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) return out;

  for (const chunkIds of chunk(uniqueIds, WAREHOUSE_CHUNK_SIZE)) {
    const rows = await queryWithRetry(`inventory warehouses ${chunkIds[0]}`, async (signal) => {
      const { data, error } = await getAdminSupabaseClient()
        .from("merch_warehouses")
        .select("*")
        .in("id", chunkIds)
        .abortSignal(signal);
      if (error) throw error;
      return (data ?? []) as Warehouse[];
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
