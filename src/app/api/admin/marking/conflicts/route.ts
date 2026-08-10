import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import {
  AdminApiError,
  adminErrorResponse,
  adminJson,
  parseLimitParam,
} from "@/lib/admin/http";
import { markingReadRepository } from "@/lib/marking/read-models/repository";
import type { MarkingConflictItem } from "@/lib/marking/read-models/types";

export const dynamic = "force-dynamic";

const SEVERITIES = ["warning", "blocking"] as const;
const CONFLICT_TYPES = [
  "catalog_attribute_mismatch",
  "sku_multiple_gtin",
  "shared_gtin_incompatible_attributes",
  "ozon_requirement_mismatch",
  "document_reference_warning",
] as const;

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const params = request.nextUrl.searchParams;
    const data = await markingReadRepository.listConflicts({
      limit: parseLimitParam(params.get("limit"), { defaultValue: 100, max: 500 }),
      severity: parseEnum(
        params.get("severity"),
        SEVERITIES,
        "severity",
      ) as MarkingConflictItem["severity"] | undefined,
      conflictType: parseEnum(
        params.get("type"),
        CONFLICT_TYPES,
        "type",
      ) as MarkingConflictItem["conflictType"] | undefined,
    });
    return adminJson({ data });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

function parseEnum(value: string | null, allowed: readonly string[], name: string) {
  if (!value) return undefined;
  if (!allowed.includes(value)) {
    throw new AdminApiError(400, "bad_request", `Invalid ${name} parameter`);
  }
  return value;
}
