import { NextResponse } from "next/server";
import { AdminApiError, adminErrorResponse } from "@/lib/admin/http";
import { getDatabaseRuntimeConfig } from "@/lib/db/config";
import { enqueueOzonJob } from "@/lib/jobs/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const dryRun = parseBoolean(url.searchParams.get("dryRun"), "dryRun");
    const to = parseIsoDate(toParam, new Date(), "to");
    const from = parseIsoDate(fromParam, new Date(Date.now() - 365 * 86400 * 1000), "from");
    if (new Date(from) >= new Date(to)) {
      throw new AdminApiError(400, "bad_request", "from must be earlier than to");
    }

    if (getDatabaseRuntimeConfig().writeSource !== "server") {
      throw new AdminApiError(
        503,
        "server_config_error",
        "Finance sync requires the production server database",
      );
    }
    const queued = await enqueueOzonJob(req, {
      type: "ozon_finance_sync",
      dedupeKey: `finance:${from}:${to}:${dryRun ? "dry" : "apply"}`,
      payload: { from, to, dryRun },
      maxAttempts: 4,
    });
    return NextResponse.json({
      ok: true,
      queued: true,
      reused: queued.reused,
      jobId: queued.job.id,
      status: queued.job.status,
    }, { status: 202 });
  } catch (e) {
    if (e instanceof AdminApiError) return adminErrorResponse(e);
    console.error("[sync-finance]", e);
    const msg = formatError(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function parseIsoDate(value: string | null, fallback: Date, name: string) {
  const parsed = value ? new Date(value) : fallback;
  if (!Number.isFinite(parsed.getTime())) {
    throw new AdminApiError(400, "bad_request", `${name} must be a valid date`);
  }
  return parsed.toISOString();
}

function parseBoolean(value: string | null, name: string) {
  if (value == null || value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new AdminApiError(400, "bad_request", `${name} must be true or false`);
}

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const m = (typeof o.message === "string" && o.message)
      || (typeof o.details === "string" && o.details)
      || (typeof o.hint === "string" && o.hint)
      || (typeof o.error === "string" && o.error);
    if (m) return typeof o.code === "string" || typeof o.code === "number" ? `[${o.code}] ${m}` : m;
    try { return JSON.stringify(o); } catch { /* ignore */ }
  }
  return String(e);
}
