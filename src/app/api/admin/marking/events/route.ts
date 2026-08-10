import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import {
  AdminApiError,
  adminErrorResponse,
  adminJson,
  parseLimitParam,
  requireUuidParam,
} from "@/lib/admin/http";
import { InvalidMarkingCursorError } from "@/lib/marking/read-models/cursor";
import { markingReadRepository } from "@/lib/marking/read-models/repository";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const params = request.nextUrl.searchParams;
    const page = await markingReadRepository.listEvents({
      limit: parseLimitParam(params.get("limit"), { defaultValue: 50, max: 100 }),
      cursor: params.get("cursor"),
      processId: requireUuidParam(params.get("processId"), "processId"),
      eventType: parseTextFilter(params.get("eventType"), "eventType"),
      source: parseTextFilter(params.get("source"), "source"),
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

function parseTextFilter(value: string | null, name: string) {
  if (!value) return undefined;
  if (value.length > 120 || !/^[A-Za-z0-9._:@/-]+$/.test(value)) {
    throw new AdminApiError(400, "bad_request", `Invalid ${name} parameter`);
  }
  return value;
}
