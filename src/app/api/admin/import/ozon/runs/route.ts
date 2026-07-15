import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson, assertNoSupabaseError, parseLimitParam } from "@/lib/admin/http";
import { getAdminSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const params = request.nextUrl.searchParams;
    const limit = parseLimitParam(params.get("limit"), { defaultValue: 50, max: 200 });
    const status = params.get("status")?.trim();

    let query = getAdminSupabaseClient()
      .from("merch_ozon_import_runs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    assertNoSupabaseError(error);

    return adminJson({ data: data ?? [], meta: { limit } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
