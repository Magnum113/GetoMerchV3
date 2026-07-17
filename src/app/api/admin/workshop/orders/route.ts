import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson, parseLimitParam } from "@/lib/admin/http";
import { createDatabaseReadServices } from "@/lib/db/services/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const limit = parseLimitParam(request.nextUrl.searchParams.get("limit"), {
      defaultValue: 100,
      max: 500,
    });
    const data = await createDatabaseReadServices().workshop.list(limit);
    return adminJson({ data, meta: { limit } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
