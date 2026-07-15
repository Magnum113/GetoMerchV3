import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson, assertNoSupabaseError, parseLimitParam } from "@/lib/admin/http";
import { ADMIN_PRODUCT_SELECT_INLINE } from "@/lib/admin/selects";
import { getAdminSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const limit = parseLimitParam(request.nextUrl.searchParams.get("limit"), {
      defaultValue: 100,
      max: 500,
    });

    const { data, error } = await getAdminSupabaseClient()
      .from("merch_transactions")
      .select(
        `*, product:merch_products!product_id(${ADMIN_PRODUCT_SELECT_INLINE}), design:merch_designs!design_id(*), source_design:merch_designs!source_design_id(*), from_warehouse:merch_warehouses!from_warehouse_id(*), to_warehouse:merch_warehouses!to_warehouse_id(*)`,
      )
      .order("occurred_at", { ascending: false })
      .limit(limit);

    assertNoSupabaseError(error);
    return adminJson({ data: data ?? [], meta: { limit } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
