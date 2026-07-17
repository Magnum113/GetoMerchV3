import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson, parseLimitParam } from "@/lib/admin/http";
import { listJobs } from "@/lib/jobs/queue";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const limit = parseLimitParam(request.nextUrl.searchParams.get("limit"), {
      defaultValue: 50,
      max: 200,
    });
    return adminJson({ data: await listJobs(limit) });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
