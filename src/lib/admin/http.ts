import "server-only";

import { NextResponse } from "next/server";
import { safeErrorForLog } from "@/lib/marking/security/redaction";

export type AdminApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "maintenance"
  | "method_not_allowed"
  | "supabase_query_failed"
  | "server_config_error"
  | "upstream_error"
  | "internal_error";

export class AdminApiError extends Error {
  readonly status: number;
  readonly code: AdminApiErrorCode;
  readonly publicMessage: string;

  constructor(
    status: number,
    code: AdminApiErrorCode,
    publicMessage: string,
    options?: ErrorOptions,
  ) {
    super(publicMessage, options);
    this.name = "AdminApiError";
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

export function adminJson<T>(payload: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, ...payload }, init);
}

export function adminErrorResponse(error: unknown) {
  if (error instanceof AdminApiError) {
    return NextResponse.json(
      { ok: false, error: { code: error.code, message: error.publicMessage } },
      { status: error.status },
    );
  }

  console.error("[admin-api] unexpected error", safeErrorForLog(error));
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "internal_error",
        message: "Internal server error",
      },
    },
    { status: 500 },
  );
}

export function assertNoSupabaseError(error: unknown, message = "Supabase query failed") {
  if (!error) return;
  console.error("[admin-api] supabase query failed", safeErrorForLog(error));
  throw new AdminApiError(500, "supabase_query_failed", message);
}

export function parseLimitParam(
  value: string | null,
  options: { defaultValue: number; max: number },
) {
  if (!value) return options.defaultValue;
  if (!/^\d+$/.test(value)) {
    throw new AdminApiError(400, "bad_request", "Invalid limit parameter");
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > options.max) {
    throw new AdminApiError(
      400,
      "bad_request",
      `Limit must be between 1 and ${options.max}`,
    );
  }

  return parsed;
}

export function parseOffsetParam(value: string | null) {
  if (!value) return 0;
  if (!/^\d+$/.test(value)) {
    throw new AdminApiError(400, "bad_request", "Invalid offset parameter");
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AdminApiError(400, "bad_request", "Invalid offset parameter");
  }

  return parsed;
}

export function parseBooleanParam(value: string | null, name: string) {
  if (value == null || value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new AdminApiError(400, "bad_request", `Invalid ${name} parameter`);
}

export function requireUuidParam(value: string | null, name: string) {
  if (!value) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AdminApiError(400, "bad_request", `Invalid ${name} parameter`);
  }
  return value;
}
