import { NextRequest } from "next/server";
import { adminErrorResponse, adminJson } from "@/lib/admin/http";
import {
  markingMutationError,
  requireMarkingMutationContext,
  requireObjectBody,
  requiredBoolean,
  requiredInteger,
  requiredString,
} from "@/lib/marking/http";
import { releaseMarkingCode } from "@/lib/marking/services/code-pool-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  contextInput: { params: Promise<{ id: string }> },
) {
  try {
    const context = await requireMarkingMutationContext(request);
    const body = requireObjectBody(await request.json().catch(() => null));
    const { id } = await contextInput.params;
    const data = await releaseMarkingCode({
      codeId: id,
      expectedRevision: requiredInteger(body, "expectedRevision"),
      reason: requiredString(body, "reason"),
      destroyedPrintedCopies: requiredBoolean(body, "destroyedPrintedCopies"),
    }, context);
    return adminJson({ data });
  } catch (error) {
    return adminErrorResponse(markingMutationError(error));
  }
}
