import { NextResponse } from "next/server";
import { applyOzonImport } from "@/lib/ozon-import";

export const dynamic = "force-dynamic";

type ApplyBody = {
  runId?: string;
  designOverrides?: Record<string, { name?: string; imageUrl?: string | null }>;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ApplyBody;
    if (!body.runId) {
      return NextResponse.json({ error: "runId обязателен" }, { status: 400 });
    }
    const result = await applyOzonImport(body.runId, body.designOverrides ?? {});
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
