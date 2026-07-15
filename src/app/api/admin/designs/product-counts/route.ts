import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson, assertNoSupabaseError } from "@/lib/admin/http";
import { adminDbQuery, hasAdminPostgres } from "@/lib/admin/postgres";
import { getAdminSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ProductDesignRef = {
  design_id: string | null;
};

const PAGE_SIZE = 200;
const MAX_ROWS = 20_000;
const QUERY_TIMEOUT_MS = 12_000;

export async function GET() {
  try {
    await requireAdminSession();

    if (hasAdminPostgres()) {
      const result = await adminDbQuery<{ design_id: string; count: number }>(
        `
          SELECT design_id::text, COUNT(*)::int AS count
          FROM merch_products
          WHERE is_blank = false
            AND design_id IS NOT NULL
          GROUP BY design_id
          ORDER BY design_id
        `,
      );
      return adminJson({ data: result.rows });
    }

    const counts = new Map<string, number>();
    let offset = 0;
    while (offset < MAX_ROWS) {
      const page = await queryWithRetry(`design product counts ${offset}`, async (signal) => {
        const { data, error } = await getAdminSupabaseClient()
          .from("merch_products")
          .select("design_id")
          .eq("is_blank", false)
          .not("design_id", "is", null)
          .range(offset, offset + PAGE_SIZE - 1)
          .abortSignal(signal);
        if (error) throw error;
        return (data ?? []) as ProductDesignRef[];
      });
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

async function queryWithRetry<T>(label: string, query: (signal: AbortSignal) => Promise<T>) {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
    try {
      return await query(controller.signal);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 3) await delay(250 * attempt);
  }

  assertNoSupabaseError(lastError, `Failed to load ${label}`);
  throw lastError;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
