import { NextResponse } from "next/server";
import { komuiFetchRaw } from "@/lib/komui/server";

export const dynamic = "force-dynamic";

const ALLOWED_KEYS = new Set([
  "name",
  "description",
  "shortDescription",
  "salePrice",
  "regularPrice",
  "sizes",
  "imageUrls",
  "mainImagePath",
  "isActive",
  "sortOrder",
  "syncOfferPrices",
]);

function validateProductId(id: string): boolean {
  return /^[A-Za-z0-9._~-]+$/.test(id);
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ productId: string }> },
) {
  const { productId } = await ctx.params;
  if (!validateProductId(productId)) {
    return NextResponse.json({ error: "productId некорректен" }, { status: 400 });
  }
  try {
    const { status, body, rawText } = await komuiFetchRaw({
      method: "GET",
      path: `/admin/storefront/products/${encodeURIComponent(productId)}`,
    });
    if (body !== null) return NextResponse.json(body, { status });
    return NextResponse.json(
      { error: rawText || `KOMUI storefront product ${status}` },
      { status },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ productId: string }> },
) {
  const { productId } = await ctx.params;
  if (!validateProductId(productId)) {
    return NextResponse.json({ error: "productId некорректен" }, { status: 400 });
  }

  let raw: Record<string, unknown> = {};
  try {
    raw = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "невалидный JSON" }, { status: 400 });
  }

  // Чистим payload — пропускаем только разрешённые поля. Это защита от
  // случайных полей вроде `id`, `slug`, `updatedAt`, которые UI может
  // случайно отправить.
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (ALLOWED_KEYS.has(k)) body[k] = v;
  }
  if (Object.keys(body).length === 0) {
    return NextResponse.json({ error: "пустой patch" }, { status: 400 });
  }

  try {
    const { status, body: respBody, rawText } = await komuiFetchRaw({
      method: "PATCH",
      path: `/admin/storefront/products/${encodeURIComponent(productId)}`,
      body,
    });
    if (respBody !== null) return NextResponse.json(respBody, { status });
    return NextResponse.json(
      { error: rawText || `KOMUI storefront product PATCH ${status}` },
      { status },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
