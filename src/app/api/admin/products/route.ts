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
import { hydrateProducts } from "@/lib/admin/product-hydration";
import { getAdminSupabaseClient } from "@/lib/supabase/server";
import type { Product } from "@/lib/types";

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
