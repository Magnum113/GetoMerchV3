import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import {
  adminErrorResponse,
  adminJson,
  assertNoSupabaseError,
  parseLimitParam,
  requireUuidParam,
} from "@/lib/admin/http";
import { getAdminSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const params = request.nextUrl.searchParams;
    const limit = parseLimitParam(params.get("limit"), { defaultValue: 500, max: 1000 });
    const categoryId = requireUuidParam(params.get("category_id"), "category_id");

    let query = getAdminSupabaseClient()
      .from("merch_expenses")
      .select("*, category:merch_expense_categories(*)")
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);

    if (params.get("from")) query = query.gte("occurred_at", params.get("from")!);
    if (params.get("to")) query = query.lte("occurred_at", params.get("to")!);
    if (categoryId) query = query.eq("category_id", categoryId);

    const { data, error } = await query;
    assertNoSupabaseError(error);

    return adminJson({ data: data ?? [], meta: { limit } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
