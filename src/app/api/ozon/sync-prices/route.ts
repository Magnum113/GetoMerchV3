import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { AdminApiError, adminErrorResponse } from "@/lib/admin/http";
import { getAdminSupabaseClient } from "@/lib/supabase/server";
import { getDatabaseRuntimeConfig } from "@/lib/db/config";
import { enqueueOzonJob } from "@/lib/jobs/http";

// Server-side route — keeps OZON keys hidden from the browser

export const dynamic = "force-dynamic";

const OZON_BASE = "https://api-seller.ozon.ru";

async function ozonPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${OZON_BASE}${path}`, {
    method: "POST",
    headers: {
      "Client-Id": process.env.OZON_CLIEN_ID!,
      "Api-Key": process.env.OZON_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Ozon ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

interface OzonPriceItem {
  offer_id: string;
  price: {
    marketing_seller_price?: number | string;
    price?: number | string;
    old_price?: number | string;
    min_price?: number | string;
  };
}

async function fetchAllOzonPrices(): Promise<Record<string, OzonPriceItem["price"]>> {
  const map: Record<string, OzonPriceItem["price"]> = {};
  let cursor = "";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r: { items?: OzonPriceItem[]; cursor?: string } = await ozonPost("/v5/product/info/prices", {
      filter: { visibility: "ALL" },
      cursor,
      limit: 1000,
    });
    for (const it of r.items ?? []) map[it.offer_id] = it.price;
    if (!r.cursor || (r.items?.length ?? 0) < 1000) break;
    cursor = r.cursor;
  }
  return map;
}

export async function POST(request: Request) {
  try {
    if (getDatabaseRuntimeConfig().writeSource === "server") {
      const dryRun = parseBoolean(new URL(request.url).searchParams.get("dryRun"));
      const queued = await enqueueOzonJob(request, {
        type: "ozon_prices_sync",
        dedupeKey: `prices:${dryRun ? "dry" : "apply"}`,
        payload: { dryRun },
        maxAttempts: 4,
      });
      return NextResponse.json({
        ok: true,
        queued: true,
        reused: queued.reused,
        jobId: queued.job.id,
        status: queued.job.status,
      }, { status: 202 });
    }

    await requireAdminSession();
    if (!process.env.OZON_API_KEY || !process.env.OZON_CLIEN_ID) {
      return NextResponse.json({ error: "OZON_API_KEY / OZON_CLIEN_ID не настроены в .env.local" }, { status: 500 });
    }

    const supabase = getAdminSupabaseClient();

    const [{ data: products, error }, priceMap] = await Promise.all([
      supabase.from("merch_products").select("id, sku, legacy_skus, sale_price").not("sku", "is", null),
      fetchAllOzonPrices(),
    ]);
    if (error) throw error;

    let updated = 0;
    let unchanged = 0;
    let notFound = 0;
    const notFoundList: string[] = [];

    for (const p of products ?? []) {
      if (!p.sku) continue;
      // Цену ищем по текущему offer_id (sku) И по legacy_skus — это держит
      // синхронизацию цен живой в окне переименования: пока Ozon отдаёт старый
      // offer_id, а в БД уже стоит новый артикул (или наоборот).
      const candidates = [p.sku, ...((p.legacy_skus as string[] | null) ?? [])];
      let price: OzonPriceItem["price"] | undefined;
      for (const c of candidates) {
        if (priceMap[c]) { price = priceMap[c]; break; }
      }
      if (!price) {
        notFound++;
        if (notFoundList.length < 10) notFoundList.push(p.sku);
        continue;
      }
      const sale = Number(price.marketing_seller_price || price.price || 0);
      if (!sale) { notFound++; continue; }
      if (Number(p.sale_price) === sale) { unchanged++; continue; }
      const { error: upErr } = await supabase.from("merch_products").update({ sale_price: sale }).eq("id", p.id);
      if (upErr) throw upErr;
      updated++;
    }

    return NextResponse.json({
      ok: true,
      total: products?.length ?? 0,
      updated,
      unchanged,
      notFound,
      notFoundSamples: notFoundList,
    });
  } catch (e) {
    if (e instanceof AdminApiError) return adminErrorResponse(e);
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function parseBoolean(value: string | null) {
  if (value == null || value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new AdminApiError(400, "bad_request", "dryRun must be true or false");
}
