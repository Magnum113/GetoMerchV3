import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson, assertNoSupabaseError } from "@/lib/admin/http";
import { getAdminSupabaseClient, getAdminSupabaseKeyMode } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest) {
  try {
    await requireAdminSession();
    const { error } = await getAdminSupabaseClient()
      .from("merch_product_categories")
      .select("id")
      .limit(1);

    assertNoSupabaseError(error, "Supabase health query failed");
    return adminJson({
      data: {
        status: "ok",
        supabase: "ok",
        supabaseKeyMode: getAdminSupabaseKeyMode(),
      },
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
