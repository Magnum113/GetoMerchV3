import { NextRequest } from "next/server";
import { adminErrorResponse, adminJson } from "@/lib/admin/http";
import {
  markingMutationError,
  optionalObject,
  optionalString,
  requireMarkingMutationContext,
  requireObjectBody,
  requiredString,
} from "@/lib/marking/http";
import { upsertMarkingProductProfile } from "@/lib/marking/services/product-readiness-service";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const context = await requireMarkingMutationContext(request);
    const body = requireObjectBody(await request.json().catch(() => null));
    const data = await upsertMarkingProductProfile({
      productId: requiredString(body, "productId"),
      expectedRevision: body.expectedRevision == null
        ? null
        : Number(body.expectedRevision),
      markingRequirement: requiredString(body, "markingRequirement") as never,
      requirementSource: optionalString(body, "requirementSource"),
      requirementObservedAt: optionalString(body, "requirementObservedAt"),
      productionMode: requiredString(body, "productionMode") as never,
      fulfillmentMode: requiredString(body, "fulfillmentMode") as never,
      channel: requiredString(body, "channel") as never,
      offerId: optionalString(body, "offerId"),
      externalProductId: optionalString(body, "externalProductId"),
      externalSku: optionalString(body, "externalSku"),
      sourceSnapshot: optionalObject(body, "sourceSnapshot"),
    }, context);
    return adminJson({ data });
  } catch (error) {
    return adminErrorResponse(markingMutationError(error));
  }
}
