import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson, assertNoSupabaseError, parseLimitParam } from "@/lib/admin/http";
import { ADMIN_PRODUCT_SELECT_INLINE } from "@/lib/admin/selects";
import { getAdminSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const params = request.nextUrl.searchParams;
    const limit = parseLimitParam(params.get("limit"), { defaultValue: 100, max: 500 });
    const status = params.get("status")?.trim();
    const source = params.get("source")?.trim();

    let query = getAdminSupabaseClient()
      .from("merch_ozon_orders")
      .select(
        `*, workshop_order:merch_workshop_orders(*), items:merch_ozon_order_items(*, product:merch_products(${ADMIN_PRODUCT_SELECT_INLINE}))`,
      )
      .order("in_process_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(limit);

    if (status) query = query.eq("status", status);
    if (source) query = query.eq("source", source);

    const { data, error } = await query;
    assertNoSupabaseError(error);

    return adminJson({ data: data ?? [], meta: { limit } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
