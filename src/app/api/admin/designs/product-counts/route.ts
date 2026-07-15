import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson, assertNoSupabaseError } from "@/lib/admin/http";
import { getAdminSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ProductDesignRef = {
  design_id: string | null;
};

const PAGE_SIZE = 1000;
const MAX_ROWS = 20_000;

export async function GET() {
  try {
    await requireAdminSession();

    const counts = new Map<string, number>();
    let offset = 0;
    while (offset < MAX_ROWS) {
      const { data, error } = await getAdminSupabaseClient()
        .from("merch_products")
        .select("design_id")
        .eq("is_blank", false)
        .not("design_id", "is", null)
        .range(offset, offset + PAGE_SIZE - 1);
      assertNoSupabaseError(error);

      const page = (data ?? []) as ProductDesignRef[];
      for (const row of page) {
        if (!row.design_id) continue;
        counts.set(row.design_id, (counts.get(row.design_id) ?? 0) + 1);
      }
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    return adminJson({
      data: Array.from(counts.entries()).map(([design_id, count]) => ({ design_id, count })),
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
