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
import { saveTradeItemConformityDocument } from "@/lib/marking/services/product-readiness-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  contextInput: { params: Promise<{ id: string }> },
) {
  try {
    const context = await requireMarkingMutationContext(request);
    const { id } = await contextInput.params;
    const body = requireObjectBody(await request.json().catch(() => null));
    const data = await saveTradeItemConformityDocument({
      profileId: id,
      expectedRevision: requiredInteger(body, "expectedRevision"),
      documentType: requiredString(body, "documentType") as never,
      documentNumber: requiredString(body, "documentNumber"),
      issuedAt: requiredString(body, "issuedAt"),
      validUntil: optionalString(body, "validUntil"),
      verificationSource: requiredString(body, "verificationSource"),
      externalReference: optionalString(body, "externalReference"),
      sourceSnapshot: optionalObject(body, "sourceSnapshot"),
    }, context);
    return adminJson({ data });
  } catch (error) {
    return adminErrorResponse(markingMutationError(error));
  }
}
