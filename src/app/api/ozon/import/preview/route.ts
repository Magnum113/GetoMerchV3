import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { AdminApiError, adminErrorResponse } from "@/lib/admin/http";
import { createOzonImportPreview } from "@/lib/ozon-import";
import { getDatabaseRuntimeConfig } from "@/lib/db/config";
import { enqueueOzonJob } from "@/lib/jobs/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    if (getDatabaseRuntimeConfig().writeSource === "server") {
      const queued = await enqueueOzonJob(request, {
        type: "ozon_import_preview",
        dedupeKey: "import-preview:ozon-products",
        payload: {},
        maxAttempts: 4,
      });
      return NextResponse.json({
        ok: true,
        queued: true,
        reused: queued.reused,
        jobId: queued.job.id,
        status: queued.job.status,
      }, { status: 202 });
    }

    await requireAdminSession();
    const preview = await createOzonImportPreview();
    return NextResponse.json(preview);
  } catch (error) {
    if (error instanceof AdminApiError) return adminErrorResponse(error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
