import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { AdminApiError, adminErrorResponse, adminJson } from "@/lib/admin/http";
import {
  markingMutationError,
  requireMarkingMutationContext,
  requireObjectBody,
  requiredBoolean,
  requiredInteger,
  requiredString,
} from "@/lib/marking/http";
import {
  approveSuzDraft,
  cancelSuzDraft,
  changeSuzPoolPolicy,
  createSuzDraft,
  getSuzOrderWorkspace,
  requestSuzOrderPoll,
} from "@/lib/marking/services/suz-order-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdminSession();
    return adminJson({ data: await getSuzOrderWorkspace() });
  } catch (error) {
    return adminErrorResponse(markingMutationError(error));
  }
}

export async function POST(request: NextRequest) {
  try {
    const context = await requireMarkingMutationContext(request);
    const body = requireObjectBody(await request.json().catch(() => null));
    const operation = requiredString(body, "operation");
    if (operation === "update_policy") {
      const data = await changeSuzPoolPolicy({
        tradeItemId: requiredString(body, "tradeItemId"),
        expectedRevision: requiredInteger(body, "expectedRevision"),
        enabled: requiredBoolean(body, "enabled"),
        minimum: requiredInteger(body, "minimum"),
        target: requiredInteger(body, "target"),
        leadTimeHours: requiredInteger(body, "leadTimeHours"),
        averageWindowDays: requiredInteger(body, "averageWindowDays"),
        orderLimit: requiredInteger(body, "orderLimit"),
      }, context);
      return adminJson({ data });
    }
    if (operation === "create_draft") {
      const quantity = body.quantity == null ? null : requiredInteger(body, "quantity");
      const data = await createSuzDraft({
        tradeItemId: requiredString(body, "tradeItemId"),
        quantity,
      }, context);
      return adminJson({ data }, { status: 201 });
    }
    if (operation === "approve") {
      const data = await approveSuzDraft({
        orderId: requiredString(body, "orderId"),
        expectedRevision: requiredInteger(body, "expectedRevision"),
      }, context);
      return adminJson({ data }, { status: 202 });
    }
    if (operation === "cancel") {
      const data = await cancelSuzDraft({
        orderId: requiredString(body, "orderId"),
        expectedRevision: requiredInteger(body, "expectedRevision"),
        reason: requiredString(body, "reason"),
      }, context);
      return adminJson({ data });
    }
    if (operation === "poll") {
      const data = await requestSuzOrderPoll({
        orderId: requiredString(body, "orderId"),
      }, context);
      return adminJson({ data }, { status: 202 });
    }
    throw new AdminApiError(400, "bad_request", "Invalid SUZ operation");
  } catch (error) {
    return adminErrorResponse(markingMutationError(error));
  }
}
