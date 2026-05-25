import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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

interface OzonProduct {
  offer_id: string;
  sku?: number | string;
  name?: string;
  quantity: number;
  price?: string | number;
}

interface OzonPosting {
  posting_number: string;
  order_id?: number;
  order_number?: string;
  status: string;
  substatus?: string;
  in_process_at?: string;
  shipment_date?: string;
  delivery_method?: { name?: string; warehouse?: string };
  analytics_data?: { warehouse_name?: string; city?: string };
  customer?: { name?: string };
  products: OzonProduct[];
}

interface FbsListResponse {
  result?: { postings?: OzonPosting[]; has_next?: boolean };
}

// Полная история — /v3/posting/fbs/list. Тянет ВСЁ за период.
async function fetchAllPostings(sinceDays: number): Promise<OzonPosting[]> {
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
  const to = new Date(Date.now() + 86400 * 1000).toISOString();
  const all: OzonPosting[] = [];
  let offset = 0;
  const limit = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r: FbsListResponse = await ozonPost("/v3/posting/fbs/list", {
      dir: "DESC",
      filter: { since, to },
      limit,
      offset,
      with: { analytics_data: true, financial_data: false },
    });
    const items = r.result?.postings ?? [];
    all.push(...items);
    if (!r.result?.has_next || items.length < limit) break;
    offset += limit;
    if (offset > 10000) break;
  }
  return all;
}

// Активные — /v3/posting/fbs/unfulfilled/list. Только то, что требует действий
// продавца (awaiting_packaging / awaiting_deliver и т.п.). Доставленные, отменённые,
// доставляющиеся пропускаем — для них статус в нашей БД не обновляем, экономя время.
async function fetchUnfulfilledPostings(): Promise<OzonPosting[]> {
  // cutoff — дедлайн упаковки/отгрузки. Берём широкое окно вокруг "сейчас"
  // (на случай просроченных и далёких будущих).
  const cutoffFrom = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
  const cutoffTo = new Date(Date.now() + 90 * 86400 * 1000).toISOString();
  const all: OzonPosting[] = [];
  let offset = 0;
  const limit = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await ozonPost<{ result?: { postings?: OzonPosting[]; count?: number } }>(
      "/v3/posting/fbs/unfulfilled/list",
      {
        dir: "ASC",
        filter: { cutoff_from: cutoffFrom, cutoff_to: cutoffTo },
        limit,
        offset,
        with: { analytics_data: true, financial_data: false },
      },
    );
    const items = r.result?.postings ?? [];
    all.push(...items);
    if (items.length < limit) break;
    offset += limit;
    if (offset > 10000) break;
  }
  return all;
}

// Делит массив на чанки по N (на случай очень большого аккаунта, чтобы не упереться в лимиты PostgREST)
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function POST(req: Request) {
  try {
    if (!process.env.OZON_API_KEY || !process.env.OZON_CLIEN_ID) {
      return NextResponse.json({ error: "OZON_API_KEY / OZON_CLIEN_ID не настроены в .env.local" }, { status: 500 });
    }
    const url = new URL(req.url);
    const scope = url.searchParams.get("scope") === "all" ? "all" : "active";
    const days = Math.min(180, Math.max(1, Number(url.searchParams.get("days") ?? 60)));

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );

    // 1) Параллельно тянем Ozon + каталог
    const fetcher = scope === "all" ? fetchAllPostings(days) : fetchUnfulfilledPostings();
    const [postings, { data: products }] = await Promise.all([
      fetcher,
      supabase.from("merch_products").select("id, sku, legacy_skus").not("sku", "is", null),
    ]);

    if (postings.length === 0) {
      return NextResponse.json({ ok: true, scope, fetched: 0, created: 0, updated: 0, unmatchedItems: 0, unmatchedSamples: [] });
    }

    // Карта offer_id → product_id (включает legacy_skus для переименованных в Ozon артикулов)
    const productByOffer = new Map<string, string>();
    for (const p of (products ?? []) as { id: string; sku: string | null; legacy_skus: string[] | null }[]) {
      if (p.sku) productByOffer.set(String(p.sku), p.id);
      for (const ls of p.legacy_skus ?? []) productByOffer.set(String(ls), p.id);
    }

    const postingNumbers = postings.map((p) => p.posting_number);

    // 2) Один SELECT: какие posting_number уже есть и какие из них отправлены.
    //    shipped_at нужен, чтобы НЕ затирать позиции отправленных заказов
    //    (там у позиций уже проставлен shipped_from_warehouse_id).
    const existingByPosting = new Map<string, { id: string; shipped_at: string | null }>();
    for (const ch of chunk(postingNumbers, 500)) {
      const { data: ex, error: exErr } = await supabase
        .from("merch_ozon_orders")
        .select("id, posting_number, shipped_at")
        .in("posting_number", ch);
      if (exErr) throw exErr;
      for (const r of ex ?? []) existingByPosting.set(r.posting_number, { id: r.id, shipped_at: r.shipped_at });
    }

    // 3) Один UPSERT всех заказов разом. Колонки, отсутствующие в payload (shipped_at,
    //    shipped_from_warehouse_id), при обновлении не трогаются.
    const now = new Date().toISOString();
    const orderPayloads = postings.map((p) => {
      const total = (p.products ?? []).reduce((s, it) => s + Number(it.price ?? 0) * (it.quantity ?? 0), 0);
      return {
        posting_number: p.posting_number,
        order_id: p.order_id ?? null,
        order_number: p.order_number ?? null,
        status: p.status,
        substatus: p.substatus ?? null,
        in_process_at: p.in_process_at ?? null,
        shipment_date: p.shipment_date ?? null,
        delivery_method: p.delivery_method?.name ?? null,
        warehouse_name: p.analytics_data?.warehouse_name ?? p.delivery_method?.warehouse ?? null,
        customer_name: p.customer?.name ?? null,
        total_price: total || null,
        raw: p as unknown as Record<string, unknown>,
        synced_at: now,
      };
    });

    const idByPosting = new Map<string, string>();
    for (const ch of chunk(orderPayloads, 500)) {
      const { data: upserted, error: upErr } = await supabase
        .from("merch_ozon_orders")
        .upsert(ch, { onConflict: "posting_number" })
        .select("id, posting_number");
      if (upErr) throw upErr;
      for (const r of upserted ?? []) idByPosting.set(r.posting_number, r.id);
    }

    // 4) Готовим позиции, но обновлять будем только у НЕотправленных заказов —
    //    чтобы не потерять shipped_from_warehouse_id на позициях отправленного.
    let unmatched = 0;
    const unmatchedOffers = new Set<string>();
    const refreshableOrderIds: string[] = [];
    const allItems: Array<Record<string, unknown>> = [];

    for (const p of postings) {
      const orderId = idByPosting.get(p.posting_number);
      if (!orderId) continue;
      const wasShipped = existingByPosting.get(p.posting_number)?.shipped_at != null;
      if (wasShipped) continue;

      refreshableOrderIds.push(orderId);
      for (const it of p.products ?? []) {
        const productId = productByOffer.get(String(it.offer_id));
        if (!productId) {
          unmatched++;
          unmatchedOffers.add(String(it.offer_id));
        }
        allItems.push({
          order_id: orderId,
          offer_id: String(it.offer_id),
          ozon_sku: it.sku != null ? String(it.sku) : null,
          name: it.name ?? null,
          quantity: it.quantity ?? 0,
          price: it.price != null ? Number(it.price) : null,
          product_id: productId ?? null,
        });
      }
    }

    // 5) Один DELETE и один INSERT для позиций
    if (refreshableOrderIds.length > 0) {
      for (const ch of chunk(refreshableOrderIds, 500)) {
        const { error: delErr } = await supabase
          .from("merch_ozon_order_items")
          .delete()
          .in("order_id", ch);
        if (delErr) throw delErr;
      }
    }
    if (allItems.length > 0) {
      for (const ch of chunk(allItems, 1000)) {
        const { error: insErr } = await supabase.from("merch_ozon_order_items").insert(ch);
        if (insErr) throw insErr;
      }
    }

    // 6) created / updated на основе того, что было до апсерта
    let created = 0;
    for (const pn of idByPosting.keys()) {
      if (!existingByPosting.has(pn)) created++;
    }
    const updated = idByPosting.size - created;

    return NextResponse.json({
      ok: true,
      scope,
      fetched: postings.length,
      created,
      updated,
      unmatchedItems: unmatched,
      unmatchedSamples: Array.from(unmatchedOffers).slice(0, 10),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
