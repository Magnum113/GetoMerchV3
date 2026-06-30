import { NextResponse } from "next/server";
import { komuiFetchRaw } from "@/lib/komui/server";

export const dynamic = "force-dynamic";

function validateOrderId(id: string): boolean {
  return /^[A-Za-z0-9._~-]+$/.test(id);
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await ctx.params;
  if (!validateOrderId(orderId)) {
    return NextResponse.json({ error: "orderId некорректен" }, { status: 400 });
  }
  let raw: { note?: unknown } = {};
  try {
    raw = (await req.json()) as { note?: unknown };
  } catch {
    raw = {};
  }
  const body: Record<string, unknown> = {};
  if (typeof raw.note === "string") body.note = raw.note;

  try {
    const { status, body: respBody, rawText } = await komuiFetchRaw({
      method: "POST",
      path: `/admin/storefront/orders/${encodeURIComponent(orderId)}/mark-shipped`,
      body,
    });
    if (respBody !== null) return NextResponse.json(respBody, { status });
    return NextResponse.json(
      { error: rawText || `KOMUI mark-shipped ${status}` },
      { status },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
