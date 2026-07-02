import { NextResponse } from "next/server";
import { komuiFetchRaw } from "@/lib/komui/server";

export const dynamic = "force-dynamic";

type LinkBody = {
  previewId?: string;
  productId?: string;
  offerIds?: string[];
  updatePrices?: boolean;
  syncSizes?: "add" | "off";
};

export async function POST(req: Request) {
  try {
    let raw: LinkBody = {};
    try {
      raw = (await req.json()) as LinkBody;
    } catch {
      return NextResponse.json({ error: "невалидный JSON" }, { status: 400 });
    }
    if (!raw.previewId || typeof raw.previewId !== "string") {
      return NextResponse.json({ error: "previewId обязателен" }, { status: 400 });
    }
    if (!raw.productId || typeof raw.productId !== "string") {
      return NextResponse.json({ error: "productId обязателен" }, { status: 400 });
    }
    const offerIds = Array.isArray(raw.offerIds)
      ? raw.offerIds
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim())
          .filter((x) => x.length > 0 && x.length <= 160)
          .slice(0, 500)
      : [];
    if (offerIds.length === 0) {
      return NextResponse.json(
        { error: "offerIds должен содержать хотя бы один оффер" },
        { status: 400 },
      );
    }

    const body = {
      previewId: raw.previewId,
      productId: raw.productId,
      offerIds,
      updatePrices: raw.updatePrices === true,
      syncSizes: raw.syncSizes === "off" ? ("off" as const) : ("add" as const),
    };

    const { status, body: respBody, rawText } = await komuiFetchRaw({
      method: "POST",
      path: "/admin/ozon/products/link-storefront-offers",
      body,
    });
    if (respBody !== null) return NextResponse.json(respBody, { status });
    return NextResponse.json(
      { error: rawText || `KOMUI link-storefront-offers ${status}` },
      { status },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
