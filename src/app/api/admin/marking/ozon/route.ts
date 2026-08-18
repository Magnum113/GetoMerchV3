import { NextRequest } from "next/server";
import {
  AdminApiError,
  adminErrorResponse,
  adminJson,
  parseLimitParam,
} from "@/lib/admin/http";
import { queryServerDatabase } from "@/lib/db/pool";
import {
  markingMutationError,
  requireMarkingAdminSession,
  requireMarkingMutationContext,
  requireObjectBody,
  requiredString,
} from "@/lib/marking/http";
import { listOzonSubmissionBatches } from "@/lib/marking/repositories/ozon-exemplars";
import { requestOzonExemplarOperation } from "@/lib/marking/services/ozon-exemplar-service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireMarkingAdminSession();
    const data = await listOzonSubmissionBatches(
      queryServerDatabase,
      parseLimitParam(request.nextUrl.searchParams.get("limit"), {
        defaultValue: 50,
        max: 100,
      }),
    );
    return adminJson({ data });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const context = await requireMarkingMutationContext(request);
    const body = requireObjectBody(await request.json().catch(() => null));
    const operation = requiredString(body, "operation");
    if (operation !== "validate" && operation !== "submit") {
      throw new AdminApiError(400, "bad_request", "Invalid Ozon exemplar operation");
    }
    if (body.forceCorrection != null && typeof body.forceCorrection !== "boolean") {
      throw new AdminApiError(400, "bad_request", "forceCorrection must be a boolean");
    }
    const data = await requestOzonExemplarOperation({
      fulfillmentOrderId: requiredString(body, "fulfillmentOrderId"),
      operation,
      forceCorrection: body.forceCorrection === true,
    }, context);
    return adminJson({ data }, { status: data.job ? 202 : 200 });
  } catch (error) {
    return adminErrorResponse(markingMutationError(error));
  }
}
