import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import {
  adminErrorResponse,
  adminJson,
  parseLimitParam,
  parseOffsetParam,
  requireUuidParam,
} from "@/lib/admin/http";
import { createDatabaseReadServices } from "@/lib/db/services/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const params = request.nextUrl.searchParams;
    const limit = parseLimitParam(params.get("limit"), { defaultValue: 200, max: 500 });
    const offset = parseOffsetParam(params.get("offset"));
    const categoryId = requireUuidParam(params.get("category_id"), "category_id");
    const page = await createDatabaseReadServices().expenses.list({
      limit,
      offset,
      from: params.get("from") || undefined,
      to: params.get("to") || undefined,
      categoryId,
    });
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
