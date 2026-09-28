import { NextResponse } from "next/server";
import { komuiFetchRaw, komuiFetchLabel, KomuiApiError } from "@/lib/komui/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { AdminApiError } from "@/lib/admin/http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ orderId: string; action: string }> };
const actions = new Set(["approve", "sync", "retry", "cancel"]);
const validId = (value: string) => /^[A-Za-z0-9._~-]{1,100}$/.test(value);

export async function GET(request: Request, context: Context) {
  try {
    await requireAdminSession();
    const { orderId, action } = await context.params;
    if (!validId(orderId) || action !== "label") return NextResponse.json({ error: "Недопустимый запрос" }, { status: 400 });
    const shipmentId = new URL(request.url).searchParams.get("shipmentId");
    if (shipmentId && !validId(shipmentId)) return NextResponse.json({ error: "Неверное отправление" }, { status: 400 });
    const suffix = shipmentId ? `?shipmentId=${encodeURIComponent(shipmentId)}` : "";
    const bytes = await komuiFetchLabel(`/admin/storefront/orders/${encodeURIComponent(orderId)}/shipping/label${suffix}`);
    return new Response(Buffer.from(bytes), { headers: {
      "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="komui-ozon-${orderId}.pdf"`,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    if (error instanceof AdminApiError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error instanceof KomuiApiError ? error.message : "Не удалось получить этикетку" }, { status: error instanceof KomuiApiError ? error.status : 500 });
  }
}

export async function POST(request: Request, context: Context) {
  try {
    await requireAdminSession();
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== request.headers.get("host")) return NextResponse.json({ error: "Недопустимый источник запроса" }, { status: 403 });
    const { orderId, action } = await context.params;
    if (!validId(orderId) || !actions.has(action)) return NextResponse.json({ error: "Недопустимое действие" }, { status: 400 });
    const payload = await request.json().catch(() => null);
    if (!payload || typeof payload !== "object") return NextResponse.json({ error: "Неверный запрос" }, { status: 400 });
    if (payload.shipmentId != null && (typeof payload.shipmentId !== "string" || !validId(payload.shipmentId))) return NextResponse.json({ error: "Неверное отправление" }, { status: 400 });
    const result = await komuiFetchRaw({ method: "POST", path: `/admin/storefront/orders/${encodeURIComponent(orderId)}/shipping/${action}`, body: payload.shipmentId ? { shipmentId: payload.shipmentId } : {} });
    return NextResponse.json(result.body ?? { error: "Сервис доставки временно недоступен" }, { status: result.status, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AdminApiError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "Не удалось выполнить действие с доставкой" }, { status: 500 });
  }
}
