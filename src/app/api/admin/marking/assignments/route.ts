import { NextRequest } from "next/server";
import {
  AdminApiError,
  adminErrorResponse,
  adminJson,
  parseLimitParam,
} from "@/lib/admin/http";
import {
  MARKING_ASSIGNMENT_STATUSES,
  type MarkingAssignmentStatus,
} from "@/lib/marking/domain/states";
import {
  markingMutationError,
  requireMarkingAdminSession,
  requireMarkingMutationContext,
  requireObjectBody,
  requiredString,
} from "@/lib/marking/http";
import { InvalidMarkingCursorError } from "@/lib/marking/read-models/cursor";
import { markingReadRepository } from "@/lib/marking/read-models/repository";
import { prepareMarkingAssignment } from "@/lib/marking/services/assignment-service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireMarkingAdminSession();
    const params = request.nextUrl.searchParams;
    const status = params.get("status");
    if (
      status
      && !(MARKING_ASSIGNMENT_STATUSES as readonly string[]).includes(status)
    ) {
      throw new AdminApiError(400, "bad_request", "Invalid assignment status");
    }
    const search = params.get("search")?.trim() || undefined;
    if (search && search.length > 200) {
      throw new AdminApiError(400, "bad_request", "Search is too long");
    }
    const page = await markingReadRepository.listAssignments({
      limit: parseLimitParam(params.get("limit"), { defaultValue: 50, max: 100 }),
      cursor: params.get("cursor"),
      status: status as MarkingAssignmentStatus | undefined,
      search,
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

export async function POST(request: NextRequest) {
  try {
    const context = await requireMarkingMutationContext(request);
    const body = requireObjectBody(await request.json().catch(() => null));
    const data = await prepareMarkingAssignment({
      fulfillmentItemId: requiredString(body, "fulfillmentItemId"),
      warehouseId: requiredString(body, "warehouseId"),
    }, context);
    return adminJson({ data }, { status: 201 });
  } catch (error) {
    return adminErrorResponse(markingMutationError(error));
  }
}
