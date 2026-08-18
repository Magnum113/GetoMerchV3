import { requireMarkingAdminSession } from "@/lib/marking/http";
import { AdminApiError, adminErrorResponse, adminJson } from "@/lib/admin/http";
import { markingReadRepository } from "@/lib/marking/read-models/repository";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  contextInput: { params: Promise<{ id: string }> },
) {
  try {
    await requireMarkingAdminSession();
    const { id } = await contextInput.params;
    const data = await markingReadRepository.getProfileBackfill(id);
    if (!data) {
      throw new AdminApiError(404, "not_found", "Preview не найден");
    }
    return adminJson({ data });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
