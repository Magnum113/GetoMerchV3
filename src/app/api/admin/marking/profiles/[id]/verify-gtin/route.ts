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
import { verifyMarkingProductGtin } from "@/lib/marking/services/product-readiness-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  contextInput: { params: Promise<{ id: string }> },
) {
  try {
    const context = await requireMarkingMutationContext(request);
    const { id } = await contextInput.params;
    const body = requireObjectBody(await request.json().catch(() => null));
    const data = await verifyMarkingProductGtin({
      profileId: id,
      expectedRevision: requiredInteger(body, "expectedRevision"),
      gtin: requiredString(body, "gtin"),
      productGroup: requiredString(body, "productGroup"),
      tnvedCode: optionalString(body, "tnvedCode"),
      nationalCatalogCardId: optionalString(body, "nationalCatalogCardId"),
      nationalCatalogStatus: optionalString(body, "nationalCatalogStatus"),
      declaredProductType: optionalString(body, "declaredProductType"),
      declaredFabric: optionalString(body, "declaredFabric"),
      declaredColor: optionalString(body, "declaredColor"),
      declaredSizeInt: optionalString(body, "declaredSizeInt"),
      declaredSizeRu: optionalString(body, "declaredSizeRu"),
      declaredComposition: optionalString(body, "declaredComposition"),
      verificationSource: requiredString(body, "verificationSource"),
      externalReference: optionalString(body, "externalReference"),
      sourceSnapshot: optionalObject(body, "sourceSnapshot"),
    }, context);
    return adminJson({ data });
  } catch (error) {
    return adminErrorResponse(markingMutationError(error));
  }
}
