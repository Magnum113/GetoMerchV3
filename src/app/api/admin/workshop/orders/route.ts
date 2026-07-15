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
      .from("merch_workshop_orders")
      .select(
        `*, workshop:merch_warehouses(*), items:merch_workshop_order_items(*, blank_product:merch_products!blank_product_id(${ADMIN_PRODUCT_SELECT_INLINE}), result_product:merch_products!result_product_id(${ADMIN_PRODUCT_SELECT_INLINE}), design:merch_designs(*), decoration_type:merch_decoration_types(*))`,
      )
      .order("created_at", { ascending: false })
      .limit(limit);

    assertNoSupabaseError(error);
    return adminJson({ data: data ?? [], meta: { limit } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
