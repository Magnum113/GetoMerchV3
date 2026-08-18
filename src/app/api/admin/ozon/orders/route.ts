import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson, parseLimitParam, parseOffsetParam } from "@/lib/admin/http";
import { createDatabaseReadServices } from "@/lib/db/services/runtime";
import { markingReadRepository } from "@/lib/marking/read-models/repository";
import { getMarkingRuntimeConfig } from "@/lib/marking/config";
import { isAdminFeatureEnabled } from "@/lib/admin/features";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const params = request.nextUrl.searchParams;
    const limit = parseLimitParam(params.get("limit"), { defaultValue: 200, max: 500 });
    const offset = parseOffsetParam(params.get("offset"));
    const status = params.get("status")?.trim() || undefined;
    const source = params.get("source")?.trim() || undefined;
    const page = await createDatabaseReadServices().ozonOrders.list({ limit, offset, status, source });
    const markingFeatureEnabled = await isAdminFeatureEnabled("chestny_znak");
    if (markingFeatureEnabled) {
      const fulfillmentItemIds = page.rows.flatMap((order) => (
        order.items?.flatMap((item) => item.fulfillment?.id ? [item.fulfillment.id] : [])
        ?? []
      ));
      if (fulfillmentItemIds.length > 0) {
        const [assignmentPage, candidates] = await Promise.all([
          markingReadRepository.listAssignments({
            limit: 5_000,
            status: "active",
            fulfillmentItemIds,
          }),
          markingReadRepository.listJitCandidates({
            limit: 2_000,
            fulfillmentItemIds,
          }),
        ]);
        const assignmentsByItem = groupByFulfillmentItem(assignmentPage.items);
        const candidatesByItem = groupByFulfillmentItem(candidates);
        for (const order of page.rows) {
          for (const item of order.items ?? []) {
            if (!item.fulfillment?.id) continue;
            item.marking = {
              assignments: assignmentsByItem.get(item.fulfillment.id) ?? [],
              candidates: candidatesByItem.get(item.fulfillment.id) ?? [],
            };
          }
        }
      }
      const markingConfig = getMarkingRuntimeConfig();
      if (markingConfig.enabled) {
        for (const order of page.rows) {
          const requiredItems = (order.items ?? []).filter((item) => (
            item.fulfillment?.marking_requirement ?? item.marking_requirement
          ) === "required");
          if (requiredItems.length === 0) continue;
          const requiredUnits = requiredItems.reduce((sum, item) => sum + item.quantity, 0);
          const assignments = requiredItems.flatMap((item) => item.marking?.assignments ?? []);
          const readyUnits = assignments.filter((assignment) => (
            assignment.assignmentStatus === "active" && assignment.shippingBlocker === ""
          )).length;
          const blockers = [...new Set([
            ...(readyUnits < requiredUnits ? ["Не всем единицам назначен готовый КМ"] : []),
            ...assignments.map((assignment) => assignment.shippingBlocker).filter(Boolean),
          ])];
          order.marking_shipping = {
            mode: markingConfig.shippingGateMode,
            allowed: blockers.length === 0,
            requiredUnits,
            readyUnits,
            blockers,
          };
        }
      }
    }
    return adminJson({
      data: page.rows,
      meta: {
        limit,
        offset,
        nextOffset: page.hasMore ? offset + limit : null,
        hasMore: page.hasMore,
      },
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

function groupByFulfillmentItem<T extends { fulfillmentItemId: string }>(
  rows: readonly T[],
) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const current = grouped.get(row.fulfillmentItemId) ?? [];
    current.push(row);
    grouped.set(row.fulfillmentItemId, current);
  }
  return grouped;
}
