import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const OZON_BASE = "https://api-seller.ozon.ru";
const OZON_TIMEOUT_MS = 15_000;
const SUPABASE_TIMEOUT_MS = 20_000;

async function ozonPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetchWithTimeout(
    `${OZON_BASE}${path}`,
    {
      method: "POST",
      headers: {
        "Client-Id": process.env.OZON_CLIEN_ID!,
        "Api-Key": process.env.OZON_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    },
    OZON_TIMEOUT_MS,
    `Ozon ${path}`,
  );
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
  created_at?: string;
  in_process_at?: string;
  shipment_date?: string;
  delivery_method?: { name?: string; warehouse?: string };
  analytics_data?: { warehouse_name?: string; city?: string; delivery_type?: string };
  customer?: { name?: string };
  products: OzonProduct[];
  source?: "fbs" | "fbo";
}

interface FbsListResponse {
  result?: { postings?: OzonPosting[]; has_next?: boolean };
}

interface FboListResponse {
  result?: OzonPosting[];
}

// Полная история FBS — /v3/posting/fbs/list. Тянет ВСЁ за период.
async function fetchAllFbsPostings(sinceDays: number): Promise<OzonPosting[]> {
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
    all.push(...items.map((p) => ({ ...p, source: "fbs" as const })));
    if (!r.result?.has_next || items.length < limit) break;
    offset += limit;
    if (offset > 10000) break;
  }
  return all;
}

// Полная история FBO — /v2/posting/fbo/list. Нужна для общей воронки заказов:
// финансы Ozon включают FBS + FBO, поэтому блок "Заказы и доставки" должен
// считать обе схемы.
async function fetchAllFboPostings(sinceDays: number): Promise<OzonPosting[]> {
  const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
  const to = new Date(Date.now() + 86400 * 1000).toISOString();
  const all: OzonPosting[] = [];
  let offset = 0;
  const limit = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r: FboListResponse = await ozonPost("/v2/posting/fbo/list", {
      dir: "DESC",
      filter: { since, to, status: "" },
      limit,
      offset,
      translit: false,
      with: { analytics_data: true, financial_data: false },
    });
    const items = r.result ?? [];
    all.push(...items.map((p) => ({ ...p, source: "fbo" as const })));
    if (items.length < limit) break;
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
    all.push(...items.map((p) => ({ ...p, source: "fbs" as const })));
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

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number, label: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function timeoutSignal(timeoutMs: number) {
  return AbortSignal.timeout(timeoutMs);
}

async function supabaseQuery<T>(
  label: string,
  query: { abortSignal(signal: AbortSignal): unknown },
  timeoutMs = SUPABASE_TIMEOUT_MS,
): Promise<T> {
  const { data, error } = await (query.abortSignal(timeoutSignal(timeoutMs)) as PromiseLike<{ data: unknown; error: unknown }>);
  if (error) throw toError(error, label);
  return data as T;
}

function toError(error: unknown, label: string) {
  if (error instanceof Error) return error;
  if (error && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    const message =
      (typeof rec.message === "string" && rec.message) ||
      (typeof rec.details === "string" && rec.details) ||
      (typeof rec.hint === "string" && rec.hint);
    if (message) {
      const code = typeof rec.code === "string" || typeof rec.code === "number" ? `[${rec.code}] ` : "";
      return new Error(`${label}: ${code}${message}`);
    }
  }
  return new Error(`${label}: ${String(error)}`);
}

export async function POST(req: Request) {
  try {
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
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
    const fetcher = scope === "all"
      ? Promise.all([fetchAllFbsPostings(days), fetchAllFboPostings(days)]).then(([fbs, fbo]) => [...fbs, ...fbo])
      : fetchUnfulfilledPostings();
    const [postings, products] = await Promise.all([
      fetcher,
      supabaseQuery<Array<{ id: string; sku: string | null }>>(
        "products select",
        supabase.from("merch_products").select("id, sku").not("sku", "is", null).limit(5000),
      ),
    ]);

    if (postings.length === 0) {
      return NextResponse.json({ ok: true, scope, fetched: 0, created: 0, updated: 0, unmatchedItems: 0, unmatchedSamples: [] });
    }

    // Карта offer_id → product_id. legacy_skus не читаем в sync route:
    // на production PostgREST выборка этой колонки может зависать и ломать синхронизацию заказов.
    const productByOffer = new Map<string, string>();
    for (const p of products ?? []) {
      if (p.sku) productByOffer.set(String(p.sku), p.id);
    }

    // 2) UPSERT заказов. Колонки, отсутствующие в payload (shipped_at,
    //    shipped_from_warehouse_id), при обновлении не трогаются.
    //    Из результата upsert берём id/shipped_at/created_at, чтобы не делать
    //    отдельный проблемный lookup по posting_number.
    //    Не пишем raw: на production некоторые Ozon JSON payload зависают на
    //    PostgREST/jsonb upsert, а обычному UI нужны нормализованные колонки.
    const now = new Date().toISOString();
    const orderPayloads = postings.map((p) => {
      const total = (p.products ?? []).reduce((s, it) => s + Number(it.price ?? 0) * (it.quantity ?? 0), 0);
      return {
        posting_number: p.posting_number,
        order_id: p.order_id ?? null,
        order_number: p.order_number ?? null,
        status: p.status,
        substatus: p.substatus ?? null,
        ozon_created_at: p.created_at ?? null,
        in_process_at: p.in_process_at ?? null,
        shipment_date: p.shipment_date ?? null,
        delivery_method: p.delivery_method?.name ?? p.analytics_data?.delivery_type ?? (p.source === "fbo" ? "FBO" : null),
        warehouse_name: p.analytics_data?.warehouse_name ?? p.delivery_method?.warehouse ?? null,
        customer_name: p.customer?.name ?? null,
        total_price: total || null,
        source: p.source ?? "fbs",
        synced_at: now,
      };
    });

    const idByPosting = new Map<string, string>();
    const stateByPosting = new Map<string, { shipped_at: string | null; created_at: string | null }>();
    for (const payload of orderPayloads) {
      const upserted = await supabaseQuery<Array<{ id: string; posting_number: string; shipped_at: string | null; created_at: string | null }>>(
        `orders upsert ${payload.posting_number}`,
        supabase
          .from("merch_ozon_orders")
          .upsert(payload, { onConflict: "posting_number" })
          .select("id, posting_number, shipped_at, created_at"),
        10_000,
      );
      for (const r of upserted ?? []) {
        idByPosting.set(r.posting_number, r.id);
        stateByPosting.set(r.posting_number, { shipped_at: r.shipped_at, created_at: r.created_at });
      }
    }

    // 3) Готовим позиции, но обновлять будем только у НЕотправленных заказов —
    //    чтобы не потерять shipped_from_warehouse_id на позициях отправленного.
    let unmatched = 0;
    const unmatchedOffers = new Set<string>();
    const refreshableOrderIds: string[] = [];
    const allItems: Array<Record<string, unknown>> = [];

    for (const p of postings) {
      const orderId = idByPosting.get(p.posting_number);
      if (!orderId) continue;
      const wasShipped = stateByPosting.get(p.posting_number)?.shipped_at != null;
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

    // 4) Удаляем и пересоздаём позиции для неотправленных заказов.
    if (refreshableOrderIds.length > 0) {
      for (const ch of chunk(refreshableOrderIds, 500)) {
        await supabaseQuery(
          "order items delete",
          supabase
            .from("merch_ozon_order_items")
            .delete()
            .in("order_id", ch),
          30_000,
        );
      }
    }
    if (allItems.length > 0) {
      for (const ch of chunk(allItems, 1000)) {
        await supabaseQuery(
          "order items insert",
          supabase.from("merch_ozon_order_items").insert(ch),
          30_000,
        );
      }
    }

    // 5) created / updated по created_at, который вернул upsert.
    let created = 0;
    for (const state of stateByPosting.values()) {
      if (state.created_at && state.created_at >= startedAtIso) created++;
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
      durationMs: Date.now() - startedAt,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[sync-orders]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
