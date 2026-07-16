import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson, assertNoSupabaseError } from "@/lib/admin/http";
import { adminDbQuery, hasAdminPostgres } from "@/lib/admin/postgres";
import { getAdminSupabaseClient } from "@/lib/supabase/server";
import type {
  Color,
  DecorationType,
  Design,
  FabricType,
  InventoryMatrix,
  InventoryMatrixRow,
  ProductCategory,
} from "@/lib/types";

export const dynamic = "force-dynamic";

type StockRef = {
  product_id: string;
  warehouse_id: string;
  quantity: number;
};

const PRODUCT_SELECT = "id,category_id,fabric_id,color_id,size_id,design_id,decoration_type_id,sku,is_blank";
const PRODUCT_PAGE_SIZE = 50;
const INVENTORY_PAGE_SIZE = 200;
const MAX_PRODUCTS = 20_000;
const MAX_INVENTORY_ROWS = 20_000;
const QUERY_TIMEOUT_MS = 3_000;

type MatrixProductRow = {
  id: string;
  category_id: string;
  fabric_id: string;
  color_id: string;
  size_id: string;
  design_id: string | null;
  decoration_type_id: string | null;
  sku: string | null;
  is_blank: boolean;
};

type MatrixLookups = {
  categories: Map<string, ProductCategory>;
  fabrics: Map<string, FabricType>;
  colors: Map<string, Color>;
  designs: Map<string, Design>;
  decorationTypes: Map<string, DecorationType>;
};

export async function GET() {
  try {
    await requireAdminSession();

    if (hasAdminPostgres()) {
      const [products, inventory, lookups] = await Promise.all([
        fetchProducts(),
        fetchInventoryRowsViaPostgres().catch((error) => {
          console.warn("[admin-api] inventory matrix postgres fallback", errorSummary(error));
          return fetchInventoryRows();
        }),
        fetchMatrixLookups(),
      ]);
      return adminJson({ data: buildInventoryMatrix(products, inventory, lookups) });
    }

    const [products, inventory, lookups] = await Promise.all([
      fetchProducts(),
      fetchInventoryRows(),
      fetchMatrixLookups(),
    ]);
    const matrix = buildInventoryMatrix(products, inventory, lookups);

    return adminJson({ data: matrix });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

async function fetchInventoryRowsViaPostgres() {
  const result = await adminDbQuery<StockRef>(
    `
      SELECT product_id, warehouse_id, SUM(quantity)::int AS quantity
      FROM merch_inventory
      WHERE quantity > 0
      GROUP BY product_id, warehouse_id
      LIMIT $1
    `,
    [MAX_INVENTORY_ROWS],
  );
  return result.rows;
}

async function fetchProducts() {
  const out: MatrixProductRow[] = [];
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
      return (data ?? []) as MatrixProductRow[];
    });

    out.push(...page);
    if (page.length < PRODUCT_PAGE_SIZE) break;
    offset += PRODUCT_PAGE_SIZE;
  }

  return out;
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

async function fetchMatrixLookups(): Promise<MatrixLookups> {
  const [categories, fabrics, colors, designs, decorationTypes] = await Promise.all([
    fetchLookup<ProductCategory>("merch_product_categories", "id,name,slug,created_at"),
    fetchLookup<FabricType>("merch_fabric_types", "id,name,slug,created_at"),
    fetchLookup<Color>("merch_colors", "id,name,hex_code,created_at"),
    fetchLookup<Design>("merch_designs", "id,name,type,code,description,image_url,created_at"),
    fetchLookup<DecorationType>("merch_decoration_types", "id,name,slug,made_at,created_at"),
  ]);

  return {
    categories,
    fabrics,
    colors,
    designs,
    decorationTypes,
  };
}

async function fetchLookup<T extends { id: string }>(table: string, select: string) {
  const rows = await queryWithRetry(`lookup ${table}`, async (signal) => {
    const { data, error } = await getAdminSupabaseClient()
      .from(table)
      .select(select)
      .abortSignal(signal);
    if (error) throw error;
    return (data ?? []) as unknown as T[];
  });
  return new Map(rows.map((row) => [row.id, row]));
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

function errorSummary(error: unknown) {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { message: String(error) };
}

function buildInventoryMatrix(
  products: MatrixProductRow[],
  inventory: StockRef[],
  lookups: MatrixLookups,
): InventoryMatrix {
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
      const category = lookups.categories.get(product.category_id);
      const fabric = lookups.fabrics.get(product.fabric_id);
      const color = lookups.colors.get(product.color_id);
      const design = product.design_id ? lookups.designs.get(product.design_id) : null;
      const decorationType = product.decoration_type_id
        ? lookups.decorationTypes.get(product.decoration_type_id)
        : null;

      row = {
        key,
        isBlank,
        label: `${category?.name ?? ""} ${fabric?.name?.toLowerCase() ?? ""}`,
        subLabel: color?.name ?? "",
        hex: color?.hex_code ?? null,
        designLabel: isBlank ? null : `${decorationType?.name ?? ""}: ${design?.name ?? ""}`,
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
