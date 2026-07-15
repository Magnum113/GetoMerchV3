import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import {
  adminErrorResponse,
  adminJson,
  assertNoSupabaseError,
  parseLimitParam,
  requireUuidParam,
} from "@/lib/admin/http";
import { ADMIN_PRODUCT_SELECT_INLINE } from "@/lib/admin/selects";
import { getAdminSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const params = request.nextUrl.searchParams;
    const limit = parseLimitParam(params.get("limit"), { defaultValue: 500, max: 1000 });
    const warehouseId = requireUuidParam(params.get("warehouse_id"), "warehouse_id");

    let query = getAdminSupabaseClient()
      .from("merch_inventory")
      .select(
        `*, product:merch_products(${ADMIN_PRODUCT_SELECT_INLINE}), warehouse:merch_warehouses(*)`,
      )
      .gt("quantity", 0)
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (warehouseId) query = query.eq("warehouse_id", warehouseId);

    const { data, error } = await query;
    assertNoSupabaseError(error);

    return adminJson({ data: data ?? [], meta: { limit } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
