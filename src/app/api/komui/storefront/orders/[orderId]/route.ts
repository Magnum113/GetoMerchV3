import { NextResponse } from "next/server";
import { komuiFetchRaw } from "@/lib/komui/server";

export const dynamic = "force-dynamic";

function validateOrderId(id: string): boolean {
  return /^[A-Za-z0-9._~-]+$/.test(id);
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await ctx.params;
  if (!validateOrderId(orderId)) {
    return NextResponse.json({ error: "orderId некорректен" }, { status: 400 });
  }
  try {
    const { status, body, rawText } = await komuiFetchRaw({
      method: "GET",
      path: `/admin/storefront/orders/${encodeURIComponent(orderId)}`,
    });
    if (body !== null) return NextResponse.json(body, { status });
    return NextResponse.json(
      { error: rawText || `KOMUI storefront order ${status}` },
      { status },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
