import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import type {
  MarkingFulfillmentMode,
  MarkingProfileChannel,
  MarkingProfileOperationalStatus,
  MarkingProductionMode,
  MarkingRequirement,
  MarkingVerificationStatus,
} from "@/lib/marking/domain/states";

export type ProductProfileState = {
  id: string;
  productId: string;
  tradeItemId: string | null;
  gtin: string | null;
  markingRequirement: MarkingRequirement;
  requirementSource: string | null;
  requirementObservedAt: string | null;
  productionMode: MarkingProductionMode;
  fulfillmentMode: MarkingFulfillmentMode;
  verificationStatus: MarkingVerificationStatus;
  operationalStatus: MarkingProfileOperationalStatus;
  revision: number;
};

export type ProductBackfillCandidate = {
  productId: string;
  sku: string | null;
  ozonProductId: string | null;
  activeProfileId: string | null;
  exactGtin: string | null;
  duplicateSkuCount: number;
};

type ProfileStateRow = {
  id: string;
  product_id: string;
  trade_item_id: string | null;
  gtin: string | null;
  marking_requirement: MarkingRequirement;
  marking_requirement_source: string | null;
  marking_requirement_observed_at: Date | string | null;
  production_mode: MarkingProductionMode;
  fulfillment_marking_mode: MarkingFulfillmentMode;
  verification_status: MarkingVerificationStatus;
  operational_status: MarkingProfileOperationalStatus;
  revision: string;
};

export async function getProductProfileState(
  query: DatabaseQueryExecutor,
  profileId: string,
) {
  const result = await query<ProfileStateRow>(
    `
      SELECT
        profile.id,
        profile.product_id,
        profile.trade_item_id,
        trade_item.gtin,
        profile.marking_requirement,
        profile.marking_requirement_source,
        profile.marking_requirement_observed_at,
        profile.production_mode,
        profile.fulfillment_marking_mode,
        profile.verification_status,
        profile.operational_status,
        profile.revision
      FROM public.merch_marking_product_profiles AS profile
      LEFT JOIN public.merch_marking_trade_items AS trade_item
        ON trade_item.id = profile.trade_item_id
      WHERE profile.id = $1::uuid
        AND profile.archived_at IS NULL
    `,
    [profileId],
  );
  return result.rows[0] ? mapProfileState(result.rows[0]) : null;
}

export async function upsertProductProfileDraft(
  query: DatabaseQueryExecutor,
  input: {
    productId: string;
    expectedRevision?: number | null;
    markingRequirement: MarkingRequirement;
    requirementSource?: string | null;
    requirementObservedAt?: string | null;
    productionMode: MarkingProductionMode;
    fulfillmentMode: MarkingFulfillmentMode;
    channel: MarkingProfileChannel;
    offerId?: string | null;
    externalProductId?: string | null;
    externalSku?: string | null;
    sourceSnapshotHash?: string | null;
    actorType: string;
    actorId: string;
  },
) {
  const result = await query<{
    profile_id: string;
    revision: string;
    operational_status: MarkingProfileOperationalStatus;
    verification_status: MarkingVerificationStatus;
    created: boolean;
  }>(
    `
      SELECT
        command.profile_id,
        command.revision,
        command.operational_status,
        command.verification_status,
        command.created
      FROM getomerch_marking.upsert_product_profile_draft(
        $1::uuid, $2::bigint, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10,
        $11, $12, $13, $14
      ) AS command
    `,
    [
      input.productId,
      input.expectedRevision ?? null,
      input.markingRequirement,
      input.requirementSource ?? null,
      input.requirementObservedAt ?? null,
      input.productionMode,
      input.fulfillmentMode,
      input.channel,
      input.offerId ?? null,
      input.externalProductId ?? null,
      input.externalSku ?? null,
      input.sourceSnapshotHash ?? null,
      input.actorType,
      input.actorId,
    ],
  );
  const row = result.rows[0];
  return {
    profileId: row.profile_id,
    revision: Number(row.revision),
    operationalStatus: row.operational_status,
    verificationStatus: row.verification_status,
    created: row.created,
  };
}

export async function verifyTradeItemAndProfile(
  query: DatabaseQueryExecutor,
  input: {
    profileId: string;
    expectedRevision: number;
    gtin: string;
    productGroup: string;
    tnvedCode?: string | null;
    nationalCatalogCardId?: string | null;
    nationalCatalogStatus?: string | null;
    declaredProductType?: string | null;
    declaredFabric?: string | null;
    declaredColor?: string | null;
    declaredSizeInt?: string | null;
    declaredSizeRu?: string | null;
    declaredComposition?: string | null;
    verificationSource: string;
    sourceSnapshotHash: string;
    externalReference?: string | null;
    actorType: string;
    actorId: string;
  },
) {
  const result = await query<{
    result_profile_id: string;
    trade_item_id: string;
    revision: string;
    verification_status: MarkingVerificationStatus;
  }>(
    `
      SELECT
        command.result_profile_id,
        command.trade_item_id,
        command.revision,
        command.verification_status
      FROM getomerch_marking.verify_trade_item_and_profile(
        $1::uuid, $2::bigint, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18
      ) AS command
    `,
    [
      input.profileId,
      input.expectedRevision,
      input.gtin,
      input.productGroup,
      input.tnvedCode ?? null,
      input.nationalCatalogCardId ?? null,
      input.nationalCatalogStatus ?? null,
      input.declaredProductType ?? null,
      input.declaredFabric ?? null,
      input.declaredColor ?? null,
      input.declaredSizeInt ?? null,
      input.declaredSizeRu ?? null,
      input.declaredComposition ?? null,
      input.verificationSource,
      input.sourceSnapshotHash,
      input.externalReference ?? null,
      input.actorType,
      input.actorId,
    ],
  );
  const row = result.rows[0];
  return {
    profileId: row.result_profile_id,
    tradeItemId: row.trade_item_id,
    revision: Number(row.revision),
    verificationStatus: row.verification_status,
  };
}

export async function insertProductProfileEvidence(
  query: DatabaseQueryExecutor,
  input: {
    profileId: string;
    expectedRevision: number;
    evidenceType: string;
    source: string;
    externalReference?: string | null;
    scope: Record<string, unknown>;
    payloadHash: string;
    details: Record<string, unknown>;
    verificationStatus: string;
    actorType: string;
    actorId: string;
  },
) {
  const result = await query<{ evidence_id: string; revision: string }>(
    `
      SELECT command.evidence_id, command.revision
      FROM getomerch_marking.attach_product_profile_evidence(
        $1::uuid, $2::bigint, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10, $11
      ) AS command
    `,
    [
      input.profileId,
      input.expectedRevision,
      input.evidenceType,
      input.source,
      input.externalReference ?? null,
      JSON.stringify(input.scope),
      input.payloadHash,
      JSON.stringify(input.details),
      input.verificationStatus,
      input.actorType,
      input.actorId,
    ],
  );
  return {
    evidenceId: result.rows[0].evidence_id,
    revision: Number(result.rows[0].revision),
  };
}

export async function updateProductProfileOperationalStatus(
  query: DatabaseQueryExecutor,
  input: {
    profileId: string;
    expectedRevision: number;
    operationalStatus: Exclude<MarkingProfileOperationalStatus, "draft">;
    reason?: string | null;
    actorType: string;
    actorId: string;
  },
) {
  const result = await query<{
    profile_id: string;
    operational_status: MarkingProfileOperationalStatus;
    revision: string;
    updated_at: Date | string;
  }>(
    `
      SELECT
        command.profile_id,
        command.operational_status,
        command.revision,
        command.updated_at
      FROM getomerch_marking.set_product_profile_operational_status(
        $1::uuid, $2::bigint, $3, $4, $5, $6
      ) AS command
    `,
    [
      input.profileId,
      input.expectedRevision,
      input.operationalStatus,
      input.reason ?? null,
      input.actorType,
      input.actorId,
    ],
  );
  const row = result.rows[0];
  return {
    profileId: row.profile_id,
    operationalStatus: row.operational_status,
    revision: Number(row.revision),
    updatedAt: toIso(row.updated_at),
  };
}

export async function listProductBackfillCandidates(
  query: DatabaseQueryExecutor,
): Promise<ProductBackfillCandidate[]> {
  const result = await query<{
    product_id: string;
    sku: string | null;
    ozon_product_id: string | null;
    active_profile_id: string | null;
    exact_gtin: string | null;
    duplicate_sku_count: string;
  }>(
    `
      SELECT
        product.id AS product_id,
        product.sku,
        product.ozon_sku::text AS ozon_product_id,
        profile.id AS active_profile_id,
        trade_item.gtin AS exact_gtin,
        count(*) OVER (PARTITION BY product.sku)::text AS duplicate_sku_count
      FROM public.merch_products AS product
      LEFT JOIN public.merch_marking_product_profiles AS profile
        ON profile.product_id = product.id
       AND profile.archived_at IS NULL
      LEFT JOIN public.merch_marking_trade_items AS trade_item
        ON trade_item.id = profile.trade_item_id
      WHERE NOT product.is_blank
      ORDER BY product.sku NULLS LAST, product.id
      LIMIT 5000
    `,
  );
  return result.rows.map((row) => ({
    productId: row.product_id,
    sku: row.sku,
    ozonProductId: row.ozon_product_id,
    activeProfileId: row.active_profile_id,
    exactGtin: row.exact_gtin,
    duplicateSkuCount: Number(row.duplicate_sku_count),
  }));
}

export async function insertProfileBackfillPreview(
  query: DatabaseQueryExecutor,
  input: {
    source: string;
    options: Record<string, unknown>;
    items: unknown[];
    actorId: string;
  },
) {
  const result = await query<{ run_id: string }>(
    `
      SELECT getomerch_marking.create_profile_backfill_preview(
        $1, $2::jsonb, $3::jsonb, $4
      ) AS run_id
    `,
    [input.source, JSON.stringify(input.options), JSON.stringify(input.items), input.actorId],
  );
  return result.rows[0].run_id;
}

export async function applyProfileBackfillRun(
  query: DatabaseQueryExecutor,
  runId: string,
  actorId: string,
) {
  const result = await query<{ summary: Record<string, unknown> }>(
    `
      SELECT getomerch_marking.apply_profile_backfill($1::uuid, $2) AS summary
    `,
    [runId, actorId],
  );
  return result.rows[0].summary;
}

function mapProfileState(row: ProfileStateRow): ProductProfileState {
  return {
    id: row.id,
    productId: row.product_id,
    tradeItemId: row.trade_item_id,
    gtin: row.gtin,
    markingRequirement: row.marking_requirement,
    requirementSource: row.marking_requirement_source,
    requirementObservedAt: nullableIso(row.marking_requirement_observed_at),
    productionMode: row.production_mode,
    fulfillmentMode: row.fulfillment_marking_mode,
    verificationStatus: row.verification_status,
    operationalStatus: row.operational_status,
    revision: Number(row.revision),
  };
}

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null) {
  return value == null ? null : toIso(value);
}
