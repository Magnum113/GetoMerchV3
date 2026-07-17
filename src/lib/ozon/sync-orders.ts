import "server-only";

import { createHash } from "node:crypto";
import { queryServerDatabase } from "@/lib/db/pool";
import { syncOzonOrderSnapshot, type OzonOrderSnapshot } from "@/lib/db/mutations/sync-import";
import type { JobExecutionContext } from "@/lib/jobs/execution";
import { ozonPost } from "@/lib/ozon/client";

const PAGE_SIZE = 1000;
const MAX_PAGES_GUARD = 10_000;
const STALE_REFRESH_CONCURRENCY = 4;
const APPLY_CONCURRENCY = 4;
const TERMINAL_FBS_STATUSES = [
  "delivering",
  "delivered",
  "driver_pickup",
  "sent_by_seller",
  "arbitration",
  "client_arbitration",
  "not_accepted",
  "cancelled",
];

type OzonProduct = {
  offer_id: string;
  sku?: number | string;
  name?: string;
  quantity: number;
  price?: string | number;
};

type OzonPosting = {
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
  products?: OzonProduct[];
  source: "fbs" | "fbo";
};

export type OrdersSyncPayload = {
  scope?: "active" | "all";
  days?: number;
  dryRun?: boolean;
};

export async function executeOrdersSync(context: JobExecutionContext) {
  const payload = context.job.payload as OrdersSyncPayload;
  const scope = payload.scope === "all" ? "all" : "active";
  const days = clampInteger(payload.days ?? 60, 1, 180);
  const dryRun = payload.dryRun === true;
  const startedAt = Date.now();

  await context.report({ phase: "fetch", scope, days, fetched: 0 }, "fetch_started");
  const postings = scope === "all"
    ? mergePostings([
        ...(await fetchAllFbs(days, context)),
        ...(await fetchAllFbo(days, context)),
      ])
    : await fetchActiveWithStaleRefresh(context);

  await context.report({ phase: "match", scope, days, fetched: postings.length }, "fetch_completed");
  const productByOffer = await fetchProductsByOffer(collectOfferIds(postings));
  const snapshots = postings.map((posting) => toSnapshot(posting, productByOffer));
  const unmatchedOffers = new Set<string>();
  let unmatchedItems = 0;
  for (const snapshot of snapshots) {
    for (const item of snapshot.items) {
      if (item.productId) continue;
      unmatchedItems += 1;
      unmatchedOffers.add(item.offerId);
    }
  }

  if (dryRun) {
    return {
      scope,
      dryRun: true,
      fetched: postings.length,
      created: 0,
      updated: 0,
      unmatchedItems,
      unmatchedSamples: Array.from(unmatchedOffers).slice(0, 10),
      durationMs: Date.now() - startedAt,
    };
  }

  let processed = 0;
  let created = 0;
  let updated = 0;
  await mapLimit(snapshots, APPLY_CONCURRENCY, async (snapshot) => {
    assertNotCancelled(context.signal);
    const result = await syncOzonOrderSnapshot(
      {
        actor: context.job.actor,
        sessionId: `job:${context.job.id}`,
        requestId: context.job.requestId,
        idempotencyKey: orderIdempotencyKey(context.job.id, snapshot),
      },
      snapshot,
    );
    if (result.created) created += 1;
    else updated += 1;
    processed += 1;
    if (processed === snapshots.length || processed % 25 === 0) {
      await context.report({
        phase: "apply",
        scope,
        fetched: snapshots.length,
        processed,
        created,
        updated,
        unmatchedItems,
      });
    }
  });

  return {
    scope,
    dryRun: false,
    fetched: postings.length,
    created,
    updated,
    unmatchedItems,
    unmatchedSamples: Array.from(unmatchedOffers).slice(0, 10),
    failedOrders: 0,
    failedOrderSamples: [],
    failedItemOrders: 0,
    durationMs: Date.now() - startedAt,
  };
}

async function fetchAllFbs(days: number, context: JobExecutionContext) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const to = new Date(Date.now() + 86_400_000).toISOString();
  const all: OzonPosting[] = [];
  let offset = 0;
  for (let page = 1; page <= MAX_PAGES_GUARD; page += 1) {
    assertNotCancelled(context.signal);
    const response = await ozonPost<{
      result?: { postings?: Omit<OzonPosting, "source">[]; has_next?: boolean };
    }>("/v3/posting/fbs/list", {
      dir: "DESC",
      filter: { since, to },
      limit: PAGE_SIZE,
      offset,
      with: { analytics_data: true, financial_data: false },
    }, ozonOptions(context));
    const items = response.result?.postings ?? [];
    all.push(...items.map((item) => ({ ...item, source: "fbs" as const })));
    await context.report({ phase: "fetch_fbs", page, fetched: all.length });
    if (!response.result?.has_next) return all;
    if (items.length === 0) throw new Error("FBS pagination reported has_next without rows");
    offset += items.length;
  }
  throw new Error("FBS pagination exceeded safety guard");
}

async function fetchAllFbo(days: number, context: JobExecutionContext) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const to = new Date(Date.now() + 86_400_000).toISOString();
  const all: OzonPosting[] = [];
  let offset = 0;
  for (let page = 1; page <= MAX_PAGES_GUARD; page += 1) {
    assertNotCancelled(context.signal);
    const response = await ozonPost<{ result?: Omit<OzonPosting, "source">[] }>(
      "/v2/posting/fbo/list",
      {
        dir: "DESC",
        filter: { since, to, status: "" },
        limit: PAGE_SIZE,
        offset,
        translit: false,
        with: { analytics_data: true, financial_data: false },
      },
      ozonOptions(context),
    );
    const items = response.result ?? [];
    all.push(...items.map((item) => ({ ...item, source: "fbo" as const })));
    await context.report({ phase: "fetch_fbo", page, fetched: all.length });
    if (items.length < PAGE_SIZE) return all;
    offset += items.length;
  }
  throw new Error("FBO pagination exceeded safety guard");
}

async function fetchUnfulfilled(context: JobExecutionContext) {
  const cutoffFrom = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const cutoffTo = new Date(Date.now() + 90 * 86_400_000).toISOString();
  const all: OzonPosting[] = [];
  let offset = 0;
  for (let page = 1; page <= MAX_PAGES_GUARD; page += 1) {
    assertNotCancelled(context.signal);
    const response = await ozonPost<{
      result?: { postings?: Omit<OzonPosting, "source">[] };
    }>("/v3/posting/fbs/unfulfilled/list", {
      dir: "ASC",
      filter: { cutoff_from: cutoffFrom, cutoff_to: cutoffTo },
      limit: PAGE_SIZE,
      offset,
      with: { analytics_data: true, financial_data: false },
    }, ozonOptions(context));
    const items = response.result?.postings ?? [];
    all.push(...items.map((item) => ({ ...item, source: "fbs" as const })));
    await context.report({ phase: "fetch_active", page, fetched: all.length });
    if (items.length < PAGE_SIZE) return all;
    offset += items.length;
  }
  throw new Error("Active FBS pagination exceeded safety guard");
}

async function fetchActiveWithStaleRefresh(context: JobExecutionContext) {
  const active = await fetchUnfulfilled(context);
  const activeNumbers = new Set(active.map((posting) => posting.posting_number));
  const stale = await queryServerDatabase<{ posting_number: string }>(
    `
      SELECT posting_number
      FROM merch_ozon_orders
      WHERE source = 'fbs'
        AND shipped_at IS NULL
        AND NOT (status = ANY ($1::text[]))
      ORDER BY posting_number COLLATE "C"
    `,
    [TERMINAL_FBS_STATUSES],
  );
  const missing = stale.rows
    .map((row) => row.posting_number)
    .filter((postingNumber) => !activeNumbers.has(postingNumber));
  if (missing.length === 0) return active;

  let refreshedCount = 0;
  const refreshed = await mapLimit(missing, STALE_REFRESH_CONCURRENCY, async (postingNumber) => {
    assertNotCancelled(context.signal);
    const response = await ozonPost<{ result?: Omit<OzonPosting, "source"> }>(
      "/v3/posting/fbs/get",
      { posting_number: postingNumber, with: { analytics_data: true, financial_data: false } },
      ozonOptions(context),
    );
    refreshedCount += 1;
    if (refreshedCount % 25 === 0 || refreshedCount === missing.length) {
      await context.report({
        phase: "refresh_stale",
        staleTotal: missing.length,
        staleRefreshed: refreshedCount,
      });
    }
    return response.result ? { ...response.result, source: "fbs" as const } : null;
  });
  const refreshedPostings: OzonPosting[] = [];
  for (const item of refreshed) if (item) refreshedPostings.push(item);
  return mergePostings([...active, ...refreshedPostings]);
}

async function fetchProductsByOffer(offerIds: string[]) {
  const map = new Map<string, string>();
  for (const offers of chunk(offerIds, 500)) {
    const rows = await queryServerDatabase<{ id: string; sku: string }>(
      "SELECT id, sku FROM merch_products WHERE sku = ANY ($1::text[])",
      [offers],
    );
    for (const row of rows.rows) map.set(row.sku, row.id);
  }
  return map;
}

function toSnapshot(posting: OzonPosting, productByOffer: Map<string, string>): OzonOrderSnapshot {
  const products = posting.products ?? [];
  const total = products.reduce(
    (sum, item) => sum + Number(item.price ?? 0) * Number(item.quantity ?? 0),
    0,
  );
  return {
    postingNumber: posting.posting_number,
    orderId: posting.order_id ?? null,
    orderNumber: posting.order_number ?? null,
    status: posting.status,
    substatus: posting.substatus ?? null,
    ozonCreatedAt: posting.created_at ?? null,
    inProcessAt: posting.in_process_at ?? null,
    shipmentDate: posting.shipment_date ?? null,
    deliveryMethod: posting.delivery_method?.name
      ?? posting.analytics_data?.delivery_type
      ?? (posting.source === "fbo" ? "FBO" : null),
    warehouseName: posting.analytics_data?.warehouse_name ?? posting.delivery_method?.warehouse ?? null,
    customerName: posting.customer?.name ?? null,
    totalPrice: total || null,
    source: posting.source,
    syncedAt: new Date().toISOString(),
    replaceItems: true,
    items: products.map((item) => ({
      offerId: String(item.offer_id),
      ozonSku: item.sku == null ? null : String(item.sku),
      name: item.name ?? null,
      quantity: Number(item.quantity ?? 0),
      price: item.price == null ? null : Number(item.price),
      productId: productByOffer.get(String(item.offer_id)) ?? null,
    })),
  };
}

function orderIdempotencyKey(jobId: string, snapshot: OzonOrderSnapshot) {
  const hash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 16);
  return `${jobId}:order:${snapshot.postingNumber}:${hash}`.slice(0, 200);
}

function collectOfferIds(postings: OzonPosting[]) {
  return Array.from(new Set(
    postings.flatMap((posting) => (posting.products ?? []).map((product) => String(product.offer_id))),
  ));
}

function mergePostings(postings: OzonPosting[]) {
  const byNumber = new Map<string, OzonPosting>();
  for (const posting of postings) byNumber.set(posting.posting_number, posting);
  return Array.from(byNumber.values());
}

function ozonOptions(context: JobExecutionContext) {
  return {
    signal: context.signal,
    onRetry: ({ path, attempt, delayMs, status }: { path: string; attempt: number; delayMs: number; status: number | null }) =>
      context.report({ phase: "ozon_retry", path, attempt, delayMs, status }, "ozon_retry"),
  };
}

async function mapLimit<T, R>(items: T[], concurrency: number, operation: (item: T) => Promise<R>) {
  const output = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      output[index] = await operation(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return output;
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isSafeInteger(value)) throw new Error("Invalid orders sync days");
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function assertNotCancelled(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Job cancelled");
}
