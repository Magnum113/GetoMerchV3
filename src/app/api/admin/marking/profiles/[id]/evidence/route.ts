import { NextRequest } from "next/server";
import { adminErrorResponse, adminJson } from "@/lib/admin/http";
import {
  markingMutationError,
  optionalObject,
  optionalString,
  requireMarkingMutationContext,
  requireObjectBody,
  requiredInteger,
  requiredString,
} from "@/lib/marking/http";
import { attachMarkingProductEvidence } from "@/lib/marking/services/product-readiness-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  contextInput: { params: Promise<{ id: string }> },
) {
  try {
    const context = await requireMarkingMutationContext(request);
    const { id } = await contextInput.params;
    const body = requireObjectBody(await request.json().catch(() => null));
    const data = await attachMarkingProductEvidence({
      profileId: id,
      expectedRevision: requiredInteger(body, "expectedRevision"),
      evidenceType: requiredString(body, "evidenceType"),
      source: requiredString(body, "source"),
      externalReference: optionalString(body, "externalReference"),
      scope: optionalObject(body, "scope"),
      details: optionalObject(body, "details"),
      verificationStatus: requiredString(body, "verificationStatus") as never,
      sourceSnapshot: optionalObject(body, "sourceSnapshot"),
    }, context);
    return adminJson({ data });
  } catch (error) {
    return adminErrorResponse(markingMutationError(error));
  }
}
