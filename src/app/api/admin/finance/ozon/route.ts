import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson, parseLimitParam } from "@/lib/admin/http";
import { createDatabaseReadServices } from "@/lib/db/services/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const params = request.nextUrl.searchParams;
    const limit = parseLimitParam(params.get("limit"), { defaultValue: 500, max: 1000 });
    const data = await createDatabaseReadServices().finance.list({
      limit,
      from: params.get("from") || undefined,
      to: params.get("to") || undefined,
      postingNumber: params.get("posting_number") || undefined,
    });
    return adminJson({ data, meta: { limit } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
