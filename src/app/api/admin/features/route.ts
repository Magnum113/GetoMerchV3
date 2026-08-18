import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { AdminApiError, adminErrorResponse, adminJson } from "@/lib/admin/http";
import { assertAdminWritesEnabled } from "@/lib/admin/maintenance";
import {
  listAdminFeatureFlags,
  updateAdminFeatureFlag,
} from "@/lib/admin/features";
import { isAdminFeatureKey } from "@/lib/admin/feature-types";
import { DatabaseBusinessError } from "@/lib/db/errors";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdminSession();
    return adminJson({ data: await listAdminFeatureFlags() });
  } catch (error) {
    return adminErrorResponse(toFeatureApiError(error));
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await requireAdminSession();
    assertAdminWritesEnabled();
    assertSameOrigin(request);
    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim() ?? "";
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
      throw new AdminApiError(400, "bad_request", "Missing or invalid idempotency key");
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AdminApiError(400, "bad_request", "JSON object body is required");
    }
    const input = body as Record<string, unknown>;
    if (!isAdminFeatureKey(input.key)
        || typeof input.enabled !== "boolean"
        || !Number.isSafeInteger(input.expectedRevision)
        || Number(input.expectedRevision) < 1) {
      throw new AdminApiError(400, "bad_request", "Invalid feature flag update");
    }
    const requestedId = request.headers.get("x-request-id")?.trim() ?? "";
    const data = await updateAdminFeatureFlag({
      key: input.key,
      enabled: input.enabled,
      expectedRevision: Number(input.expectedRevision),
    }, {
      actor: session.sub,
      sessionId: session.sessionId,
      requestId: isUuid(requestedId) ? requestedId : crypto.randomUUID(),
      idempotencyKey,
    });
    return adminJson({ data });
  } catch (error) {
    return adminErrorResponse(toFeatureApiError(error));
  }
}

function toFeatureApiError(error: unknown) {
  if (error instanceof AdminApiError) return error;
  if (error instanceof DatabaseBusinessError) {
    const code = error.status === 503
      ? "server_config_error"
      : error.status === 404
        ? "not_found"
        : error.status === 400
          ? "bad_request"
          : "conflict";
    return new AdminApiError(error.status, code, error.publicMessage, { cause: error });
  }
  return error;
}

function assertSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
    || request.headers.get("host")?.trim()
    || request.nextUrl.host;
  try {
    if (!origin || !host || new URL(origin).host !== host) {
      throw new AdminApiError(403, "unauthorized", "Origin check failed");
    }
  } catch (error) {
    if (error instanceof AdminApiError) throw error;
    throw new AdminApiError(403, "unauthorized", "Origin check failed");
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}
