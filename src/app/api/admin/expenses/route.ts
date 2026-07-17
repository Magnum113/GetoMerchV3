import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import {
  adminErrorResponse,
  adminJson,
  parseLimitParam,
  requireUuidParam,
} from "@/lib/admin/http";
import { createDatabaseReadServices } from "@/lib/db/services/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const params = request.nextUrl.searchParams;
    const limit = parseLimitParam(params.get("limit"), { defaultValue: 500, max: 1000 });
    const categoryId = requireUuidParam(params.get("category_id"), "category_id");
    const data = await createDatabaseReadServices().expenses.list({
      limit,
      from: params.get("from") || undefined,
      to: params.get("to") || undefined,
      categoryId,
    });
    return adminJson({ data, meta: { limit } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
