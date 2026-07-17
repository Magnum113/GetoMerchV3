import "server-only";

import { queryServerDatabase } from "@/lib/db/pool";
import { withServerDatabaseTransaction } from "@/lib/db/transaction";
import type { JobExecutionContext } from "@/lib/jobs/execution";
import { ozonPost } from "@/lib/ozon/client";

const PAGE_SIZE = 1000;
const MAX_PAGES_GUARD = 10_000;

type Price = {
  marketing_seller_price?: number | string;
  price?: number | string;
  old_price?: number | string;
  min_price?: number | string;
};

type PriceItem = { offer_id: string; price: Price };

export async function executePricesSync(context: JobExecutionContext) {
  const dryRun = context.job.payload.dryRun === true;
  const startedAt = Date.now();
  const priceByOffer = await fetchAllPrices(context);
  const products = await queryServerDatabase<{
    id: string;
    sku: string;
    legacy_skus: string[];
    sale_price: string | number | null;
  }>(
    `
      SELECT id, sku, legacy_skus, sale_price
      FROM merch_products
      WHERE sku IS NOT NULL
      ORDER BY id
    `,
  );

  const updates: Array<{ id: string; salePrice: number }> = [];
  let unchanged = 0;
  let notFound = 0;
  const notFoundSamples: string[] = [];
  for (const product of products.rows) {
    const candidates = [product.sku, ...(product.legacy_skus ?? [])];
    const price = candidates.map((candidate) => priceByOffer.get(candidate)).find(Boolean);
    const sale = Number(price?.marketing_seller_price || price?.price || 0);
    if (!price || !Number.isFinite(sale) || sale <= 0) {
      notFound += 1;
      if (notFoundSamples.length < 10) notFoundSamples.push(product.sku);
      continue;
    }
    if (Number(product.sale_price) === sale) {
      unchanged += 1;
      continue;
    }
    updates.push({ id: product.id, salePrice: sale });
  }

  if (!dryRun) {
    let applied = 0;
    for (const batch of chunk(updates, 500)) {
      assertNotCancelled(context.signal);
      await withServerDatabaseTransaction((query) => query(
        `
          UPDATE merch_products product
          SET sale_price = input.sale_price
          FROM jsonb_to_recordset($1::jsonb) AS input(id uuid, sale_price numeric)
          WHERE product.id = input.id
            AND product.sale_price IS DISTINCT FROM input.sale_price
        `,
        [JSON.stringify(batch.map((item) => ({ id: item.id, sale_price: item.salePrice })))],
      ));
      applied += batch.length;
      await context.report({
        phase: "apply",
        total: products.rows.length,
        updated: applied,
        unchanged,
        notFound,
      });
    }
  }

  return {
    dryRun,
    total: products.rows.length,
    updated: dryRun ? 0 : updates.length,
    wouldUpdate: updates.length,
    unchanged,
    notFound,
    notFoundSamples,
    fetchedPrices: priceByOffer.size,
    durationMs: Date.now() - startedAt,
  };
}

async function fetchAllPrices(context: JobExecutionContext) {
  const prices = new Map<string, Price>();
  const seenCursors = new Set<string>();
  let cursor = "";
  for (let page = 1; page <= MAX_PAGES_GUARD; page += 1) {
    assertNotCancelled(context.signal);
    const response = await ozonPost<{ items?: PriceItem[]; cursor?: string }>(
      "/v5/product/info/prices",
      { filter: { visibility: "ALL" }, cursor, limit: PAGE_SIZE },
      {
        signal: context.signal,
        onRetry: ({ path, attempt, delayMs, status }) =>
          context.report({ phase: "ozon_retry", path, attempt, delayMs, status }, "ozon_retry"),
      },
    );
    const items = response.items ?? [];
    for (const item of items) prices.set(String(item.offer_id), item.price);
    await context.report({ phase: "fetch", page, fetched: prices.size });
    const nextCursor = response.cursor ?? "";
    if (!nextCursor) return prices;
    if (seenCursors.has(nextCursor)) throw new Error("Ozon price pagination cursor repeated");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error("Ozon price pagination exceeded safety guard");
}

function chunk<T>(items: T[], size: number) {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function assertNotCancelled(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Job cancelled");
}
