import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson, assertNoSupabaseError } from "@/lib/admin/http";
import { hydrateProducts } from "@/lib/admin/product-hydration";
import { getAdminSupabaseClient } from "@/lib/supabase/server";
import type { InventoryMatrix, InventoryMatrixRow, Product } from "@/lib/types";

export const dynamic = "force-dynamic";

type StockRef = {
  product_id: string;
  warehouse_id: string;
  quantity: number;
};

const PAGE_SIZE = 1000;
const MAX_PRODUCTS = 20_000;
const MAX_INVENTORY_ROWS = 20_000;

export async function GET() {
  try {
    await requireAdminSession();

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

async function fetchProducts() {
  const out: Product[] = [];
  let offset = 0;

  while (offset < MAX_PRODUCTS) {
    const { data, error } = await getAdminSupabaseClient()
      .from("merch_products")
      .select("*")
      .order("sku", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    assertNoSupabaseError(error);

    const page = (data ?? []) as Product[];
    out.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return hydrateProducts(out);
}

async function fetchInventoryRows() {
  const out: StockRef[] = [];
  let offset = 0;

  while (offset < MAX_INVENTORY_ROWS) {
    const { data, error } = await getAdminSupabaseClient()
      .from("merch_inventory")
      .select("product_id,warehouse_id,quantity")
      .gt("quantity", 0)
      .range(offset, offset + PAGE_SIZE - 1);
    assertNoSupabaseError(error);

    const page = (data ?? []) as StockRef[];
    out.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return out;
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
