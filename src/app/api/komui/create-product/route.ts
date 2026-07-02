import { NextResponse } from "next/server";
import { komuiFetchRaw } from "@/lib/komui/server";

export const dynamic = "force-dynamic";

// Разрешённые поля карточки — то, что описано в контракте
// /admin/ozon/products/storefront-products. Остальное отбрасываем, чтобы UI
// случайно не протащил лишнее.
const PRODUCT_KEYS = new Set([
  "name",
  "slug",
  "designKey",
  "ozonVariant",
  "salePrice",
  "regularPrice",
  "shortDescription",
  "description",
  "titleName",
  "titleSlug",
  "animeTitle",
  "animeSlug",
  "characterName",
  "characterSlug",
  "collectionName",
  "collectionSlug",
  "designName",
  "designSlug",
  "category",
  "categorySlug",
  "productType",
  "productTypeSlug",
  "decorationType",
  "decorationSlug",
  "colorName",
  "colorSlug",
  "colorHex",
  "sizes",
  "imageUrls",
  "tags",
  "badges",
  "isActive",
  "sortOrder",
]);

type CreateBody = {
  previewId?: string;
  offerItemIds?: string[];
  offerIds?: string[];
  product?: Record<string, unknown>;
};

function sanitizeIds(v: unknown, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && x.length <= maxLen)
    .slice(0, 500);
}

export async function POST(req: Request) {
  try {
    let raw: CreateBody = {};
    try {
      raw = (await req.json()) as CreateBody;
    } catch {
      return NextResponse.json({ error: "невалидный JSON" }, { status: 400 });
    }
    if (!raw.previewId || typeof raw.previewId !== "string") {
      return NextResponse.json({ error: "previewId обязателен" }, { status: 400 });
    }
    const offerItemIds = sanitizeIds(raw.offerItemIds, 64);
    const offerIds = sanitizeIds(raw.offerIds, 160);
    if (offerItemIds.length === 0 && offerIds.length === 0) {
      return NextResponse.json(
        { error: "нужен offerItemIds или offerIds" },
        { status: 400 },
      );
    }
    if (!raw.product || typeof raw.product !== "object") {
      return NextResponse.json({ error: "product обязателен" }, { status: 400 });
    }
    const product: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw.product)) {
      if (PRODUCT_KEYS.has(k) && v !== undefined) product[k] = v;
    }

    const body: Record<string, unknown> = {
      previewId: raw.previewId,
      product,
    };
    if (offerItemIds.length > 0) body.offerItemIds = offerItemIds;
    if (offerIds.length > 0) body.offerIds = offerIds;

    const { status, body: respBody, rawText } = await komuiFetchRaw({
      method: "POST",
      path: "/admin/ozon/products/storefront-products",
      body,
    });
    if (respBody !== null) return NextResponse.json(respBody, { status });
    return NextResponse.json(
      { error: rawText || `KOMUI storefront-products ${status}` },
      { status },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
