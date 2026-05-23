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

async function fetchAllPostings(sinceDays: number): Promise<OzonPosting[]> {
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
  const to = new Date(Date.now() + 86400 * 1000).toISOString();
  const all: OzonPosting[] = [];
  let offset = 0;
  const limit = 100;
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
    if (offset > 5000) break;
  }
  return all;
}

export async function POST(req: Request) {
  try {
    if (!process.env.OZON_API_KEY || !process.env.OZON_CLIEN_ID) {
      return NextResponse.json({ error: "OZON_API_KEY / OZON_CLIEN_ID не настроены в .env.local" }, { status: 500 });
    }
    const url = new URL(req.url);
    const days = Math.min(180, Math.max(1, Number(url.searchParams.get("days") ?? 60)));

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );

    const [postings, { data: products }] = await Promise.all([
      fetchAllPostings(days),
      supabase.from("merch_products").select("id, sku, legacy_skus").not("sku", "is", null),
    ]);

    const productByOffer = new Map<string, string>();
    for (const p of (products ?? []) as { id: string; sku: string | null; legacy_skus: string[] | null }[]) {
      if (p.sku) productByOffer.set(String(p.sku), p.id);
      for (const ls of p.legacy_skus ?? []) productByOffer.set(String(ls), p.id);
    }

    let upserted = 0;
    let created = 0;
    let unmatched = 0;
    const unmatchedOffers = new Set<string>();

    for (const p of postings) {
      const total = (p.products ?? []).reduce(
        (s, it) => s + Number(it.price ?? 0) * (it.quantity ?? 0),
        0,
      );

      const { data: existing } = await supabase
        .from("merch_ozon_orders")
        .select("id, shipped_at")
        .eq("posting_number", p.posting_number)
        .maybeSingle();

      const payload = {
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
        synced_at: new Date().toISOString(),
      };

      let orderId: string;
      if (existing) {
        const { error: upErr } = await supabase
          .from("merch_ozon_orders")
          .update(payload)
          .eq("id", existing.id);
        if (upErr) throw upErr;
        orderId = existing.id;
        upserted++;
      } else {
        const { data: ins, error: insErr } = await supabase
          .from("merch_ozon_orders")
          .insert(payload)
          .select("id")
          .single();
        if (insErr) throw insErr;
        orderId = ins!.id;
        created++;
      }

      // Replace items
      await supabase.from("merch_ozon_order_items").delete().eq("order_id", orderId);
      const itemsPayload = (p.products ?? []).map((it) => {
        const productId = productByOffer.get(String(it.offer_id));
        if (!productId) {
          unmatched++;
          unmatchedOffers.add(String(it.offer_id));
        }
        return {
          order_id: orderId,
          offer_id: String(it.offer_id),
          ozon_sku: it.sku != null ? String(it.sku) : null,
          name: it.name ?? null,
          quantity: it.quantity ?? 0,
          price: it.price != null ? Number(it.price) : null,
          product_id: productId ?? null,
        };
      });
      if (itemsPayload.length > 0) {
        const { error: itemsErr } = await supabase.from("merch_ozon_order_items").insert(itemsPayload);
        if (itemsErr) throw itemsErr;
      }
    }

    return NextResponse.json({
      ok: true,
      fetched: postings.length,
      created,
      updated: upserted,
      unmatchedItems: unmatched,
      unmatchedSamples: Array.from(unmatchedOffers).slice(0, 10),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
