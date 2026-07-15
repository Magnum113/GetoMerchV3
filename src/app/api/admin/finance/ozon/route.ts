import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson, assertNoSupabaseError, parseLimitParam } from "@/lib/admin/http";
import { getAdminSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const params = request.nextUrl.searchParams;
    const limit = parseLimitParam(params.get("limit"), { defaultValue: 500, max: 1000 });

    let query = getAdminSupabaseClient()
      .from("merch_ozon_finance_operations")
      .select("id, operation_id, operation_type, operation_type_name, operation_date, posting_number, accruals_for_sale, sale_commission, amount, services, items, synced_at")
      .order("operation_date", { ascending: false })
      .limit(limit);

    if (params.get("from")) query = query.gte("operation_date", params.get("from")!);
    if (params.get("to")) query = query.lte("operation_date", params.get("to")!);
    if (params.get("posting_number")) query = query.eq("posting_number", params.get("posting_number")!);

    const { data, error } = await query;
    assertNoSupabaseError(error);

    return adminJson({ data: data ?? [], meta: { limit } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
