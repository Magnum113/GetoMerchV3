import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import {
  AdminApiError,
  adminErrorResponse,
  adminJson,
  parseBooleanParam,
  parseLimitParam,
  requireUuidParam,
} from "@/lib/admin/http";
import { createDatabaseReadServices } from "@/lib/db/services/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const params = request.nextUrl.searchParams;
    const limit = parseLimitParam(params.get("limit"), { defaultValue: 50, max: 500 });
    const offset = parseProductCursor(params.get("cursor") ?? params.get("offset"));
    const isBlank = parseBooleanParam(params.get("is_blank"), "is_blank");
    const designId = requireUuidParam(params.get("design_id"), "design_id");
    const search = (params.get("search") ?? params.get("sku") ?? "").trim();

    const services = createDatabaseReadServices();
    const page = await services.products.listPage({
      limit,
      offset,
      isBlank,
      designId,
      search: search || undefined,
    });
    return adminJson({
      data: page.rows,
      meta: {
        limit,
        offset,
        nextCursor: page.hasMore ? encodeProductCursor(offset + limit) : null,
        hasMore: page.hasMore,
      },
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

function parseProductCursor(value: string | null) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }

  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { offset?: unknown };
    const offset = decoded.offset;
    if (typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0) return offset;
  } catch {
    // handled below
  }

  throw new AdminApiError(400, "bad_request", "Invalid cursor parameter");
}

function encodeProductCursor(offset: number) {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}
