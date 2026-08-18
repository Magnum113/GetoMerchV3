import { NextRequest } from "next/server";
import { requireMarkingAdminSession } from "@/lib/marking/http";
import {
  AdminApiError,
  adminErrorResponse,
  adminJson,
  parseLimitParam,
} from "@/lib/admin/http";
import {
  MARKING_PROCESS_STATUSES,
  type MarkingProcessStatus,
} from "@/lib/marking/domain/states";
import { InvalidMarkingCursorError } from "@/lib/marking/read-models/cursor";
import { markingReadRepository } from "@/lib/marking/read-models/repository";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireMarkingAdminSession();
    const params = request.nextUrl.searchParams;
    const status = params.get("status");
    if (status && !(MARKING_PROCESS_STATUSES as readonly string[]).includes(status)) {
      throw new AdminApiError(400, "bad_request", "Invalid status parameter");
    }
    const page = await markingReadRepository.listProcesses({
      limit: parseLimitParam(params.get("limit"), { defaultValue: 50, max: 100 }),
      cursor: params.get("cursor"),
      status: status as MarkingProcessStatus | undefined,
      processType: parseTextFilter(params.get("processType"), "processType", 120),
      source: parseTextFilter(params.get("source"), "source", 120),
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

function parseTextFilter(value: string | null, name: string, max: number) {
  if (!value) return undefined;
  if (value.length > max || !/^[A-Za-z0-9._:@/-]+$/.test(value)) {
    throw new AdminApiError(400, "bad_request", `Invalid ${name} parameter`);
  }
  return value;
}
