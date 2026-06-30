import { NextResponse } from "next/server";
import { komuiFetchRaw } from "@/lib/komui/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("q") ?? "";
    const active = url.searchParams.get("active") ?? "all";
    const limitRaw = Number(url.searchParams.get("limit") ?? 100);
    const offsetRaw = Number(url.searchParams.get("offset") ?? 0);
    const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 100));
    const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);

    const params = new URLSearchParams();
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    if (q) params.set("q", q);
    if (active) params.set("active", active);

    const { status, body, rawText } = await komuiFetchRaw({
      method: "GET",
      path: `/admin/storefront/products?${params.toString()}`,
    });
    if (body !== null) return NextResponse.json(body, { status });
    return NextResponse.json(
      { error: rawText || `KOMUI storefront products ${status}` },
      { status },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
