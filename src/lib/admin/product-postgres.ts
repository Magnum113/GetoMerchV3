import "server-only";

import { adminDbQuery } from "@/lib/admin/postgres";
import type {
  Color,
  DecorationType,
  Design,
  FabricType,
  Product,
  ProductCategory,
  Size,
} from "@/lib/types";

export const ADMIN_PRODUCT_COLUMNS = `
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
`;

export async function fetchProductsByIdsViaPostgres(ids: string[]) {
  const uniqueIds = unique(ids.filter(Boolean));
  if (uniqueIds.length === 0) return new Map<string, Product>();

  const result = await adminDbQuery<Product>(
    `
      SELECT ${ADMIN_PRODUCT_COLUMNS}
      FROM merch_products p
      WHERE p.id = ANY($1::uuid[])
      ORDER BY p.sku
    `,
    [uniqueIds],
  );
  const products = await hydrateProductsViaPostgres(result.rows);
  return new Map(products.map((product) => [product.id, product]));
}

export async function fetchProductPageViaPostgres(limit: number, offset: number) {
  const result = await adminDbQuery<Product>(
    `
      SELECT ${ADMIN_PRODUCT_COLUMNS}
      FROM merch_products p
      ORDER BY p.sku
      LIMIT $1 OFFSET $2
    `,
    [limit, offset],
  );
  return hydrateProductsViaPostgres(result.rows);
}

export async function hydrateProductsViaPostgres(products: Product[]) {
  if (products.length === 0) return products;

  const categories = await fetchCategories();
  const fabrics = await fetchFabrics();
  const colors = await fetchColors();
  const sizes = await fetchSizes();
  const designs = await fetchDesigns();
  const decorationTypes = await fetchDecorationTypes();

  return products.map((product) => ({
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

async function fetchCategories() {
  const result = await adminDbQuery<ProductCategory>(
    `
      SELECT id, name, slug, created_at
      FROM merch_product_categories
    `,
  );
  return byId(result.rows);
}

async function fetchFabrics() {
  const result = await adminDbQuery<FabricType>(
    `
      SELECT id, name, slug, created_at
      FROM merch_fabric_types
    `,
  );
  return byId(result.rows);
}

async function fetchColors() {
  const result = await adminDbQuery<Color>(
    `
      SELECT id, name, hex_code, created_at
      FROM merch_colors
    `,
  );
  return byId(result.rows);
}

async function fetchSizes() {
  const result = await adminDbQuery<Size>(
    `
      SELECT id, name, sort_order, created_at
      FROM merch_sizes
    `,
  );
  return byId(result.rows);
}

async function fetchDesigns() {
  const result = await adminDbQuery<Design>(
    `
      SELECT id, name, type, code, description, image_url, created_at
      FROM merch_designs
    `,
  );
  return byId(result.rows);
}

async function fetchDecorationTypes() {
  const result = await adminDbQuery<DecorationType>(
    `
      SELECT id, name, slug, made_at, created_at
      FROM merch_decoration_types
    `,
  );
  return byId(result.rows);
}

function byId<T extends { id: string }>(rows: T[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

function unique(items: string[]) {
  return Array.from(new Set(items));
}
