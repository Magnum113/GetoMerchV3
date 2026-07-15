import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import {
  AdminApiError,
  adminErrorResponse,
  adminJson,
  assertNoSupabaseError,
  parseBooleanParam,
  parseLimitParam,
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
    const limit = parseLimitParam(params.get("limit"), { defaultValue: 50, max: 500 });
    const offset = parseProductCursor(params.get("cursor") ?? params.get("offset"));
    const isBlank = parseBooleanParam(params.get("is_blank"), "is_blank");
    const designId = requireUuidParam(params.get("design_id"), "design_id");
    const search = (params.get("search") ?? params.get("sku") ?? "").trim();

    const sb = getAdminSupabaseClient();
    let query = sb
      .from("merch_products")
      .select("*")
      .order("sku", { ascending: true })
      .range(offset, offset + limit);

    if (isBlank !== undefined) query = query.eq("is_blank", isBlank);
    if (designId) query = query.eq("design_id", designId);
    if (search) query = query.ilike("sku", `%${escapeLikePattern(search)}%`);

    const { data, error } = await query;
    assertNoSupabaseError(error);

    const rows = (data ?? []) as Product[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const products = await hydrateProducts(pageRows);
    return adminJson({
      data: products,
      meta: {
        limit,
        offset,
        nextCursor: hasMore ? encodeProductCursor(offset + limit) : null,
        hasMore,
      },
    });
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
    fetchLookupTable<ProductCategory>("merch_product_categories"),
    fetchLookupTable<FabricType>("merch_fabric_types"),
    fetchLookupTable<Color>("merch_colors"),
    fetchLookupTable<Size>("merch_sizes"),
    fetchLookupTable<Design>("merch_designs"),
    fetchLookupTable<DecorationType>("merch_decoration_types"),
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

async function fetchLookupTable<T extends { id: string }>(table: string) {
  const { data, error } = await getAdminSupabaseClient()
    .from(table)
    .select("*");

  assertNoSupabaseError(error, `Failed to load ${table}`);
  return (data ?? []) as T[];
}

function mapById<T extends { id: string }>(rows: T[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

function parseProductCursor(value: string | null) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }

  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { offset?: unknown };
    const offset = decoded.offset;
    if (typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0) return offset;
  } catch {
    // handled below
  }

  throw new AdminApiError(400, "bad_request", "Invalid cursor parameter");
}

function encodeProductCursor(offset: number) {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function escapeLikePattern(value: string) {
  return value.replace(/[%_\\]/g, (char) => `\\${char}`);
}
