import { NextRequest } from "next/server";
import { requireMarkingAdminSession } from "@/lib/marking/http";
import { AdminApiError, adminErrorResponse, adminJson, parseLimitParam } from "@/lib/admin/http";
import { InvalidMarkingCursorError } from "@/lib/marking/read-models/cursor";
import { markingReadRepository } from "@/lib/marking/read-models/repository";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireMarkingAdminSession();
    const page = await markingReadRepository.listCodeImports({
      limit: parseLimitParam(request.nextUrl.searchParams.get("limit"), {
        defaultValue: 30,
        max: 100,
      }),
      cursor: request.nextUrl.searchParams.get("cursor"),
    });
    return adminJson({ data: page.items, page: page.page });
  } catch (error) {
    return adminErrorResponse(
      error instanceof InvalidMarkingCursorError
        ? new AdminApiError(400, "bad_request", "Invalid cursor parameter")
        : error,
    );
  }
}
