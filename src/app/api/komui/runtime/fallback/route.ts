import { NextResponse } from "next/server";
import { komuiFetchRaw } from "@/lib/komui/server";

export const dynamic = "force-dynamic";

type FallbackBody = {
  mode?: string;
  confirm?: boolean;
  reason?: string;
};

export async function POST(req: Request) {
  try {
    let raw: FallbackBody = {};
    try {
      raw = (await req.json()) as FallbackBody;
    } catch {
      raw = {};
    }
    if (raw.mode !== "server" && raw.mode !== "legacy") {
      return NextResponse.json(
        { error: "mode должен быть 'server' или 'legacy'" },
        { status: 400 },
      );
    }
    if (raw.confirm !== true) {
      return NextResponse.json(
        { error: "confirm должен быть true" },
        { status: 400 },
      );
    }
    const body = {
      mode: raw.mode,
      confirm: true as const,
      reason:
        typeof raw.reason === "string" && raw.reason.trim()
          ? raw.reason.trim()
          : "manual owner action from admin panel",
    };

    const { status, body: respBody, rawText } = await komuiFetchRaw({
      method: "POST",
      path: "/admin/runtime/fallback",
      body,
    });
    if (respBody !== null) {
      return NextResponse.json(respBody, { status });
    }
    return NextResponse.json(
      { error: rawText || `KOMUI runtime fallback ${status}` },
      { status },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
