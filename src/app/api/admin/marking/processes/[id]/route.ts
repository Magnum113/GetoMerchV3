import { requireMarkingAdminSession } from "@/lib/marking/http";
import {
  AdminApiError,
  adminErrorResponse,
  adminJson,
  requireUuidParam,
} from "@/lib/admin/http";
import { markingReadRepository } from "@/lib/marking/read-models/repository";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireMarkingAdminSession();
    const { id: rawId } = await context.params;
    const id = requireUuidParam(rawId, "id");
    if (!id) throw new AdminApiError(400, "bad_request", "Process id is required");
    const detail = await markingReadRepository.getProcess(id);
    if (!detail) {
      throw new AdminApiError(404, "not_found", "Marking process not found");
    }
    return adminJson({ data: detail });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
