#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { closeServerDatabasePool, queryServerDatabase } from "@/lib/db/pool";
import type { ServerMutationContext } from "@/lib/db/mutations/runner";
import { PostgresMarkingReadRepository } from "@/lib/marking/read-models/repository";
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
  operational_status_reason: string | null;
  revision: string | null;
};

type OzonSignalRow = {
  offer_id: string;
  marking_requirement: string;
};

type AppliedProfileRow = {
  sku: string;
  ozon_sku: string;
  profile_id: string | null;
  marking_requirement: string | null;
  marking_requirement_source: string | null;
  production_mode: string | null;
  fulfillment_marking_mode: string | null;
  profile_verification_status: string | null;
  operational_status: string | null;
  operational_status_reason: string | null;
  channel: string | null;
  offer_id: string | null;
  external_product_id: string | null;
  external_sku: string | null;
  channel_enabled: boolean | null;
  channel_marking_requirement: string | null;
  gtin: string | null;
  product_group: string | null;
  tnved_code: string | null;
  national_catalog_status: string | null;
  trade_item_verification_status: string | null;
  declared_color: string | null;
  declared_size_int: string | null;
  declared_size_ru: string | null;
  mapping_evidence_count: string;
};

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const verify = args.has("--verify");
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
  if (!apply) {
    if (verify) await verifyAppliedState(manifest, plan);
    return;
  }

  const results = [];
  for (const item of plan) {
    results.push(await applyProduct(item, manifest));
  }
  const resultSummary = summarizeResults(results);
  console.log("[marking-profile-reconcile] applied", resultSummary);
  if (resultSummary.failed > 0) {
    process.exitCode = 1;
    return;
  }
  await verifyAppliedState(manifest, plan);
}

async function verifyAppliedState(
  manifest: Manifest,
  plan: ReturnType<typeof planProduct>[],
) {
  const skus = manifest.products.map((item) => item.sku);
  const result = await queryServerDatabase<AppliedProfileRow>(
    `
      SELECT
        product.sku,
        product.ozon_sku::text AS ozon_sku,
        profile.id AS profile_id,
        profile.marking_requirement,
        profile.marking_requirement_source,
        profile.production_mode,
        profile.fulfillment_marking_mode,
        profile.verification_status AS profile_verification_status,
        profile.operational_status,
        profile.operational_status_reason,
        channel.channel,
        channel.offer_id,
        channel.external_product_id,
        channel.external_sku,
        channel.is_enabled AS channel_enabled,
        channel.marking_requirement AS channel_marking_requirement,
        trade_item.gtin,
        trade_item.product_group,
        trade_item.tnved_code,
        trade_item.national_catalog_status,
        trade_item.verification_status AS trade_item_verification_status,
        trade_item.declared_color,
        trade_item.declared_size_int,
        trade_item.declared_size_ru,
        coalesce(evidence.mapping_evidence_count, 0)::text AS mapping_evidence_count
      FROM public.merch_products AS product
      LEFT JOIN public.merch_marking_product_profiles AS profile
        ON profile.product_id = product.id
       AND profile.archived_at IS NULL
      LEFT JOIN public.merch_marking_product_profile_channels AS channel
        ON channel.product_profile_id = profile.id
       AND channel.channel = 'ozon_fbs'
      LEFT JOIN public.merch_marking_trade_items AS trade_item
        ON trade_item.id = profile.trade_item_id
      LEFT JOIN LATERAL (
        SELECT count(*) AS mapping_evidence_count
        FROM public.merch_marking_evidence AS item
        WHERE item.product_profile_id = profile.id
          AND item.evidence_type = 'product_profile_mapping'
          AND item.verification_status = 'verified'
      ) AS evidence ON true
      WHERE product.sku = ANY($1::text[])
      ORDER BY product.sku, profile.id
    `,
    [skus],
  );
  const rowsBySku = Map.groupBy(result.rows, (row) => row.sku);
  const plansBySku = new Map(plan.map((item) => [item.manifest.sku, item]));
  const errors: Array<{ sku: string; errors: string[] }> = [];

  for (const item of manifest.products) {
    const rows = rowsBySku.get(item.sku) ?? [];
    const row = rows[0];
    const itemErrors: string[] = [];
    const itemPlan = plansBySku.get(item.sku);
    if (rows.length !== 1 || !row?.profile_id || !itemPlan) {
      itemErrors.push(rows.length === 0 ? "profile_missing" : "profile_not_unique");
    } else {
      if (row.ozon_sku !== item.ozonSku) itemErrors.push("ozon_sku_mismatch");
      if (row.marking_requirement !== "required") itemErrors.push("requirement_mismatch");
      if (row.marking_requirement_source !== manifest.sourceId) itemErrors.push("source_mismatch");
      if (row.production_mode !== "own_production") itemErrors.push("production_mode_mismatch");
      if (row.fulfillment_marking_mode !== "jit_after_order") {
        itemErrors.push("fulfillment_mode_mismatch");
      }
      if (
        row.channel !== "ozon_fbs"
        || row.offer_id !== item.sku
        || row.external_product_id !== item.ozonSku
        || row.external_sku !== item.ozonSku
        || row.channel_enabled !== true
        || row.channel_marking_requirement !== "required"
      ) {
        itemErrors.push("channel_mapping_mismatch");
      }
      if (row.operational_status !== itemPlan.targetStatus) {
        itemErrors.push("operational_status_mismatch");
      }
      const expectedReason = item.nationalCatalogStatus === "moderation_pending"
        ? "National Catalog moderation is pending"
        : itemPlan.ozonSignal === "not_required"
          ? "Ozon currently reports marking as not required"
          : null;
      if (row.operational_status_reason !== expectedReason) {
        itemErrors.push("operational_reason_mismatch");
      }

      if (item.nationalCatalogStatus === "published") {
        if (row.profile_verification_status !== "verified") itemErrors.push("profile_not_verified");
        if (row.gtin !== item.gtin) itemErrors.push("gtin_mismatch");
        if (row.product_group !== item.productGroup) itemErrors.push("product_group_mismatch");
        if (row.tnved_code !== item.tnvedCode) itemErrors.push("tnved_mismatch");
        if (row.national_catalog_status !== "published") itemErrors.push("catalog_status_mismatch");
        if (row.trade_item_verification_status !== "verified") itemErrors.push("trade_item_not_verified");
        if (normalize(row.declared_color) !== normalize(item.declaredColor)) {
          itemErrors.push("declared_color_mismatch");
        }
        if (normalize(row.declared_size_int) !== normalize(item.declaredSizeInt)) {
          itemErrors.push("declared_size_int_mismatch");
        }
        if (normalize(row.declared_size_ru) !== normalize(item.declaredSizeRu)) {
          itemErrors.push("declared_size_ru_mismatch");
        }
        if (Number(row.mapping_evidence_count) < 1) itemErrors.push("mapping_evidence_missing");
      } else if (
        row.profile_verification_status !== "draft"
        || row.gtin !== null
        || Number(row.mapping_evidence_count) !== 0
      ) {
        itemErrors.push("moderation_profile_not_isolated");
      }
    }
    if (itemErrors.length > 0) errors.push({ sku: item.sku, errors: itemErrors });
  }

  const summary = {
    total: manifest.products.length,
    verified: result.rows.filter((row) => row.profile_verification_status === "verified").length,
    draft: result.rows.filter((row) => row.profile_verification_status === "draft").length,
    enabled: result.rows.filter((row) => row.operational_status === "enabled").length,
    paused: result.rows.filter((row) => row.operational_status === "paused").length,
    errors: errors.length,
  };
  const readModel = await verifyReadModel(manifest, plan);
  console.log("[marking-profile-reconcile] verified", summary);
  console.log("[marking-profile-reconcile] read model", readModel);
  if (errors.length > 0) {
    console.error("[marking-profile-reconcile] verification errors", errors);
    throw new Error("Applied marking profile state does not match the manifest");
  }
}

async function verifyReadModel(
  manifest: Manifest,
  plan: ReturnType<typeof planProduct>[],
) {
  const repository = new PostgresMarkingReadRepository();
  const readiness = [];
  let cursor: string | null = null;
  do {
    const page = await repository.listReadiness({ limit: 100, cursor });
    readiness.push(...page.items);
    cursor = page.page.nextCursor;
  } while (cursor);

  const skus = new Set(manifest.products.map((item) => item.sku));
  const items = readiness.filter((item) => item.sku && skus.has(item.sku));
  const ready = items.filter((item) => item.readinessStatus === "ready").length;
  const blocked = items.filter((item) => item.readinessStatus === "blocked").length;
  const expectedReady = plan.filter((item) => item.targetStatus === "enabled").length;
  const expectedBlocked = plan.length - expectedReady;
  if (
    items.length !== manifest.products.length
    || ready !== expectedReady
    || blocked !== expectedBlocked
  ) {
    throw new Error(
      `Read model mismatch: total=${items.length}, ready=${ready}, blocked=${blocked}`,
    );
  }

  const conflicts = (await repository.listConflicts({ limit: 500 }))
    .filter((item) => item.sku && skus.has(item.sku));
  const expectedConflictSkus = new Set(
    plan
      .filter((item) => item.ozonSignal === "not_required")
      .map((item) => item.manifest.sku),
  );
  const actualConflictSkus = new Set(conflicts.map((item) => item.sku).filter(Boolean));
  if (
    conflicts.some((item) => item.conflictType !== "ozon_requirement_mismatch")
    || actualConflictSkus.size !== expectedConflictSkus.size
    || [...expectedConflictSkus].some((sku) => !actualConflictSkus.has(sku))
  ) {
    throw new Error("Read model conflicts do not match current Ozon signals");
  }
  return {
    total: items.length,
    ready,
    blocked,
    conflicts: conflicts.length,
    conflictType: conflicts.length > 0 ? "ozon_requirement_mismatch" : null,
  };
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
        profile.operational_status_reason,
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
        AND fulfillment_order.source_status <> ALL (
          ARRAY[
            'delivering',
            'delivered',
            'driver_pickup',
            'sent_by_seller',
            'arbitration',
            'client_arbitration',
            'not_accepted',
            'cancelled'
          ]::text[]
        )
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
    const reason = plan.manifest.nationalCatalogStatus !== "published"
      ? "National Catalog moderation is pending"
      : plan.ozonSignal === "not_required"
        ? "Ozon currently reports marking as not required"
        : null;
    let profileId: string;
    let revision: number;
    let reusedExistingState = false;
    const existingState = plan.existing;

    if (canReuseExistingProfile(plan)) {
      profileId = existingState!.profile_id!;
      revision = Number(existingState!.revision);
      reusedExistingState = true;
    } else {
      const snapshotVersion = createHash("sha256")
        .update(JSON.stringify(snapshot))
        .digest("hex")
        .slice(0, 16);
      const profile = await upsertMarkingProductProfile({
        productId: plan.product.id,
        expectedRevision: plan.existing?.revision == null
          ? null
          : Number(plan.existing.revision),
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
      }, context(manifest.sourceId, plan.manifest.sku, `profile:${snapshotVersion}`));

      profileId = profile.profileId;
      revision = profile.revision;
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
        }, context(manifest.sourceId, plan.manifest.sku, `verify:${snapshotVersion}`));
        profileId = verified.profileId;
        revision = verified.revision;
      }
    }

    if (
      reusedExistingState
      && existingState?.operational_status === plan.targetStatus
      && existingState.operational_status_reason === reason
    ) {
      return {
        sku: plan.manifest.sku,
        status: plan.targetStatus,
        catalogStatus: plan.manifest.nationalCatalogStatus,
        ozonSignal: plan.ozonSignal,
        changed: false,
      };
    }

    const operational = await setMarkingProductOperationalStatus({
      profileId,
      expectedRevision: revision,
      operationalStatus: plan.targetStatus,
      reason,
      actorType: "migration",
      actorId: "stage4-catalog-reconcile",
    }, context(
      manifest.sourceId,
      plan.manifest.sku,
      `status:${plan.targetStatus}:${reason ?? "none"}`,
    ));
    return {
      sku: plan.manifest.sku,
      status: operational.operationalStatus,
      catalogStatus: plan.manifest.nationalCatalogStatus,
      ozonSignal: plan.ozonSignal,
      changed: true,
    };
  } catch (error) {
    console.error("[marking-profile-reconcile] item failed", {
      sku: plan.manifest.sku,
      error: safeErrorForLog(error),
    });
    return { sku: plan.manifest.sku, status: "failed", error: errorName(error) };
  }
}

function canReuseExistingProfile(plan: ReturnType<typeof planProduct>) {
  const existing = plan.existing;
  if (
    !existing?.profile_id
    || existing.revision == null
    || !Number.isSafeInteger(Number(existing.revision))
  ) {
    return false;
  }
  if (plan.manifest.nationalCatalogStatus === "published") {
    return existing.verification_status === "verified"
      && existing.gtin === plan.manifest.gtin;
  }
  return existing.verification_status === "draft" && existing.gtin === null;
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
