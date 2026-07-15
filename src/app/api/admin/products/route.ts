import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import {
  adminErrorResponse,
  adminJson,
  assertNoSupabaseError,
  parseBooleanParam,
  parseLimitParam,
  requireUuidParam,
} from "@/lib/admin/http";
import { ADMIN_PRODUCT_SELECT } from "@/lib/admin/selects";
import { getAdminSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const params = request.nextUrl.searchParams;
    const limit = parseLimitParam(params.get("limit"), { defaultValue: 200, max: 1000 });
    const isBlank = parseBooleanParam(params.get("is_blank"), "is_blank");
    const designId = requireUuidParam(params.get("design_id"), "design_id");
    const sku = params.get("sku")?.trim();

    let query = getAdminSupabaseClient()
      .from("merch_products")
      .select(ADMIN_PRODUCT_SELECT)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (isBlank !== undefined) query = query.eq("is_blank", isBlank);
    if (designId) query = query.eq("design_id", designId);
    if (sku) query = query.ilike("sku", `%${escapeLikePattern(sku)}%`);

    const { data, error } = await query;
    assertNoSupabaseError(error);

    return adminJson({ data: data ?? [], meta: { limit } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

function escapeLikePattern(value: string) {
  return value.replace(/[%_\\]/g, (char) => `\\${char}`);
}
