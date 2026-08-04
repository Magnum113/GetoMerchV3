import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { AdminApiError, adminErrorResponse } from "@/lib/admin/http";
import { applyOzonImport } from "@/lib/ozon-import";
import { getDatabaseRuntimeConfig } from "@/lib/db/config";
import { enqueueOzonJob } from "@/lib/jobs/http";
import { parseOzonImportSelection } from "@/lib/ozon/import-selection";

export const dynamic = "force-dynamic";

type ApplyBody = {
  runId?: string;
  designOverrides?: Record<string, { name?: string; imageUrl?: string | null }>;
  selection?: unknown;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ApplyBody;
    if (!body.runId) {
      return NextResponse.json({ error: "runId обязателен" }, { status: 400 });
    }
    if (!isUuid(body.runId)) {
      throw new AdminApiError(400, "bad_request", "Invalid import run ID");
    }
    if (!isDesignOverrides(body.designOverrides)) {
      throw new AdminApiError(400, "bad_request", "Invalid design overrides");
    }
    let selection;
    try {
      selection = parseOzonImportSelection(body.selection);
    } catch (error) {
      throw new AdminApiError(
        400,
        "bad_request",
        error instanceof Error ? error.message : "Invalid Ozon import selection",
      );
    }

    if (getDatabaseRuntimeConfig().writeSource === "server") {
      const queued = await enqueueOzonJob(req, {
        type: "ozon_import_apply",
        dedupeKey: `import-apply:${body.runId}`,
        payload: {
          runId: body.runId,
          designOverrides: body.designOverrides ?? {},
          selection,
        },
        maxAttempts: 2,
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
    const result = await applyOzonImport(
      body.runId,
      body.designOverrides ?? {},
      selection,
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AdminApiError) return adminErrorResponse(error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isDesignOverrides(value: ApplyBody["designOverrides"]) {
  if (value == null) return true;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 500) return false;
  return Object.entries(value).every(([key, override]) => {
    if (key.length < 1 || key.length > 220 || !override || typeof override !== "object" || Array.isArray(override)) {
      return false;
    }
    const fields = Object.keys(override);
    if (fields.some((field) => field !== "name" && field !== "imageUrl")) return false;
    if (override.name != null && (typeof override.name !== "string" || override.name.length > 300)) return false;
    return override.imageUrl == null || (typeof override.imageUrl === "string" && override.imageUrl.length <= 2_000);
  });
}
