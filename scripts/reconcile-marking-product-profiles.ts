#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { closeServerDatabasePool, queryServerDatabase } from "@/lib/db/pool";
import type { ServerMutationContext } from "@/lib/db/mutations/runner";
import {
  setMarkingProductOperationalStatus,
  upsertMarkingProductProfile,
  verifyMarkingProductGtin,
} from "@/lib/marking/services/product-readiness-service";
import { safeErrorForLog } from "@/lib/marking/security/redaction";

type ManifestProduct = {
  sku: string;
  catalogOfferId: string;
  ozonSku: string;
  gtin: string;
  nationalCatalogStatus: "published" | "moderation_pending";
  productGroup: "lp";
  tnvedCode: string;
  declaredProductType: string;
  declaredFabric: string;
  declaredColor: string;
  declaredSizeInt: string;
  declaredSizeRu: string;
  declaredComposition: string;
};

type Manifest = {
  version: 1;
  sourceId: string;
  generatedAt: string;
  source: string;
  products: ManifestProduct[];
};

type ProductRow = {
  id: string;
  sku: string;
  ozon_sku: string;
  is_blank: boolean;
  color: string | null;
  size: string | null;
};

type ExistingProfileRow = {
  sku: string;
  profile_id: string | null;
  gtin: string | null;
  verification_status: string | null;
  operational_status: string | null;
  revision: string | null;
};

type OzonSignalRow = {
  offer_id: string;
  marking_requirement: string;
};

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const manifestArg = process.argv.find((value) => value.startsWith("--manifest="));
const manifestPath = resolve(
  manifestArg?.slice("--manifest=".length)
    || "docs/chestny-znak-ozon/stage-4/product-profile-manifest-2026-08-10.json",
);

run().catch((error) => {
  console.error("[marking-profile-reconcile] failed", safeErrorForLog(error));
  process.exitCode = 1;
}).finally(() => closeServerDatabasePool());

async function run() {
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const state = await loadState(manifest);
  const plan = manifest.products.map((item) => planProduct(item, state));
  const summary = summarize(plan);

  console.log("[marking-profile-reconcile] preview", {
    sourceId: manifest.sourceId,
    manifestPath,
    apply,
    ...summary,
  });

  const fatal = plan.filter((item) => item.action === "conflict");
  if (fatal.length > 0) {
    console.error("[marking-profile-reconcile] conflicts", fatal);
    throw new Error("Manifest conflicts must be resolved before apply");
  }
  if (!apply) return;

  const results = [];
  for (const item of plan) {
    results.push(await applyProduct(item, manifest));
  }
  const resultSummary = summarizeResults(results);
  console.log("[marking-profile-reconcile] applied", resultSummary);
  if (resultSummary.failed > 0) process.exitCode = 1;
}

async function loadState(manifest: Manifest) {
  const skus = manifest.products.map((item) => item.sku);
  const products = await queryServerDatabase<ProductRow>(
    `
      SELECT
        product.id,
        product.sku,
        product.ozon_sku::text AS ozon_sku,
        product.is_blank,
        color.name AS color,
        size.name AS size
      FROM public.merch_products AS product
      LEFT JOIN public.merch_colors AS color ON color.id = product.color_id
      LEFT JOIN public.merch_sizes AS size ON size.id = product.size_id
      WHERE product.sku = ANY($1::text[])
      ORDER BY product.sku, product.id
    `,
    [skus],
  );
  const profiles = await queryServerDatabase<ExistingProfileRow>(
    `
      SELECT
        product.sku,
        profile.id AS profile_id,
        trade_item.gtin,
        profile.verification_status,
        profile.operational_status,
        profile.revision::text
      FROM public.merch_products AS product
      LEFT JOIN public.merch_marking_product_profiles AS profile
        ON profile.product_id = product.id
       AND profile.archived_at IS NULL
      LEFT JOIN public.merch_marking_trade_items AS trade_item
        ON trade_item.id = profile.trade_item_id
      WHERE product.sku = ANY($1::text[])
      ORDER BY product.sku
    `,
    [skus],
  );
  const signals = await queryServerDatabase<OzonSignalRow>(
    `
      SELECT DISTINCT ON (item.offer_id)
        item.offer_id,
        item.marking_requirement
      FROM public.merch_fulfillment_order_items AS item
      JOIN public.merch_fulfillment_orders AS fulfillment_order
        ON fulfillment_order.id = item.fulfillment_order_id
      WHERE fulfillment_order.source_channel = 'ozon_fbs'
        AND item.source_active
        AND item.offer_id = ANY($1::text[])
      ORDER BY item.offer_id, item.updated_at DESC, item.id DESC
    `,
    [skus],
  );
  return {
    products: products.rows,
    profiles: new Map(
      profiles.rows
        .filter((row) => row.profile_id !== null)
        .map((row) => [row.sku, row]),
    ),
    signals: new Map(signals.rows.map((row) => [row.offer_id, row.marking_requirement])),
  };
}

function planProduct(
  manifest: ManifestProduct,
  state: Awaited<ReturnType<typeof loadState>>,
) {
  const products = state.products.filter((item) => item.sku === manifest.sku);
  const product = products[0] ?? null;
  const errors: string[] = [];
  if (products.length !== 1) errors.push(products.length === 0 ? "product_missing" : "sku_not_unique");
  if (product?.is_blank) errors.push("blank_product");
  if (product && product.ozon_sku !== manifest.ozonSku) errors.push("ozon_sku_mismatch");
  if (product && normalize(product.color) !== normalize(manifest.declaredColor)) {
    errors.push("color_mismatch");
  }
  if (product && normalize(product.size) !== normalize(manifest.declaredSizeInt)) {
    errors.push("size_mismatch");
  }
  const existing = state.profiles.get(manifest.sku) ?? null;
  if (existing?.gtin && existing.gtin !== manifest.gtin) errors.push("active_gtin_mismatch");
  const ozonSignal = state.signals.get(manifest.sku) ?? "unknown";
  const targetStatus = manifest.nationalCatalogStatus === "published"
    && ozonSignal !== "not_required"
    ? "enabled"
    : "paused";
  return {
    manifest,
    product,
    existing,
    ozonSignal,
    targetStatus,
    action: errors.length > 0 ? "conflict" : existing ? "reconcile" : "create",
    errors,
  } as const;
}

async function applyProduct(
  plan: ReturnType<typeof planProduct>,
  manifest: Manifest,
) {
  if (!plan.product || plan.action === "conflict") {
    return { sku: plan.manifest.sku, status: "failed", error: plan.errors.join(",") };
  }
  const snapshot = {
    sourceId: manifest.sourceId,
    sku: plan.manifest.sku,
    catalogOfferId: plan.manifest.catalogOfferId,
    ozonSku: plan.manifest.ozonSku,
    gtin: plan.manifest.gtin,
    nationalCatalogStatus: plan.manifest.nationalCatalogStatus,
    attributes: {
      color: plan.manifest.declaredColor,
      sizeInt: plan.manifest.declaredSizeInt,
      sizeRu: plan.manifest.declaredSizeRu,
    },
  };
  try {
    const profile = await upsertMarkingProductProfile({
      productId: plan.product.id,
      markingRequirement: "required",
      requirementSource: manifest.sourceId,
      requirementObservedAt: manifest.generatedAt,
      productionMode: "own_production",
      fulfillmentMode: "jit_after_order",
      channel: "ozon_fbs",
      offerId: plan.manifest.sku,
      externalProductId: plan.manifest.ozonSku,
      externalSku: plan.manifest.ozonSku,
      sourceSnapshot: snapshot,
      actorType: "migration",
      actorId: "stage4-catalog-reconcile",
    }, context(manifest.sourceId, plan.manifest.sku, "profile"));

    let profileId = profile.profileId;
    let revision = profile.revision;
    if (plan.manifest.nationalCatalogStatus === "published") {
      const verified = await verifyMarkingProductGtin({
        profileId,
        expectedRevision: revision,
        gtin: plan.manifest.gtin,
        productGroup: plan.manifest.productGroup,
        tnvedCode: plan.manifest.tnvedCode,
        nationalCatalogStatus: "published",
        declaredProductType: plan.manifest.declaredProductType,
        declaredFabric: plan.manifest.declaredFabric,
        declaredColor: plan.manifest.declaredColor,
        declaredSizeInt: plan.manifest.declaredSizeInt,
        declaredSizeRu: plan.manifest.declaredSizeRu,
        declaredComposition: plan.manifest.declaredComposition,
        verificationSource: manifest.sourceId,
        externalReference: `national-catalog:gtin:${plan.manifest.gtin}`,
        sourceSnapshot: snapshot,
        actorType: "migration",
        actorId: "stage4-catalog-reconcile",
      }, context(manifest.sourceId, plan.manifest.sku, "verify"));
      profileId = verified.profileId;
      revision = verified.revision;
    }

    const reason = plan.manifest.nationalCatalogStatus !== "published"
      ? "National Catalog moderation is pending"
      : plan.ozonSignal === "not_required"
        ? "Ozon currently reports marking as not required"
        : null;
    const operational = await setMarkingProductOperationalStatus({
      profileId,
      expectedRevision: revision,
      operationalStatus: plan.targetStatus,
      reason,
      actorType: "migration",
      actorId: "stage4-catalog-reconcile",
    }, context(manifest.sourceId, plan.manifest.sku, "status"));
    return {
      sku: plan.manifest.sku,
      status: operational.operationalStatus,
      catalogStatus: plan.manifest.nationalCatalogStatus,
      ozonSignal: plan.ozonSignal,
    };
  } catch (error) {
    console.error("[marking-profile-reconcile] item failed", {
      sku: plan.manifest.sku,
      error: safeErrorForLog(error),
    });
    return { sku: plan.manifest.sku, status: "failed", error: errorName(error) };
  }
}

function context(sourceId: string, sku: string, operation: string): ServerMutationContext {
  const digest = createHash("sha256")
    .update(`${sourceId}:${sku}:${operation}`)
    .digest("hex")
    .slice(0, 32);
  return {
    actor: "stage4-catalog-reconcile",
    sessionId: sourceId,
    requestId: randomUUID(),
    idempotencyKey: `marking-profile:${digest}`,
  };
}

function parseManifest(value: unknown): Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Manifest must be an object");
  }
  const manifest = value as Manifest;
  if (manifest.version !== 1 || !safeToken(manifest.sourceId) || !Array.isArray(manifest.products)) {
    throw new Error("Unsupported profile manifest");
  }
  if (!Number.isFinite(Date.parse(manifest.generatedAt)) || manifest.products.length < 1) {
    throw new Error("Manifest metadata is invalid");
  }
  const skus = new Set<string>();
  const gtins = new Set<string>();
  const ozonSkus = new Set<string>();
  for (const item of manifest.products) {
    if (!/^[A-Z0-9-]{5,100}$/.test(item.sku) || !/^\d{14}$/.test(item.gtin)) {
      throw new Error(`Invalid product identity in manifest: ${item.sku}`);
    }
    if (!/^\d+$/.test(item.ozonSku) || item.productGroup !== "lp") {
      throw new Error(`Invalid Ozon/product group data: ${item.sku}`);
    }
    if (!/^(published|moderation_pending)$/.test(item.nationalCatalogStatus)) {
      throw new Error(`Invalid catalog status: ${item.sku}`);
    }
    if (skus.has(item.sku) || gtins.has(item.gtin) || ozonSkus.has(item.ozonSku)) {
      throw new Error(`Duplicate identity in manifest: ${item.sku}`);
    }
    skus.add(item.sku);
    gtins.add(item.gtin);
    ozonSkus.add(item.ozonSku);
  }
  return manifest;
}

function summarize(plan: ReturnType<typeof planProduct>[]) {
  return {
    total: plan.length,
    create: plan.filter((item) => item.action === "create").length,
    reconcile: plan.filter((item) => item.action === "reconcile").length,
    conflicts: plan.filter((item) => item.action === "conflict").length,
    published: plan.filter((item) => item.manifest.nationalCatalogStatus === "published").length,
    moderationPending: plan.filter((item) => item.manifest.nationalCatalogStatus === "moderation_pending").length,
    enable: plan.filter((item) => item.targetStatus === "enabled").length,
    pause: plan.filter((item) => item.targetStatus === "paused").length,
    ozonNotRequired: plan.filter((item) => item.ozonSignal === "not_required").length,
  };
}

function summarizeResults(results: Awaited<ReturnType<typeof applyProduct>>[]) {
  return {
    total: results.length,
    enabled: results.filter((item) => item.status === "enabled").length,
    paused: results.filter((item) => item.status === "paused").length,
    failed: results.filter((item) => item.status === "failed").length,
    failures: results.filter((item) => item.status === "failed"),
  };
}

function safeToken(value: string) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,120}$/.test(value);
}

function normalize(value: string | null) {
  return value?.trim().toLowerCase().replaceAll("ё", "е").replace(/[^a-zа-я0-9]+/g, "") ?? "";
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : "UnknownError";
}
