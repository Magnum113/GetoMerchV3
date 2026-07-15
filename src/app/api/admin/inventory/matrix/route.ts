import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson, assertNoSupabaseError } from "@/lib/admin/http";
import { adminDbQuery, hasAdminPostgres } from "@/lib/admin/postgres";
import { fetchProductPageViaPostgres } from "@/lib/admin/product-postgres";
import { hydrateProducts } from "@/lib/admin/product-hydration";
import { getAdminSupabaseClient } from "@/lib/supabase/server";
import type { InventoryMatrix, InventoryMatrixRow, Product } from "@/lib/types";

export const dynamic = "force-dynamic";

type StockRef = {
  product_id: string;
  warehouse_id: string;
  quantity: number;
};

const PRODUCT_SELECT = "id,category_id,fabric_id,color_id,size_id,design_id,decoration_type_id,sku,is_blank";
const PRODUCT_PAGE_SIZE = 25;
const INVENTORY_PAGE_SIZE = 200;
const POSTGRES_PRODUCT_PAGE_SIZE = 50;
const MAX_PRODUCTS = 20_000;
const MAX_INVENTORY_ROWS = 20_000;
const QUERY_TIMEOUT_MS = 15_000;

export async function GET() {
  try {
    await requireAdminSession();

    if (hasAdminPostgres()) {
      const [products, inventory] = await Promise.all([
        fetchProductsViaPostgres(),
        fetchInventoryRowsViaPostgres(),
      ]);
      return adminJson({ data: buildInventoryMatrix(products, inventory) });
    }

    const [products, inventory] = await Promise.all([
      fetchProducts(),
      fetchInventoryRows(),
    ]);
    const matrix = buildInventoryMatrix(products, inventory);

    return adminJson({ data: matrix });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

async function fetchProductsViaPostgres() {
  const out: Product[] = [];
  let offset = 0;

  while (offset < MAX_PRODUCTS) {
    const page = await fetchProductPageViaPostgres(POSTGRES_PRODUCT_PAGE_SIZE, offset);
    out.push(...page);
    if (page.length < POSTGRES_PRODUCT_PAGE_SIZE) break;
    offset += POSTGRES_PRODUCT_PAGE_SIZE;
  }

  return out;
}

async function fetchInventoryRowsViaPostgres() {
  const result = await adminDbQuery<StockRef>(
    `
      SELECT product_id, warehouse_id, quantity
      FROM merch_inventory
      WHERE quantity > 0
      LIMIT $1
    `,
    [MAX_INVENTORY_ROWS],
  );
  return result.rows;
}

async function fetchProducts() {
  const out: Product[] = [];
  let offset = 0;

  while (offset < MAX_PRODUCTS) {
    const page = await queryWithRetry(`merch_products matrix page ${offset}`, async (signal) => {
      const { data, error } = await getAdminSupabaseClient()
        .from("merch_products")
        .select(PRODUCT_SELECT)
        .order("sku", { ascending: true })
        .range(offset, offset + PRODUCT_PAGE_SIZE - 1)
        .abortSignal(signal);
      if (error) throw error;
      return (data ?? []) as Product[];
    });

    out.push(...page);
    if (page.length < PRODUCT_PAGE_SIZE) break;
    offset += PRODUCT_PAGE_SIZE;
  }

  return hydrateProducts(out);
}

async function fetchInventoryRows() {
  const out: StockRef[] = [];
  let offset = 0;

  while (offset < MAX_INVENTORY_ROWS) {
    const page = await queryWithRetry(`merch_inventory matrix page ${offset}`, async (signal) => {
      const { data, error } = await getAdminSupabaseClient()
        .from("merch_inventory")
        .select("product_id,warehouse_id,quantity")
        .gt("quantity", 0)
        .range(offset, offset + INVENTORY_PAGE_SIZE - 1)
        .abortSignal(signal);
      if (error) throw error;
      return (data ?? []) as StockRef[];
    });

    out.push(...page);
    if (page.length < INVENTORY_PAGE_SIZE) break;
    offset += INVENTORY_PAGE_SIZE;
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

    if (attempt < 3) await delay(300 * attempt);
  }

  assertNoSupabaseError(lastError, `Failed to load ${label}`);
  throw lastError;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildInventoryMatrix(products: Product[], inventory: StockRef[]): InventoryMatrix {
  const stockByProduct = new Map<string, Record<string, number>>();
  for (const row of inventory) {
    const byWh = stockByProduct.get(row.product_id) ?? {};
    byWh[row.warehouse_id] = (byWh[row.warehouse_id] ?? 0) + row.quantity;
    stockByProduct.set(row.product_id, byWh);
  }

  const groups = new Map<string, InventoryMatrixRow>();
  for (const product of products) {
    const isBlank = !!product.is_blank;
    if (!isBlank && !product.sku) continue;

    const key = isBlank
      ? `b|${product.category_id}|${product.fabric_id}|${product.color_id}`
      : `f|${product.category_id}|${product.fabric_id}|${product.color_id}|${product.design_id}|${product.decoration_type_id}`;

    let row = groups.get(key);
    if (!row) {
      row = {
        key,
        isBlank,
        label: `${product.category?.name ?? ""} ${product.fabric?.name?.toLowerCase() ?? ""}`,
        subLabel: product.color?.name ?? "",
        hex: product.color?.hex_code ?? null,
        designLabel: isBlank ? null : `${product.decoration_type?.name ?? ""}: ${product.design?.name ?? ""}`,
        cells: {},
      };
      groups.set(key, row);
    }

    row.cells[product.size_id] = {
      hasProduct: true,
      byWh: stockByProduct.get(product.id) ?? {},
    };
  }

  const rows = Array.from(groups.values()).sort((a, b) => {
    const al = `${a.label} ${a.designLabel ?? ""} ${a.subLabel}`;
    const bl = `${b.label} ${b.designLabel ?? ""} ${b.subLabel}`;
    return al.localeCompare(bl, "ru");
  });

  return {
    blankRows: rows.filter((row) => row.isBlank),
    finishedRows: rows.filter((row) => !row.isBlank),
  };
}
