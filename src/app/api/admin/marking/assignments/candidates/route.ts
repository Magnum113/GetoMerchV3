import { NextRequest } from "next/server";
import { requireMarkingAdminSession } from "@/lib/marking/http";
import {
  AdminApiError,
  adminErrorResponse,
  adminJson,
  parseLimitParam,
} from "@/lib/admin/http";
import { markingReadRepository } from "@/lib/marking/read-models/repository";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireMarkingAdminSession();
    const params = request.nextUrl.searchParams;
    const search = params.get("search")?.trim() || undefined;
    if (search && search.length > 200) {
      throw new AdminApiError(400, "bad_request", "Search is too long");
    }
    const data = await markingReadRepository.listJitCandidates({
      limit: parseLimitParam(params.get("limit"), { defaultValue: 100, max: 200 }),
      search,
    });
    return adminJson({ data });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
