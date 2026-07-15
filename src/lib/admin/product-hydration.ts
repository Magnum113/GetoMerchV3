import "server-only";

import { assertNoSupabaseError } from "@/lib/admin/http";
import { getAdminSupabaseClient } from "@/lib/supabase/server";
import type {
  Color,
  DecorationType,
  Design,
  FabricType,
  Product,
  ProductCategory,
  Size,
} from "@/lib/types";

type ProductLookups = {
  categories: ProductCategory[];
  fabrics: FabricType[];
  colors: Color[];
  sizes: Size[];
  designs: Design[];
  decorationTypes: DecorationType[];
};

let lookupsCache: { data: ProductLookups; expiresAt: number } | null = null;
let lookupsInflight: Promise<ProductLookups> | null = null;

export async function hydrateProducts(products: Product[]) {
  if (products.length === 0) return [];

  const { categories, fabrics, colors, sizes, designs, decorationTypes } = await getProductLookups();

  const categoriesById = mapById(categories);
  const fabricsById = mapById(fabrics);
  const colorsById = mapById(colors);
  const sizesById = mapById(sizes);
  const designsById = mapById(designs);
  const decorationTypesById = mapById(decorationTypes);

  return products.map((product) => ({
    ...product,
    category: categoriesById.get(product.category_id),
    fabric: fabricsById.get(product.fabric_id),
    color: colorsById.get(product.color_id),
    size: sizesById.get(product.size_id),
    design: product.design_id ? designsById.get(product.design_id) ?? null : null,
    decoration_type: product.decoration_type_id
      ? decorationTypesById.get(product.decoration_type_id) ?? null
      : null,
  }));
}

async function getProductLookups() {
  const now = Date.now();
  if (lookupsCache && lookupsCache.expiresAt > now) return lookupsCache.data;
  if (lookupsInflight) return lookupsInflight;

  lookupsInflight = loadProductLookups()
    .then((data) => {
      lookupsCache = { data, expiresAt: Date.now() + 5 * 60 * 1000 };
      return data;
    })
    .catch((error) => {
      if (lookupsCache) return lookupsCache.data;
      throw error;
    })
    .finally(() => {
      lookupsInflight = null;
    });

  return lookupsInflight;
}

async function loadProductLookups(): Promise<ProductLookups> {
  const [categories, fabrics, colors, sizes, designs, decorationTypes] = await Promise.all([
    fetchLookupTable<ProductCategory>("merch_product_categories"),
    fetchLookupTable<FabricType>("merch_fabric_types"),
    fetchLookupTable<Color>("merch_colors"),
    fetchLookupTable<Size>("merch_sizes"),
    fetchLookupTable<Design>("merch_designs"),
    fetchLookupTable<DecorationType>("merch_decoration_types"),
  ]);

  return { categories, fabrics, colors, sizes, designs, decorationTypes };
}

async function fetchLookupTable<T extends { id: string }>(table: string) {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const { data, error } = await getAdminSupabaseClient()
        .from(table)
        .select("*")
        .abortSignal(controller.signal);

      if (!error) return (data ?? []) as T[];
      lastError = error;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }

    if (attempt < 3) await delay(250 * attempt);
  }

  assertNoSupabaseError(lastError, `Failed to load ${table}`);
  return [];
}

function mapById<T extends { id: string }>(rows: T[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
