import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { DatabaseQueryError } from "@/lib/db/errors";
import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import type { CatalogRepository, ProductLookups } from "@/lib/db/repositories/catalog";
import type { Product } from "@/lib/types";

export type ProductPageOptions = {
  limit: number;
  offset: number;
  isBlank?: boolean;
  designId?: string;
  search?: string;
};

export type ProductPage = {
  rows: Product[];
  hasMore: boolean;
};

export type ProductDimensions = Pick<
  Product,
  "category_id" | "fabric_id" | "color_id" | "size_id"
>;

export type BlankMatchKey = ProductDimensions;

export type DesignProductCount = { design_id: string; count: number };

export interface ProductRepository {
  listPage(options: ProductPageOptions): Promise<ProductPage>;
  listByIds(ids: string[]): Promise<Product[]>;
  findBlank(dimensions: ProductDimensions): Promise<Product | null>;
  findBlankMatches(keys: BlankMatchKey[]): Promise<Product[]>;
  listDesignProductCounts(): Promise<DesignProductCount[]>;
}

export const PRODUCT_COLUMNS = [
  "id",
  "category_id",
  "fabric_id",
  "color_id",
  "size_id",
  "design_id",
  "decoration_type_id",
  "sku",
  "ozon_sku",
  "legacy_skus",
  "design_version",
  "hoodie_fit",
  "hoodie_fabric",
  "is_blank",
  "cost_price",
  "sale_price",
  "created_at",
] as const;

export const PRODUCT_SELECT = PRODUCT_COLUMNS.join(",");

export class PostgresProductRepository implements ProductRepository {
  constructor(
    private readonly query: DatabaseQueryExecutor,
    private readonly catalog: CatalogRepository,
  ) {}

  async listPage(options: ProductPageOptions): Promise<ProductPage> {
    const values: unknown[] = [options.limit + 1, options.offset];
    const filters: string[] = [];

    if (options.isBlank !== undefined) {
      values.push(options.isBlank);
      filters.push(`p.is_blank = $${values.length}`);
    }
    if (options.designId) {
      values.push(options.designId);
      filters.push(`p.design_id = $${values.length}::uuid`);
    }
    if (options.search) {
      values.push(`%${escapeLikePattern(options.search)}%`);
      filters.push(`p.sku ILIKE $${values.length} ESCAPE '\\'`);
    }

    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const result = await this.query<Product>(
      `
        SELECT
          p.id,
          p.category_id,
          p.fabric_id,
          p.color_id,
          p.size_id,
          p.design_id,
          p.decoration_type_id,
          p.sku,
          p.ozon_sku::float8 AS ozon_sku,
          p.legacy_skus,
          p.design_version,
          p.hoodie_fit,
          p.hoodie_fabric,
          p.is_blank,
          p.cost_price::float8 AS cost_price,
          p.sale_price::float8 AS sale_price,
          p.created_at
        FROM merch_products p
        ${where}
        ORDER BY p.sku COLLATE "C" ASC NULLS LAST, p.id ASC
        LIMIT $1 OFFSET $2
      `,
      values,
    );
    return hydratePage(result.rows, options.limit, await this.catalog.listProductLookups());
  }

  async listByIds(ids: string[]) {
    const uniqueIds = unique(ids);
    if (uniqueIds.length === 0) return [];
    const result = await this.query<Product>(
      `
        SELECT ${postgresProductColumns("p")}
        FROM merch_products p
        WHERE p.id = ANY($1::uuid[])
        ORDER BY p.sku COLLATE "C" ASC NULLS LAST, p.id
      `,
      [uniqueIds],
    );
    return hydrateProducts(result.rows, await this.catalog.listProductLookups());
  }

  async findBlank(dimensions: ProductDimensions) {
    const result = await this.query<Product>(
      `
        SELECT ${postgresProductColumns("p")}
        FROM merch_products p
        WHERE p.category_id = $1::uuid
          AND p.fabric_id = $2::uuid
          AND p.color_id = $3::uuid
          AND p.size_id = $4::uuid
          AND p.is_blank = true
        LIMIT 1
      `,
      [dimensions.category_id, dimensions.fabric_id, dimensions.color_id, dimensions.size_id],
    );
    const [product] = await hydrateProducts(
      result.rows,
      await this.catalog.listProductLookups(),
    );
    return product ?? null;
  }

  async findBlankMatches(keys: BlankMatchKey[]) {
    if (keys.length === 0) return [];
    const result = await this.query<Product>(
      `
        WITH wanted AS (
          SELECT category_id, fabric_id, color_id, size_id
          FROM jsonb_to_recordset($1::jsonb) AS x(
            category_id uuid,
            fabric_id uuid,
            color_id uuid,
            size_id uuid
          )
        )
        SELECT ${postgresProductColumns("p")}
        FROM merch_products p
        JOIN wanted w
          ON w.category_id = p.category_id
         AND w.fabric_id = p.fabric_id
         AND w.color_id = p.color_id
         AND w.size_id = p.size_id
        WHERE p.is_blank = true
        ORDER BY p.sku COLLATE "C" ASC NULLS LAST, p.id
      `,
      [JSON.stringify(keys)],
    );
    return hydrateProducts(result.rows, await this.catalog.listProductLookups());
  }

  async listDesignProductCounts() {
    return (
      await this.query<DesignProductCount>(
        `
          SELECT design_id::text, COUNT(*)::int AS count
          FROM merch_products
          WHERE is_blank = false AND design_id IS NOT NULL
          GROUP BY design_id
          ORDER BY design_id
        `,
      )
    ).rows;
  }
}

export class SupabaseProductRepository implements ProductRepository {
  constructor(
    private readonly client: SupabaseClient,
    private readonly catalog: CatalogRepository,
  ) {}

  async listPage(options: ProductPageOptions): Promise<ProductPage> {
    let query = this.client
      .from("merch_products")
      .select(PRODUCT_SELECT)
      .order("sku", { ascending: true })
      .order("id", { ascending: true })
      .range(options.offset, options.offset + options.limit);

    if (options.isBlank !== undefined) query = query.eq("is_blank", options.isBlank);
    if (options.designId) query = query.eq("design_id", options.designId);
    if (options.search) query = query.ilike("sku", `%${escapeLikePattern(options.search)}%`);

    const { data, error } = await query;
    if (error) throw new DatabaseQueryError("Supabase repository query failed", { cause: error });
    return hydratePage(
      (data ?? []) as unknown as Product[],
      options.limit,
      await this.catalog.listProductLookups(),
    );
  }

  async listByIds(ids: string[]) {
    const uniqueIds = unique(ids);
    if (uniqueIds.length === 0) return [];
    const rows: Product[] = [];
    for (const idsChunk of chunk(uniqueIds, 200)) {
      const { data, error } = await this.client
        .from("merch_products")
        .select(PRODUCT_SELECT)
        .in("id", idsChunk)
        .order("sku")
        .order("id");
      if (error) throw new DatabaseQueryError("Supabase repository query failed", { cause: error });
      rows.push(...((data ?? []) as unknown as Product[]));
    }
    rows.sort(compareProducts);
    return hydrateProducts(
      rows,
      await this.catalog.listProductLookups(),
    );
  }

  async findBlank(dimensions: ProductDimensions) {
    const { data, error } = await this.client
      .from("merch_products")
      .select(PRODUCT_SELECT)
      .eq("category_id", dimensions.category_id)
      .eq("fabric_id", dimensions.fabric_id)
      .eq("color_id", dimensions.color_id)
      .eq("size_id", dimensions.size_id)
      .eq("is_blank", true)
      .maybeSingle();
    if (error) throw new DatabaseQueryError("Supabase repository query failed", { cause: error });
    if (!data) return null;
    return (
      await hydrateProducts(
        [data as unknown as Product],
        await this.catalog.listProductLookups(),
      )
    )[0] ?? null;
  }

  async findBlankMatches(keys: BlankMatchKey[]) {
    if (keys.length === 0) return [];
    const wanted = new Set(keys.map(blankKey));
    const rows: Product[] = [];
    const pageSize = 500;
    for (let offset = 0; offset < 10_000; offset += pageSize) {
      const { data, error } = await this.client
        .from("merch_products")
        .select(PRODUCT_SELECT)
        .eq("is_blank", true)
        .order("sku")
        .order("id")
        .range(offset, offset + pageSize - 1);
      if (error) throw new DatabaseQueryError("Supabase repository query failed", { cause: error });
      const page = (data ?? []) as unknown as Product[];
      rows.push(...page.filter((product) => wanted.has(blankKey(product))));
      if (page.length < pageSize) break;
    }
    return hydrateProducts(rows, await this.catalog.listProductLookups());
  }

  async listDesignProductCounts() {
    const counts = new Map<string, number>();
    const pageSize = 500;
    for (let offset = 0; offset < 20_000; offset += pageSize) {
      const { data, error } = await this.client
        .from("merch_products")
        .select("design_id")
        .eq("is_blank", false)
        .not("design_id", "is", null)
        .order("design_id")
        .range(offset, offset + pageSize - 1);
      if (error) throw new DatabaseQueryError("Supabase repository query failed", { cause: error });
      const page = (data ?? []) as Array<{ design_id: string | null }>;
      for (const row of page) {
        if (row.design_id) counts.set(row.design_id, (counts.get(row.design_id) ?? 0) + 1);
      }
      if (page.length < pageSize) break;
    }
    return Array.from(counts, ([design_id, count]) => ({ design_id, count })).sort((left, right) =>
      left.design_id.localeCompare(right.design_id),
    );
  }
}

function hydratePage(rows: Product[], limit: number, lookups: ProductLookups): ProductPage {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  return {
    hasMore,
    rows: hydrateProducts(pageRows, lookups),
  };
}

export function hydrateProducts(rows: Product[], lookups: ProductLookups) {
  const categories = byId(lookups.categories);
  const fabrics = byId(lookups.fabrics);
  const colors = byId(lookups.colors);
  const sizes = byId(lookups.sizes);
  const designs = byId(lookups.designs);
  const decorationTypes = byId(lookups.decorationTypes);
  return rows.map((product) => ({
      ...product,
      category: categories.get(product.category_id),
      fabric: fabrics.get(product.fabric_id),
      color: colors.get(product.color_id),
      size: sizes.get(product.size_id),
      design: product.design_id ? designs.get(product.design_id) ?? null : null,
      decoration_type: product.decoration_type_id
        ? decorationTypes.get(product.decoration_type_id) ?? null
        : null,
    }));
}

export function postgresProductColumns(alias: string) {
  return `
    ${alias}.id,
    ${alias}.category_id,
    ${alias}.fabric_id,
    ${alias}.color_id,
    ${alias}.size_id,
    ${alias}.design_id,
    ${alias}.decoration_type_id,
    ${alias}.sku,
    ${alias}.ozon_sku::float8 AS ozon_sku,
    ${alias}.legacy_skus,
    ${alias}.design_version,
    ${alias}.hoodie_fit,
    ${alias}.hoodie_fabric,
    ${alias}.is_blank,
    ${alias}.cost_price::float8 AS cost_price,
    ${alias}.sale_price::float8 AS sale_price,
    ${alias}.created_at
  `;
}

function byId<T extends { id: string }>(rows: T[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

function escapeLikePattern(value: string) {
  return value.replace(/[%_\\]/g, (char) => `\\${char}`);
}

function unique(items: string[]) {
  return Array.from(new Set(items.filter(Boolean)));
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function compareProducts(left: Product, right: Product) {
  if (left.sku == null && right.sku != null) return 1;
  if (left.sku != null && right.sku == null) return -1;
  const skuOrder = (left.sku ?? "") < (right.sku ?? "")
    ? -1
    : (left.sku ?? "") > (right.sku ?? "")
      ? 1
      : 0;
  return skuOrder || left.id.localeCompare(right.id);
}

function blankKey(product: ProductDimensions) {
  return `${product.category_id}|${product.fabric_id}|${product.color_id}|${product.size_id}`;
}
