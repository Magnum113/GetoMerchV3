import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { AdminApiError, adminErrorResponse, adminJson } from "@/lib/admin/http";
import { cancelJob, getJob } from "@/lib/jobs/queue";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    await requireAdminSession();
    const { jobId } = await context.params;
    assertUuid(jobId);
    const job = await getJob(jobId);
    if (!job) throw new AdminApiError(404, "not_found", "Задание не найдено");
    return adminJson({ data: job });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const session = await requireAdminSession();
    const { jobId } = await context.params;
    assertUuid(jobId);
    const job = await cancelJob(jobId, session.sub);
    if (!job) throw new AdminApiError(404, "not_found", "Задание не найдено");
    return adminJson({ data: job });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

function assertUuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AdminApiError(400, "bad_request", "Invalid job ID");
  }
}
