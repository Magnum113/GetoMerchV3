import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { AdminApiError, adminErrorResponse, adminJson } from "@/lib/admin/http";
import { getServerImportPreview } from "@/lib/ozon/import-server";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ runId: string }> },
) {
  try {
    await requireAdminSession();
    const { runId } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
      throw new AdminApiError(400, "bad_request", "Invalid import run ID");
    }
    const preview = await getServerImportPreview(runId);
    if (!preview) throw new AdminApiError(404, "not_found", "Запуск импорта не найден");
    return adminJson({ data: preview });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
