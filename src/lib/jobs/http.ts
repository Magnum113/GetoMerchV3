import "server-only";

import { requireAdminOrService } from "@/lib/admin/auth";
import { AdminApiError } from "@/lib/admin/http";
import { DatabaseBusinessError } from "@/lib/db/errors";
import { enqueueJob } from "@/lib/jobs/queue";
import type { JobType } from "@/lib/jobs/types";

export async function enqueueOzonJob(
  request: Request,
  input: {
    type: JobType;
    dedupeKey: string;
    payload?: Record<string, unknown>;
    maxAttempts?: number;
  },
) {
  const session = await requireAdminOrService(request);
  const idempotencyKey = request.headers.get("x-idempotency-key")?.trim() ?? "";
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new AdminApiError(400, "bad_request", "Missing or invalid idempotency key");
  }
  const requestedId = request.headers.get("x-request-id")?.trim() ?? "";
  const requestId = isUuid(requestedId) ? requestedId : crypto.randomUUID();

  try {
    return await enqueueJob({
      ...input,
      idempotencyKey,
      actor: session.sub,
      requestId,
    });
  } catch (error) {
    if (error instanceof DatabaseBusinessError) {
      throw new AdminApiError(
        error.status,
        error.status === 409 ? "conflict" : "bad_request",
        error.publicMessage,
        { cause: error },
      );
    }
    throw error;
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
