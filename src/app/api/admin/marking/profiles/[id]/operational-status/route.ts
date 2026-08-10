import { NextRequest } from "next/server";
import { adminErrorResponse, adminJson } from "@/lib/admin/http";
import {
  markingMutationError,
  optionalString,
  requireMarkingMutationContext,
  requireObjectBody,
  requiredInteger,
  requiredString,
} from "@/lib/marking/http";
import { setMarkingProductOperationalStatus } from "@/lib/marking/services/product-readiness-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  contextInput: { params: Promise<{ id: string }> },
) {
  try {
    const context = await requireMarkingMutationContext(request);
    const { id } = await contextInput.params;
    const body = requireObjectBody(await request.json().catch(() => null));
    const data = await setMarkingProductOperationalStatus({
      profileId: id,
      expectedRevision: requiredInteger(body, "expectedRevision"),
      operationalStatus: requiredString(body, "operationalStatus") as never,
      reason: optionalString(body, "reason"),
    }, context);
    return adminJson({ data });
  } catch (error) {
    return adminErrorResponse(markingMutationError(error));
  }
}
