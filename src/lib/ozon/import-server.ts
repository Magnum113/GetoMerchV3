import "server-only";

import { queryServerDatabase } from "@/lib/db/pool";
import { withServerDatabaseTransaction } from "@/lib/db/transaction";
import type { JobExecutionContext } from "@/lib/jobs/execution";
import {
  buildItemPlan,
  collectDesignSuggestions,
  fetchOzonProducts,
  normalizeStoredItem,
  summarize,
  type Catalog,
  type CatalogRow,
  type OzonImportItem,
  type OzonImportPreview,
} from "@/lib/ozon-import";

type ProductRow = {
  id: string;
  category_id: string;
  fabric_id: string;
  color_id: string;
  size_id: string;
  design_id: string | null;
  decoration_type_id: string | null;
  sku: string | null;
  ozon_sku: number | string | null;
  legacy_skus: string[] | null;
  design_version: string | null;
  hoodie_fit: string | null;
  hoodie_fabric: string | null;
  is_blank: boolean;
  sale_price: number | string | null;
};

type ImportRunRow = {
  id: string;
  status: string;
  summary: OzonImportPreview["summary"];
  created_at: Date | string;
};

export async function executeImportPreview(context: JobExecutionContext) {
  const startedAt = Date.now();
  await context.report({ phase: "fetch", fetched: 0 }, "fetch_started");
  const [ozonProducts, catalog] = await Promise.all([
    fetchOzonProducts({
      signal: context.signal,
      onProgress: (progress) => context.report(progress),
    }),
    loadServerCatalog(),
  ]);
  const items = ozonProducts
    .map((product) => buildItemPlan(product, catalog))
    .sort((left, right) => left.offerId.localeCompare(right.offerId, "en", { numeric: true }));
  const summary = summarize(items);
  await context.report({ phase: "persist", total: items.length, summary }, "plan_built");
  const persisted = await persistServerPreview(items, summary, context.job.id);
  return {
    runId: persisted.runId,
    createdAt: persisted.createdAt,
    summary,
    canApply: summary.actionable > 0,
    durationMs: Date.now() - startedAt,
  };
}

export async function getServerImportPreview(runId: string): Promise<OzonImportPreview | null> {
  const run = (
    await queryServerDatabase<ImportRunRow>(
      `
        SELECT id, status, summary, created_at
        FROM merch_ozon_import_runs
        WHERE id = $1::uuid
      `,
      [runId],
    )
  ).rows[0];
  if (!run) return null;
  const rows = await queryServerDatabase<Record<string, unknown>>(
    `
      SELECT
        id, offer_id, ozon_product_id, ozon_sku, ozon_name, status, severity,
        match_reason, target_product_id, parsed, plan, raw, errors, warnings,
        applied_at, apply_error, created_at
      FROM merch_ozon_import_items
      WHERE run_id = $1::uuid
      ORDER BY offer_id COLLATE "C", id
    `,
    [runId],
  );
  const items = rows.rows.map(normalizeStoredItem);
  const summary = run.summary ?? summarize(items);
  return {
    runId: run.id,
    createdAt: iso(run.created_at),
    summary,
    items,
    designSuggestions: collectDesignSuggestions(items),
    canApply: run.status === "preview" && summary.actionable > 0,
  };
}

async function loadServerCatalog(): Promise<Catalog> {
  const [categories, fabrics, colors, sizes, decorations, designs, products] = await Promise.all([
    queryServerDatabase<CatalogRow>("SELECT id, name, slug FROM merch_product_categories ORDER BY id"),
    queryServerDatabase<CatalogRow>("SELECT id, name, slug FROM merch_fabric_types ORDER BY id"),
    queryServerDatabase<CatalogRow>("SELECT id, name, hex_code AS code FROM merch_colors ORDER BY id"),
    queryServerDatabase<CatalogRow>("SELECT id, name, sort_order FROM merch_sizes ORDER BY sort_order, id"),
    queryServerDatabase<CatalogRow>("SELECT id, name, slug FROM merch_decoration_types ORDER BY id"),
    queryServerDatabase<CatalogRow>("SELECT id, name, code, type FROM merch_designs ORDER BY id"),
    queryServerDatabase<ProductRow>(`
      SELECT
        id, category_id, fabric_id, color_id, size_id, design_id,
        decoration_type_id, sku, ozon_sku, legacy_skus, design_version,
        hoodie_fit, hoodie_fabric, is_blank, sale_price
      FROM merch_products
      ORDER BY id
    `),
  ]);

  const colorCodeByName: Record<string, string> = {
    "Чёрный": "BLK",
    "Черный": "BLK",
    "Белый": "WHT",
    "Серый": "WGRY",
    "Бежевый": "WBEG",
    "Синий": "BLU",
  };
  const colorsByCode = new Map(colors.rows.map((row) => [colorCodeByName[row.name] ?? row.name.toUpperCase(), row]));
  const blue = colors.rows.find((row) => row.name === "Синий");
  if (blue) colorsByCode.set("WBLU", blue);

  const productsBySku = new Map<string, ProductRow>();
  const productsByLegacySku = new Map<string, ProductRow>();
  const productsByOzonSku = new Map<string, ProductRow>();
  for (const product of products.rows) {
    if (product.sku) productsBySku.set(product.sku, product);
    for (const legacy of product.legacy_skus ?? []) productsByLegacySku.set(legacy, product);
    if (product.ozon_sku) productsByOzonSku.set(String(product.ozon_sku), product);
  }

  return {
    categoriesBySlug: new Map(categories.rows.map((row) => [String(row.slug), row])),
    fabricsBySlug: new Map(fabrics.rows.map((row) => [String(row.slug), row])),
    colorsByCode,
    sizesByName: new Map(sizes.rows.map((row) => [row.name, row])),
    decorationBySlug: new Map(decorations.rows.map((row) => [String(row.slug), row])),
    designsByCodeType: new Map(
      designs.rows
        .filter((row) => row.code && row.type)
        .map((row) => [`${row.code}|${row.type}`, row]),
    ),
    productsBySku,
    productsByLegacySku,
    productsByOzonSku,
  } as Catalog;
}

async function persistServerPreview(
  items: OzonImportItem[],
  summary: OzonImportPreview["summary"],
  jobId: string,
) {
  return withServerDatabaseTransaction(async (query) => {
    const run = (
      await query<{ id: string; created_at: Date | string }>(
        `
          INSERT INTO merch_ozon_import_runs (status, mode, summary, options)
          VALUES ('preview', 'ozon_products', $1::jsonb, $2::jsonb)
          RETURNING id, created_at
        `,
        [JSON.stringify(summary), JSON.stringify({ jobId })],
      )
    ).rows[0];
    if (items.length > 0) {
      const payload = items.map((item) => ({
        offer_id: item.offerId,
        ozon_product_id: item.ozonProductId,
        ozon_sku: item.ozonSku,
        ozon_name: item.ozonName,
        status: item.status,
        severity: item.severity,
        match_reason: item.matchReason,
        target_product_id: item.targetProductId,
        parsed: item.parsed,
        plan: { actions: item.actions },
        raw: item.raw,
        errors: item.errors,
        warnings: item.warnings,
      }));
      await query(
        `
          INSERT INTO merch_ozon_import_items (
            run_id, offer_id, ozon_product_id, ozon_sku, ozon_name, status,
            severity, match_reason, target_product_id, parsed, plan, raw,
            errors, warnings
          )
          SELECT
            $1::uuid, input.offer_id, input.ozon_product_id, input.ozon_sku,
            input.ozon_name, input.status, input.severity, input.match_reason,
            input.target_product_id, input.parsed, input.plan, input.raw,
            input.errors, input.warnings
          FROM jsonb_to_recordset($2::jsonb) AS input(
            offer_id text,
            ozon_product_id bigint,
            ozon_sku bigint,
            ozon_name text,
            status text,
            severity text,
            match_reason text,
            target_product_id uuid,
            parsed jsonb,
            plan jsonb,
            raw jsonb,
            errors text[],
            warnings text[]
          )
        `,
        [run.id, JSON.stringify(payload)],
      );
    }
    return { runId: run.id, createdAt: iso(run.created_at) };
  });
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : String(value);
}
