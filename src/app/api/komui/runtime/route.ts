import { NextResponse } from "next/server";
import { komuiFetchRaw } from "@/lib/komui/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { status, body, rawText } = await komuiFetchRaw({
      method: "GET",
      path: "/admin/runtime",
    });
    if (status >= 200 && status < 300 && body !== null) {
      return NextResponse.json(body, { status });
    }
    if (body !== null) {
      return NextResponse.json(body, { status });
    }
    return NextResponse.json(
      { error: rawText || `KOMUI runtime ${status}` },
      { status },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
