import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import {
  AdminApiError,
  adminErrorResponse,
  adminJson,
  parseLimitParam,
} from "@/lib/admin/http";
import { queryServerDatabase } from "@/lib/db/pool";
import { getMarkingRuntimeConfig } from "@/lib/marking/config";
import {
  markingMutationError,
  requireMarkingMutationContext,
  requireObjectBody,
  requiredBoolean,
  requiredInteger,
  requiredString,
} from "@/lib/marking/http";
import { listReturnCases } from "@/lib/marking/repositories/returns";
import {
  confirmFboReturnTransfer,
  receiveSellerReturn,
  requestOzonReturnsSync,
  requestReturnToCirculation,
  setReturnDirection,
} from "@/lib/marking/services/return-service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const [items, warehouses] = await Promise.all([
      listReturnCases(
        queryServerDatabase,
        parseLimitParam(request.nextUrl.searchParams.get("limit"), {
          defaultValue: 100,
          max: 200,
        }),
      ),
      queryServerDatabase<{ id: string; name: string }>(
        `SELECT id, name FROM public.merch_warehouses
         WHERE type = 'own' ORDER BY name COLLATE "C", id`,
      ),
    ]);
    const config = getMarkingRuntimeConfig();
    return adminJson({ data: {
      items,
      warehouses: warehouses.rows,
      runtime: {
        enabled: config.returnsEnabled,
        syncEnabled: config.ozonReturnsSyncEnabled,
      },
    } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const context = await requireMarkingMutationContext(request);
    const body = requireObjectBody(await request.json().catch(() => null));
    const operation = requiredString(body, "operation");
    if (operation === "sync") {
      return adminJson({ data: await requestOzonReturnsSync(context) }, { status: 202 });
    }
    const returnCaseId = requiredString(body, "returnCaseId");
    if (operation === "confirm_direction") {
      const destination = requiredString(body, "destination");
      if (destination !== "to_seller" && destination !== "to_ozon_fbo") {
        throw new AdminApiError(400, "bad_request", "Invalid return destination");
      }
      const data = await setReturnDirection({
        returnCaseId,
        expectedVersion: requiredInteger(body, "expectedVersion"),
        destination,
        paid: requiredBoolean(body, "paid"),
      }, context);
      return adminJson({ data });
    }
    if (operation === "prepare" || operation === "retry") {
      const data = await requestReturnToCirculation({
        returnCaseId,
        forceCorrection: operation === "retry",
      }, context);
      return adminJson({ data }, { status: data.job ? 202 : 200 });
    }
    if (operation === "receive_seller") {
      const condition = requiredString(body, "condition");
      if (!["intact", "relabel_same_code", "remark_required", "destroy_pending"].includes(condition)) {
        throw new AdminApiError(400, "bad_request", "Invalid return condition");
      }
      const data = await receiveSellerReturn({
        returnCaseId,
        expectedVersion: requiredInteger(body, "expectedVersion"),
        condition: condition as "intact" | "relabel_same_code" | "remark_required" | "destroy_pending",
        warehouseId: requiredString(body, "warehouseId"),
      }, context);
      return adminJson({ data });
    }
    if (operation === "confirm_fbo") {
      const data = await confirmFboReturnTransfer({
        returnCaseId,
        expectedVersion: requiredInteger(body, "expectedVersion"),
        fboIntakeReference: requiredString(body, "fboIntakeReference"),
        edoDocumentReference: requiredString(body, "edoDocumentReference"),
      }, context);
      return adminJson({ data });
    }
    throw new AdminApiError(400, "bad_request", "Invalid marking return operation");
  } catch (error) {
    return adminErrorResponse(markingMutationError(error));
  }
}
