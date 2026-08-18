import { NextRequest } from "next/server";
import { requireMarkingAdminSession } from "@/lib/marking/http";
import {
  AdminApiError,
  adminErrorResponse,
  adminJson,
  parseBooleanParam,
  parseLimitParam,
} from "@/lib/admin/http";
import {
  MARKING_PROFILE_CHANNELS,
  MARKING_VERIFICATION_STATUSES,
  type MarkingProfileChannel,
  type MarkingVerificationStatus,
} from "@/lib/marking/domain/states";
import { InvalidMarkingCursorError } from "@/lib/marking/read-models/cursor";
import { markingReadRepository } from "@/lib/marking/read-models/repository";
import type { MarkingReadinessStatus } from "@/lib/marking/read-models/types";

export const dynamic = "force-dynamic";

const READINESS_STATUSES = ["ready", "blocked", "not_required", "archived"] as const;

export async function GET(request: NextRequest) {
  try {
    await requireMarkingAdminSession();
    const params = request.nextUrl.searchParams;
    const page = await markingReadRepository.listReadiness({
      limit: parseLimitParam(params.get("limit"), { defaultValue: 50, max: 100 }),
      cursor: params.get("cursor"),
      readinessStatus: parseEnum(
        params.get("status"),
        READINESS_STATUSES,
        "status",
      ) as MarkingReadinessStatus | undefined,
      verificationStatus: parseEnum(
        params.get("verificationStatus"),
        MARKING_VERIFICATION_STATUSES,
        "verificationStatus",
      ) as MarkingVerificationStatus | undefined,
      requiresMarking: parseBooleanParam(
        params.get("requiresMarking"),
        "requiresMarking",
      ),
      search: parseSearch(params.get("search")),
      channel: parseEnum(
        params.get("channel"),
        MARKING_PROFILE_CHANNELS,
        "channel",
      ) as MarkingProfileChannel | undefined,
      conflictsOnly: parseBooleanParam(
        params.get("conflictsOnly"),
        "conflictsOnly",
      ),
    });
    return adminJson({ data: page.items, page: page.page });
  } catch (error) {
    return markingReadErrorResponse(error);
  }
}

function parseEnum(
  value: string | null,
  allowed: readonly string[],
  name: string,
) {
  if (!value) return undefined;
  if (!allowed.includes(value)) {
    throw new AdminApiError(400, "bad_request", `Invalid ${name} parameter`);
  }
  return value;
}

function parseSearch(value: string | null) {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > 200) {
    throw new AdminApiError(400, "bad_request", "Search is too long");
  }
  return normalized;
}

function markingReadErrorResponse(error: unknown) {
  return adminErrorResponse(
    error instanceof InvalidMarkingCursorError
      ? new AdminApiError(400, "bad_request", "Invalid cursor parameter")
      : error,
  );
}
