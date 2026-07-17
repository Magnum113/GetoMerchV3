import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { DatabaseQueryError } from "@/lib/db/errors";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import type { CatalogRepository } from "@/lib/db/repositories/catalog";
import type { ProductRepository } from "@/lib/db/repositories/products";
import type {
  Inventory,
  InventoryMatrix,
  InventoryMatrixRow,
  PrintInventory,
  Product,
} from "@/lib/types";

export type InventoryListOptions = {
  limit: number;
  warehouseId?: string;
};

type InventoryRow = Omit<Inventory, "product" | "warehouse">;
type PrintInventoryRow = Omit<PrintInventory, "design" | "warehouse">;
type StockRef = { product_id: string; warehouse_id: string; quantity: number };
type MatrixProduct = Pick<
  Product,
  | "id"
  | "category_id"
  | "fabric_id"
  | "color_id"
  | "size_id"
  | "design_id"
  | "decoration_type_id"
  | "sku"
  | "is_blank"
>;

export interface InventoryRepository {
  listInventory(options: InventoryListOptions): Promise<Inventory[]>;
  getInventoryFor(productId: string, warehouseId: string): Promise<number>;
  listPrintInventory(warehouseId?: string): Promise<PrintInventory[]>;
  getPrintInventoryFor(designId: string, warehouseId: string): Promise<number>;
  getMatrix(): Promise<InventoryMatrix>;
}

export class PostgresInventoryRepository implements InventoryRepository {
  constructor(
    private readonly query: DatabaseQueryExecutor,
    private readonly catalog: CatalogRepository,
    private readonly products: ProductRepository,
  ) {}

  async listInventory(options: InventoryListOptions) {
    const result = await this.query<InventoryRow>(
      `
        SELECT id, product_id, warehouse_id, quantity, updated_at
        FROM merch_inventory
        WHERE quantity > 0
          AND ($2::uuid IS NULL OR warehouse_id = $2)
        ORDER BY updated_at DESC, id DESC
        LIMIT $1
      `,
      [options.limit, options.warehouseId ?? null],
    );
    return hydrateInventory(result.rows, this.catalog, this.products);
  }

  async getInventoryFor(productId: string, warehouseId: string) {
    const result = await this.query<{ quantity: number }>(
      `
        SELECT quantity
        FROM merch_inventory
        WHERE product_id = $1::uuid AND warehouse_id = $2::uuid
        LIMIT 1
      `,
      [productId, warehouseId],
    );
    return result.rows[0]?.quantity ?? 0;
  }

  async listPrintInventory(warehouseId?: string) {
    const result = await this.query<PrintInventoryRow>(
      `
        SELECT id, design_id, warehouse_id, quantity, updated_at
        FROM merch_print_inventory
        WHERE quantity > 0
          AND ($1::uuid IS NULL OR warehouse_id = $1)
        ORDER BY updated_at DESC, id DESC
      `,
      [warehouseId ?? null],
    );
    return hydratePrintInventory(result.rows, this.catalog);
  }

  async getPrintInventoryFor(designId: string, warehouseId: string) {
    const result = await this.query<{ quantity: number }>(
      `
        SELECT quantity
        FROM merch_print_inventory
        WHERE design_id = $1::uuid AND warehouse_id = $2::uuid
        LIMIT 1
      `,
      [designId, warehouseId],
    );
    return result.rows[0]?.quantity ?? 0;
  }

  async getMatrix() {
    const [products, inventory, lookups] = await Promise.all([
      this.query<MatrixProduct>(
        `
          SELECT id, category_id, fabric_id, color_id, size_id, design_id,
                 decoration_type_id, sku, is_blank
          FROM merch_products
          ORDER BY sku COLLATE "C" ASC NULLS LAST, id
        `,
      ),
      this.query<StockRef>(
        `
          SELECT product_id, warehouse_id, SUM(quantity)::int AS quantity
          FROM merch_inventory
          WHERE quantity > 0
          GROUP BY product_id, warehouse_id
          ORDER BY product_id, warehouse_id
        `,
      ),
      this.catalog.listProductLookups(),
    ]);
    return buildInventoryMatrix(products.rows, inventory.rows, lookups);
  }
}

export class SupabaseInventoryRepository implements InventoryRepository {
  constructor(
    private readonly client: SupabaseClient,
    private readonly catalog: CatalogRepository,
    private readonly products: ProductRepository,
  ) {}

  async listInventory(options: InventoryListOptions) {
    let query = this.client
      .from("merch_inventory")
      .select("id,product_id,warehouse_id,quantity,updated_at")
      .gt("quantity", 0)
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(options.limit);
    if (options.warehouseId) query = query.eq("warehouse_id", options.warehouseId);
    const { data, error } = await query;
    if (error) throw repositoryError(error);
    return hydrateInventory((data ?? []) as InventoryRow[], this.catalog, this.products);
  }

  async getInventoryFor(productId: string, warehouseId: string) {
    const { data, error } = await this.client
      .from("merch_inventory")
      .select("quantity")
      .eq("product_id", productId)
      .eq("warehouse_id", warehouseId)
      .maybeSingle();
    if (error) throw repositoryError(error);
    return data?.quantity ?? 0;
  }

  async listPrintInventory(warehouseId?: string) {
    let query = this.client
      .from("merch_print_inventory")
      .select("id,design_id,warehouse_id,quantity,updated_at")
      .gt("quantity", 0)
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false });
    if (warehouseId) query = query.eq("warehouse_id", warehouseId);
    const { data, error } = await query;
    if (error) throw repositoryError(error);
    return hydratePrintInventory((data ?? []) as PrintInventoryRow[], this.catalog);
  }

  async getPrintInventoryFor(designId: string, warehouseId: string) {
    const { data, error } = await this.client
      .from("merch_print_inventory")
      .select("quantity")
      .eq("design_id", designId)
      .eq("warehouse_id", warehouseId)
      .maybeSingle();
    if (error) throw repositoryError(error);
    return data?.quantity ?? 0;
  }

  async getMatrix() {
    const [products, inventory, lookups] = await Promise.all([
      this.fetchMatrixProducts(),
      this.fetchMatrixInventory(),
      this.catalog.listProductLookups(),
    ]);
    return buildInventoryMatrix(products, inventory, lookups);
  }

  private async fetchMatrixProducts() {
    const rows: MatrixProduct[] = [];
    const pageSize = 500;
    for (let offset = 0; offset < 20_000; offset += pageSize) {
      const { data, error } = await this.client
        .from("merch_products")
        .select("id,category_id,fabric_id,color_id,size_id,design_id,decoration_type_id,sku,is_blank")
        .order("sku")
        .order("id")
        .range(offset, offset + pageSize - 1);
      if (error) throw repositoryError(error);
      const page = (data ?? []) as MatrixProduct[];
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    return rows;
  }

  private async fetchMatrixInventory() {
    const rows: StockRef[] = [];
    const pageSize = 500;
    for (let offset = 0; offset < 20_000; offset += pageSize) {
      const { data, error } = await this.client
        .from("merch_inventory")
        .select("product_id,warehouse_id,quantity")
        .gt("quantity", 0)
        .order("product_id")
        .order("warehouse_id")
        .range(offset, offset + pageSize - 1);
      if (error) throw repositoryError(error);
      const page = (data ?? []) as StockRef[];
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    return rows;
  }
}

async function hydrateInventory(
  rows: InventoryRow[],
  catalog: CatalogRepository,
  products: ProductRepository,
) {
  const [productRows, warehouses] = await Promise.all([
    products.listByIds(rows.map((row) => row.product_id)),
    catalog.listWarehouses(),
  ]);
  const productsById = byId(productRows);
  const warehousesById = byId(warehouses);
  return rows.map((row) => ({
    ...row,
    product: productsById.get(row.product_id),
    warehouse: warehousesById.get(row.warehouse_id),
  }));
}

async function hydratePrintInventory(rows: PrintInventoryRow[], catalog: CatalogRepository) {
  const [designs, warehouses] = await Promise.all([
    catalog.listDesigns(),
    catalog.listWarehouses(),
  ]);
  const designsById = byId(designs);
  const warehousesById = byId(warehouses);
  return rows.map((row) => ({
    ...row,
    design: designsById.get(row.design_id),
    warehouse: warehousesById.get(row.warehouse_id),
  }));
}

function buildInventoryMatrix(
  products: MatrixProduct[],
  inventory: StockRef[],
  lookups: Awaited<ReturnType<CatalogRepository["listProductLookups"]>>,
): InventoryMatrix {
  const categories = byId(lookups.categories);
  const fabrics = byId(lookups.fabrics);
  const colors = byId(lookups.colors);
  const designs = byId(lookups.designs);
  const decorationTypes = byId(lookups.decorationTypes);
  const stockByProduct = new Map<string, Record<string, number>>();
  for (const row of inventory) {
    const stock = stockByProduct.get(row.product_id) ?? {};
    stock[row.warehouse_id] = (stock[row.warehouse_id] ?? 0) + row.quantity;
    stockByProduct.set(row.product_id, stock);
  }

  const groups = new Map<string, InventoryMatrixRow>();
  for (const product of products) {
    if (!product.is_blank && !product.sku) continue;
    const key = product.is_blank
      ? `b|${product.category_id}|${product.fabric_id}|${product.color_id}`
      : `f|${product.category_id}|${product.fabric_id}|${product.color_id}|${product.design_id}|${product.decoration_type_id}`;
    let row = groups.get(key);
    if (!row) {
      const design = product.design_id ? designs.get(product.design_id) : null;
      const decoration = product.decoration_type_id
        ? decorationTypes.get(product.decoration_type_id)
        : null;
      row = {
        key,
        isBlank: product.is_blank,
        label: `${categories.get(product.category_id)?.name ?? ""} ${fabrics.get(product.fabric_id)?.name?.toLowerCase() ?? ""}`,
        subLabel: colors.get(product.color_id)?.name ?? "",
        hex: colors.get(product.color_id)?.hex_code ?? null,
        designLabel: product.is_blank ? null : `${decoration?.name ?? ""}: ${design?.name ?? ""}`,
        cells: {},
      };
      groups.set(key, row);
    }
    row.cells[product.size_id] = {
      hasProduct: true,
      byWh: stockByProduct.get(product.id) ?? {},
    };
  }

  const rows = Array.from(groups.values()).sort((left, right) => {
    const a = `${left.label} ${left.designLabel ?? ""} ${left.subLabel}`;
    const b = `${right.label} ${right.designLabel ?? ""} ${right.subLabel}`;
    return a.localeCompare(b, "ru");
  });
  return {
    blankRows: rows.filter((row) => row.isBlank),
    finishedRows: rows.filter((row) => !row.isBlank),
  };
}

function byId<T extends { id: string }>(rows: T[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

function repositoryError(error: unknown) {
  return new DatabaseQueryError("Supabase repository query failed", { cause: error });
}
