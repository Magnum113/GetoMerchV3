import { NextResponse } from "next/server";
import { komuiFetchRaw } from "@/lib/komui/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const params = new URLSearchParams();

    const limitRaw = Number(url.searchParams.get("limit") ?? 50);
    const offsetRaw = Number(url.searchParams.get("offset") ?? 0);
    const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 50));
    const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);
    params.set("limit", String(limit));
    params.set("offset", String(offset));

    const passthrough = [
      "q",
      "paymentStatus",
      "status",
      "fulfillmentStatus",
      "dateFrom",
      "dateTo",
    ];
    for (const k of passthrough) {
      const v = url.searchParams.get(k);
      if (v) params.set(k, v);
    }

    const { status, body, rawText } = await komuiFetchRaw({
      method: "GET",
      path: `/admin/storefront/orders?${params.toString()}`,
    });
    if (body !== null) return NextResponse.json(body, { status });
    return NextResponse.json(
      { error: rawText || `KOMUI storefront orders ${status}` },
      { status },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
