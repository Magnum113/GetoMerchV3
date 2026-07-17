import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson, parseLimitParam } from "@/lib/admin/http";
import { createDatabaseReadServices } from "@/lib/db/services/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const params = request.nextUrl.searchParams;
    const limit = parseLimitParam(params.get("limit"), { defaultValue: 50, max: 200 });
    const status = params.get("status")?.trim() || undefined;
    const source = params.get("source")?.trim() || undefined;
    const data = await createDatabaseReadServices().ozonOrders.list({ limit, status, source });
    return adminJson({ data, meta: { limit } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
