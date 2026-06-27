import { NextResponse } from "next/server";
import { komuiFetch, KomuiApiError } from "@/lib/komui/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await ctx.params;
  if (!jobId || !/^[\w-]+$/.test(jobId)) {
    return NextResponse.json({ error: "jobId некорректен" }, { status: 400 });
  }
  try {
    const data = await komuiFetch({
      method: "GET",
      path: `/admin/ozon/jobs/${encodeURIComponent(jobId)}`,
    });
    return NextResponse.json(data);
  } catch (e) {
    const status = e instanceof KomuiApiError ? e.status : 500;
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status });
  }
}
