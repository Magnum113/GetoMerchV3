import { NextRequest } from "next/server";
import { adminErrorResponse, adminJson } from "@/lib/admin/http";
import {
  markingMutationError,
  requireMarkingMutationContext,
} from "@/lib/marking/http";
import { applyMarkingProfileBackfill } from "@/lib/marking/services/product-readiness-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  contextInput: { params: Promise<{ id: string }> },
) {
  try {
    const context = await requireMarkingMutationContext(request);
    const { id } = await contextInput.params;
    const data = await applyMarkingProfileBackfill({ runId: id }, context);
    return adminJson({ data });
  } catch (error) {
    return adminErrorResponse(markingMutationError(error));
  }
}
