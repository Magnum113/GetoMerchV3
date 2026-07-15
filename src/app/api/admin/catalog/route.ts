import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson, assertNoSupabaseError } from "@/lib/admin/http";
import { getAdminSupabaseClient, getAdminSupabaseKeyMode } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest) {
  try {
    await requireAdminSession();
    const sb = getAdminSupabaseClient();
    const [
      warehouses,
      categories,
      fabrics,
      colors,
      sizes,
      decorationTypes,
      designs,
      expenseCategories,
    ] = await Promise.all([
      sb.from("merch_warehouses").select("*").order("type").order("name"),
      sb.from("merch_product_categories").select("*").order("name"),
      sb.from("merch_fabric_types").select("*").order("name"),
      sb.from("merch_colors").select("*").order("name"),
      sb.from("merch_sizes").select("*").order("sort_order"),
      sb.from("merch_decoration_types").select("*").order("name"),
      sb.from("merch_designs").select("*").order("name"),
      sb.from("merch_expense_categories").select("*").order("sort_order").order("name"),
    ]);

    for (const result of [
      warehouses,
      categories,
      fabrics,
      colors,
      sizes,
      decorationTypes,
      designs,
      expenseCategories,
    ]) {
      assertNoSupabaseError(result.error);
    }

    return adminJson({
      data: {
        warehouses: warehouses.data ?? [],
        categories: categories.data ?? [],
        fabrics: fabrics.data ?? [],
        colors: colors.data ?? [],
        sizes: sizes.data ?? [],
        decorationTypes: decorationTypes.data ?? [],
        designs: designs.data ?? [],
        expenseCategories: expenseCategories.data ?? [],
      },
      meta: { supabaseKeyMode: getAdminSupabaseKeyMode() },
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
