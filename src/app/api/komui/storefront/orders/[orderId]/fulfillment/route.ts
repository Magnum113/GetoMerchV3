import { NextResponse } from "next/server";
import { komuiFetchRaw } from "@/lib/komui/server";

export const dynamic = "force-dynamic";

const ALLOWED_STATUSES = new Set([
  "new",
  "processing",
  "shipped",
  "delivered",
  "canceled",
  "returned",
]);

function validateOrderId(id: string): boolean {
  return /^[A-Za-z0-9._~-]+$/.test(id);
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await ctx.params;
  if (!validateOrderId(orderId)) {
    return NextResponse.json({ error: "orderId некорректен" }, { status: 400 });
  }
  let raw: { status?: unknown; note?: unknown } = {};
  try {
    raw = (await req.json()) as { status?: unknown; note?: unknown };
  } catch {
    return NextResponse.json({ error: "невалидный JSON" }, { status: 400 });
  }
  if (typeof raw.status !== "string" || !ALLOWED_STATUSES.has(raw.status)) {
    return NextResponse.json(
      { error: "status должен быть одним из new/processing/shipped/delivered/canceled/returned" },
      { status: 400 },
    );
  }
  const body: Record<string, unknown> = { status: raw.status };
  if (typeof raw.note === "string") body.note = raw.note;

  try {
    const { status, body: respBody, rawText } = await komuiFetchRaw({
      method: "PATCH",
      path: `/admin/storefront/orders/${encodeURIComponent(orderId)}/fulfillment`,
      body,
    });
    if (respBody !== null) return NextResponse.json(respBody, { status });
    return NextResponse.json(
      { error: rawText || `KOMUI fulfillment ${status}` },
      { status },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
