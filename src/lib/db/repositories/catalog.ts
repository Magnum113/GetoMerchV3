import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { DatabaseQueryError } from "@/lib/db/errors";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import type {
  Color,
  DecorationType,
  Design,
  ExpenseCategory,
  FabricType,
  ProductCategory,
  Size,
  Warehouse,
} from "@/lib/types";

export type ProductLookups = {
  categories: ProductCategory[];
  fabrics: FabricType[];
  colors: Color[];
  sizes: Size[];
  designs: Design[];
  decorationTypes: DecorationType[];
};

export type CatalogSnapshot = ProductLookups & {
  warehouses: Warehouse[];
  expenseCategories: ExpenseCategory[];
};

export interface CatalogRepository {
  listCatalog(): Promise<CatalogSnapshot>;
  listProductLookups(): Promise<ProductLookups>;
  listWarehouses(): Promise<Warehouse[]>;
  listCategories(): Promise<ProductCategory[]>;
  listFabrics(): Promise<FabricType[]>;
  listColors(): Promise<Color[]>;
  listSizes(): Promise<Size[]>;
  listDesigns(type?: Design["type"]): Promise<Design[]>;
  listDecorationTypes(): Promise<DecorationType[]>;
  listExpenseCategories(includeArchived?: boolean): Promise<ExpenseCategory[]>;
}

export class PostgresCatalogRepository implements CatalogRepository {
  constructor(private readonly query: DatabaseQueryExecutor) {}

  async listCatalog(): Promise<CatalogSnapshot> {
    const [warehouses, lookups, expenseCategories] = await Promise.all([
      this.listWarehouses(),
      this.listProductLookups(),
      this.listExpenseCategories(true),
    ]);
    return { warehouses, ...lookups, expenseCategories };
  }

  async listProductLookups(): Promise<ProductLookups> {
    const [categories, fabrics, colors, sizes, designs, decorationTypes] = await Promise.all([
      this.listCategories(),
      this.listFabrics(),
      this.listColors(),
      this.listSizes(),
      this.listDesigns(),
      this.listDecorationTypes(),
    ]);
    return { categories, fabrics, colors, sizes, designs, decorationTypes };
  }

  async listWarehouses() {
    return (
      await this.query<Warehouse>(
        'SELECT id, name, type, address, contact, notes, created_at FROM merch_warehouses ORDER BY type COLLATE "C", name COLLATE "C", id',
      )
    ).rows;
  }

  async listCategories() {
    return (
      await this.query<ProductCategory>(
        'SELECT id, name, slug, created_at FROM merch_product_categories ORDER BY name COLLATE "C", id',
      )
    ).rows;
  }

  async listFabrics() {
    return (
      await this.query<FabricType>(
        'SELECT id, name, slug, created_at FROM merch_fabric_types ORDER BY name COLLATE "C", id',
      )
    ).rows;
  }

  async listColors() {
    return (
      await this.query<Color>(
        'SELECT id, name, hex_code, created_at FROM merch_colors ORDER BY name COLLATE "C", id',
      )
    ).rows;
  }

  async listSizes() {
    return (
      await this.query<Size>(
        "SELECT id, name, sort_order, created_at FROM merch_sizes ORDER BY sort_order, id",
      )
    ).rows;
  }

  async listDesigns(type?: Design["type"]) {
    return (
      await this.query<Design>(
        `
          SELECT id, name, type, code, description, image_url, created_at
          FROM merch_designs
          WHERE ($1::text IS NULL OR type = $1)
          ORDER BY name COLLATE "C", id
        `,
        [type ?? null],
      )
    ).rows;
  }

  async listDecorationTypes() {
    return (
      await this.query<DecorationType>(
        'SELECT id, name, slug, made_at, created_at FROM merch_decoration_types ORDER BY name COLLATE "C", id',
      )
    ).rows;
  }

  async listExpenseCategories(includeArchived = false) {
    return (
      await this.query<ExpenseCategory>(
        `
          SELECT id, name, color, sort_order, archived, created_at
          FROM merch_expense_categories
          WHERE ($1::boolean OR archived = false)
          ORDER BY sort_order, name COLLATE "C", id
        `,
        [includeArchived],
      )
    ).rows;
  }
}

export class SupabaseCatalogRepository implements CatalogRepository {
  constructor(private readonly client: SupabaseClient) {}

  async listCatalog(): Promise<CatalogSnapshot> {
    const [warehouses, lookups, expenseCategories] = await Promise.all([
      this.listWarehouses(),
      this.listProductLookups(),
      this.listExpenseCategories(true),
    ]);
    return { warehouses, ...lookups, expenseCategories };
  }

  async listProductLookups(): Promise<ProductLookups> {
    const [categories, fabrics, colors, sizes, designs, decorationTypes] = await Promise.all([
      this.listCategories(),
      this.listFabrics(),
      this.listColors(),
      this.listSizes(),
      this.listDesigns(),
      this.listDecorationTypes(),
    ]);
    return { categories, fabrics, colors, sizes, designs, decorationTypes };
  }

  listWarehouses() {
    return this.select<Warehouse>(
      "merch_warehouses",
      "id,name,type,address,contact,notes,created_at",
      ["type", "name", "id"],
    );
  }

  listCategories() {
    return this.select<ProductCategory>(
      "merch_product_categories",
      "id,name,slug,created_at",
      ["name", "id"],
    );
  }

  listFabrics() {
    return this.select<FabricType>(
      "merch_fabric_types",
      "id,name,slug,created_at",
      ["name", "id"],
    );
  }

  listColors() {
    return this.select<Color>(
      "merch_colors",
      "id,name,hex_code,created_at",
      ["name", "id"],
    );
  }

  listSizes() {
    return this.select<Size>(
      "merch_sizes",
      "id,name,sort_order,created_at",
      ["sort_order", "id"],
    );
  }

  async listDesigns(type?: Design["type"]) {
    let query = this.client
      .from("merch_designs")
      .select("id,name,type,code,description,image_url,created_at")
      .order("name")
      .order("id");
    if (type) query = query.eq("type", type);
    const { data, error } = await query;
    if (error) throw new DatabaseQueryError("Supabase repository query failed", { cause: error });
    return (data ?? []) as Design[];
  }

  listDecorationTypes() {
    return this.select<DecorationType>(
      "merch_decoration_types",
      "id,name,slug,made_at,created_at",
      ["name", "id"],
    );
  }

  async listExpenseCategories(includeArchived = false) {
    let query = this.client
      .from("merch_expense_categories")
      .select("id,name,color,sort_order,archived,created_at")
      .order("sort_order")
      .order("name")
      .order("id");
    if (!includeArchived) query = query.eq("archived", false);
    const { data, error } = await query;
    if (error) throw new DatabaseQueryError("Supabase repository query failed", { cause: error });
    return (data ?? []) as ExpenseCategory[];
  }

  private async select<T>(
    table: string,
    columns: string,
    orderColumns: string[],
  ): Promise<T[]> {
    let query = this.client.from(table).select(columns);
    for (const column of orderColumns) query = query.order(column);
    const { data, error } = await query;
    if (error) throw new DatabaseQueryError("Supabase repository query failed", { cause: error });
    return (data ?? []) as T[];
  }
}
