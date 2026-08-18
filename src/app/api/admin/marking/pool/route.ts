import { NextRequest } from "next/server";
import { requireMarkingAdminSession } from "@/lib/marking/http";
import {
  AdminApiError,
  adminErrorResponse,
  adminJson,
  parseLimitParam,
} from "@/lib/admin/http";
import {
  MARKING_CODE_POOL_STATES,
  type MarkingCodePoolState,
} from "@/lib/marking/domain/states";
import { InvalidMarkingCursorError } from "@/lib/marking/read-models/cursor";
import { markingReadRepository } from "@/lib/marking/read-models/repository";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireMarkingAdminSession();
    const params = request.nextUrl.searchParams;
    const state = params.get("state");
    if (state && !(MARKING_CODE_POOL_STATES as readonly string[]).includes(state)) {
      throw new AdminApiError(400, "bad_request", "Invalid pool state");
    }
    const gtin = params.get("gtin")?.trim() || undefined;
    if (gtin && !/^\d{14}$/.test(gtin)) {
      throw new AdminApiError(400, "bad_request", "Invalid GTIN");
    }
    const search = params.get("search")?.trim() || undefined;
    if (search && search.length > 200) {
      throw new AdminApiError(400, "bad_request", "Search is too long");
    }
    const page = await markingReadRepository.listCodePool({
      limit: parseLimitParam(params.get("limit"), { defaultValue: 50, max: 100 }),
      cursor: params.get("cursor"),
      poolState: state as MarkingCodePoolState | undefined,
      gtin,
      search,
    });
    return adminJson({ data: page.items, page: page.page, summary: page.summary });
  } catch (error) {
    return adminErrorResponse(
      error instanceof InvalidMarkingCursorError
        ? new AdminApiError(400, "bad_request", "Invalid cursor parameter")
        : error,
    );
  }
}
