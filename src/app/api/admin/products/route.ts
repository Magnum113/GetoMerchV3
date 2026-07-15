import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import {
  adminErrorResponse,
  adminJson,
  assertNoSupabaseError,
  parseBooleanParam,
  parseLimitParam,
  parseOffsetParam,
  requireUuidParam,
} from "@/lib/admin/http";
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

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const params = request.nextUrl.searchParams;
    const limit = parseLimitParam(params.get("limit"), { defaultValue: 200, max: 1000 });
    const offset = parseOffsetParam(params.get("offset"));
    const isBlank = parseBooleanParam(params.get("is_blank"), "is_blank");
    const designId = requireUuidParam(params.get("design_id"), "design_id");
    const sku = params.get("sku")?.trim();
    const beforeCreatedAt = params.get("before_created_at")?.trim();

    const sb = getAdminSupabaseClient();
    let query = sb
      .from("merch_products")
      .select("*")
      .order("sku", { ascending: true })
      .range(offset, offset + limit - 1);

    if (isBlank !== undefined) query = query.eq("is_blank", isBlank);
    if (designId) query = query.eq("design_id", designId);
    if (sku) query = query.ilike("sku", `%${escapeLikePattern(sku)}%`);
    if (beforeCreatedAt) query = query.lt("created_at", beforeCreatedAt);

    const { data, error } = await query;
    assertNoSupabaseError(error);

    const products = await hydrateProducts((data ?? []) as Product[]);
    return adminJson({ data: products, meta: { limit, offset } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

async function hydrateProducts(products: Product[]) {
  if (products.length === 0) return [];

  const [
    categories,
    fabrics,
    colors,
    sizes,
    designs,
    decorationTypes,
  ] = await Promise.all([
    fetchByIds<ProductCategory>("merch_product_categories", ids(products, (product) => product.category_id)),
    fetchByIds<FabricType>("merch_fabric_types", ids(products, (product) => product.fabric_id)),
    fetchByIds<Color>("merch_colors", ids(products, (product) => product.color_id)),
    fetchByIds<Size>("merch_sizes", ids(products, (product) => product.size_id)),
    fetchByIds<Design>("merch_designs", ids(products, (product) => product.design_id)),
    fetchByIds<DecorationType>("merch_decoration_types", ids(products, (product) => product.decoration_type_id)),
  ]);

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

async function fetchByIds<T extends { id: string }>(table: string, values: string[]) {
  if (values.length === 0) return [];

  const { data, error } = await getAdminSupabaseClient()
    .from(table)
    .select("*")
    .in("id", values);

  assertNoSupabaseError(error, `Failed to load ${table}`);
  return (data ?? []) as T[];
}

function ids<T>(rows: T[], read: (row: T) => string | null | undefined) {
  const values = new Set<string>();
  for (const row of rows) {
    const value = read(row);
    if (value) values.add(value);
  }
  return Array.from(values);
}

function mapById<T extends { id: string }>(rows: T[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

function escapeLikePattern(value: string) {
  return value.replace(/[%_\\]/g, (char) => `\\${char}`);
}
