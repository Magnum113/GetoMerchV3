import { NextRequest } from "next/server";
import { adminErrorResponse, adminJson } from "@/lib/admin/http";
import {
  markingMutationError,
  requireMarkingMutationContext,
  requireObjectBody,
  requiredInteger,
  requiredString,
} from "@/lib/marking/http";
import { cancelMarkingAssignment } from "@/lib/marking/services/assignment-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  contextInput: { params: Promise<{ id: string }> },
) {
  try {
    const context = await requireMarkingMutationContext(request);
    const body = requireObjectBody(await request.json().catch(() => null));
    const { id } = await contextInput.params;
    const data = await cancelMarkingAssignment({
      assignmentId: id,
      expectedRevision: requiredInteger(body, "expectedRevision"),
      reason: requiredString(body, "reason"),
    }, context);
    return adminJson({ data });
  } catch (error) {
    return adminErrorResponse(markingMutationError(error));
  }
}
