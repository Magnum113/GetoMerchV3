import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import { queryServerDatabase } from "@/lib/db/pool";
import {
  decodeMarkingCursor,
  encodeMarkingCursor,
} from "@/lib/marking/read-models/cursor";
import type {
  CursorPage,
  MarkingCodeImportBatch,
  MarkingCodeImportDetail,
  MarkingCodeImportRow,
  MarkingCodePoolItem,
  MarkingCodePoolSummary,
  MarkingAssignmentListItem,
  MarkingEventListItem,
  MarkingConflictItem,
  MarkingEvidenceListItem,
  MarkingProfileBackfillDetail,
  MarkingProfileBackfillItem,
  MarkingProfileBackfillRun,
  MarkingProcessDetail,
  MarkingProcessListItem,
  MarkingJitCandidate,
  MarkingReadinessItem,
  MarkingReadinessStatus,
} from "@/lib/marking/read-models/types";
import type {
  MarkingProcessStatus,
  MarkingVerificationStatus,
} from "@/lib/marking/domain/states";

type ReadinessRow = {
  profile_id: string | null;
  product_id: string;
  sku: string | null;
  offer_id: string | null;
  ozon_sku: string | null;
  external_product_id: string | null;
  channel: MarkingReadinessItem["channel"];
  category: string | null;
  fabric: string | null;
  color: string | null;
  size: string | null;
  design: string | null;
  requires_marking: boolean | null;
  marking_requirement: MarkingReadinessItem["markingRequirement"];
  marking_requirement_source: string | null;
  marking_requirement_observed_at: Date | string | null;
  production_mode: MarkingReadinessItem["productionMode"];
  fulfillment_marking_mode: MarkingReadinessItem["fulfillmentMarkingMode"];
  profile_verification_status: MarkingVerificationStatus | null;
  operational_status: MarkingReadinessItem["operationalStatus"];
  operational_status_reason: string | null;
  revision: string | null;
  trade_item_id: string | null;
  gtin: string | null;
  product_group: string | null;
  national_catalog_card_id: string | null;
  national_catalog_status: string | null;
  trade_item_verification_status: MarkingVerificationStatus | null;
  verified_evidence_count: string;
  conflict_count: number;
  readiness_status: MarkingReadinessStatus;
  blocker_reasons: string[];
  warnings: string[];
  created_at: Date | string;
  updated_at: Date | string;
};

type ProcessRow = {
  id: string;
  process_type: string;
  status: MarkingProcessStatus;
  source: string;
  source_key: string;
  priority: number;
  current_step: string;
  next_action: string | null;
  deadline_at: Date | string | null;
  manual_review_reason: string | null;
  last_error_code: string | null;
  owner: string | null;
  version: string;
  fulfillment_order_id: string | null;
  fulfillment_item_id: string | null;
  posting_number: string | null;
  offer_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
};

type EventRow = {
  id: string;
  process_id: string | null;
  product_profile_id: string | null;
  marking_code_id: string | null;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  source: string;
  details_redacted: Record<string, unknown>;
  occurred_at: Date | string;
  created_at: Date | string;
};

type EvidenceRow = {
  id: string;
  process_id: string | null;
  product_profile_id: string | null;
  evidence_type: string;
  source: string;
  external_reference: string | null;
  scope_snapshot: Record<string, unknown>;
  observed_at: Date | string;
  details_redacted: Record<string, unknown>;
  verification_status: string;
  verified_by: string | null;
  verified_at: Date | string | null;
  created_at: Date | string;
};

type ConflictRow = {
  conflict_key: string;
  conflict_type: MarkingConflictItem["conflictType"];
  severity: MarkingConflictItem["severity"];
  product_id: string | null;
  profile_id: string | null;
  sku: string | null;
  gtin: string | null;
  field: string | null;
  local_value: string | null;
  external_value: string | null;
  message: string;
  observed_at: Date | string;
};

type BackfillRunRow = {
  id: string;
  status: MarkingProfileBackfillRun["status"];
  source: string;
  summary: MarkingProfileBackfillRun["summary"];
  created_by: string;
  created_at: Date | string;
  applied_by: string | null;
  applied_at: Date | string | null;
};

type BackfillItemRow = {
  id: string;
  product_id: string;
  sku: string | null;
  action: MarkingProfileBackfillItem["action"];
  channel: MarkingProfileBackfillItem["channel"];
  offer_id: string | null;
  external_sku: string | null;
  proposed_requirement: MarkingProfileBackfillItem["proposedRequirement"];
  exact_gtin: string | null;
  errors: string[];
  warnings: string[];
  apply_status: MarkingProfileBackfillItem["applyStatus"];
  applied_profile_id: string | null;
};

type CodePoolRow = {
  id: string;
  trade_item_id: string;
  gtin_snapshot: string;
  fingerprint: string;
  product_skus: string[];
  acquisition_mode: MarkingCodePoolItem["acquisitionMode"];
  import_batch_id: string | null;
  pool_state: MarkingCodePoolItem["poolState"];
  crpt_state: MarkingCodePoolItem["crptState"];
  crpt_status_raw: string | null;
  crpt_checked_at: Date | string | null;
  blocked_reason: string | null;
  label_exposed_at: Date | string | null;
  quarantined_at: Date | string | null;
  revision: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type CodeImportBatchRow = {
  id: string;
  source: string;
  filename: string | null;
  content_type: string | null;
  file_sha256: string;
  file_size_bytes: string;
  expected_gtin: string;
  trade_item_id: string;
  acquisition_mode: MarkingCodeImportBatch["acquisitionMode"];
  status: MarkingCodeImportBatch["status"];
  rows_total: number;
  rows_valid: number;
  rows_duplicate: number;
  rows_rejected: number;
  rows_applied: number;
  rows_race_duplicate: number;
  created_by: string;
  created_at: Date | string;
  expires_at: Date | string;
  applied_by: string | null;
  applied_at: Date | string | null;
  error_summary: Record<string, unknown>;
};

type CodeImportRowRow = {
  id: string;
  row_number: number;
  gtin: string | null;
  fingerprint: string | null;
  validation_status: MarkingCodeImportRow["validationStatus"];
  error_codes: string[];
  applied_code_id: string | null;
  created_at: Date | string;
  scrubbed_at: Date | string | null;
};

type JitCandidateRow = {
  fulfillment_item_id: string;
  fulfillment_order_id: string;
  source_channel: MarkingJitCandidate["sourceChannel"];
  external_posting_number: string | null;
  source_status: string;
  offer_id: string | null;
  product_id: string;
  sku: string | null;
  quantity: number;
  exemplar_flow_available: boolean | null;
  product_profile_id: string | null;
  operational_status: MarkingJitCandidate["operationalStatus"];
  profile_verification_status: MarkingJitCandidate["profileVerificationStatus"];
  production_mode: MarkingJitCandidate["productionMode"];
  fulfillment_marking_mode: MarkingJitCandidate["fulfillmentMarkingMode"];
  trade_item_id: string | null;
  gtin: string | null;
  warehouse_id: string;
  warehouse_name: string;
  warehouse_type: MarkingJitCandidate["warehouseType"];
  blank_product_id: string | null;
  blank_quantity: number;
  decoration_slug: string;
  decoration_made_at: MarkingJitCandidate["decorationMadeAt"];
  decoration_quantity: number;
  available_code_count: number;
  active_assignment_count: number;
  unassigned_quantity: number;
  can_prepare: boolean;
  prepare_blocker: string | null;
  updated_at: Date | string;
};

type AssignmentRow = {
  id: string;
  fulfillment_item_id: string;
  fulfillment_order_id: string;
  source_channel: MarkingAssignmentListItem["sourceChannel"];
  external_posting_number: string | null;
  source_status: string;
  offer_id: string | null;
  product_id: string;
  sku: string | null;
  item_quantity: number;
  unit_ordinal: number;
  product_profile_id: string;
  gtin_snapshot: string;
  assignment_status: MarkingAssignmentListItem["assignmentStatus"];
  assignment_revision: string;
  assigned_by: string;
  assigned_at: Date | string;
  released_at: Date | string | null;
  release_reason: string | null;
  completed_at: Date | string | null;
  marking_unit_id: string;
  internal_serial: string;
  unit_state: MarkingAssignmentListItem["unitState"];
  custody_state: string;
  warehouse_id: string;
  warehouse_name: string | null;
  code_binding_id: string;
  binding_status: MarkingAssignmentListItem["bindingStatus"];
  label_state: MarkingAssignmentListItem["labelState"];
  template_version: string | null;
  render_count: number;
  print_confirmed_count: number;
  marking_code_id: string;
  code_fingerprint: string;
  code_pool_state: MarkingAssignmentListItem["codePoolState"];
  crpt_state: MarkingAssignmentListItem["crptState"];
  process_id: string | null;
  process_status: MarkingAssignmentListItem["processStatus"];
  current_step: string | null;
  next_action: string | null;
  last_error_code: string | null;
  last_event_type: string | null;
  last_event_at: Date | string | null;
  ozon_state: MarkingAssignmentListItem["ozonState"];
  can_render_label: boolean;
  can_reprint_label: boolean;
  can_confirm_applied: boolean;
  can_cancel: boolean;
  can_validate_ozon: boolean;
  can_submit_ozon: boolean;
  shipping_blocker: string;
  created_at: Date | string;
  updated_at: Date | string;
};

export class PostgresMarkingReadRepository {
  constructor(private readonly query: DatabaseQueryExecutor = queryServerDatabase) {}

  async listReadiness(options: {
    limit: number;
    cursor?: string | null;
    readinessStatus?: MarkingReadinessStatus;
    verificationStatus?: MarkingVerificationStatus;
    requiresMarking?: boolean;
    search?: string;
    channel?: "ozon_fbs" | "komui";
    conflictsOnly?: boolean;
  }): Promise<CursorPage<MarkingReadinessItem>> {
    const cursor = decodeMarkingCursor(options.cursor, "readiness");
    const values: unknown[] = [];
    const filters: string[] = [];
    if (options.readinessStatus) {
      values.push(options.readinessStatus);
      filters.push(`readiness.readiness_status = $${values.length}`);
    }
    if (options.verificationStatus) {
      values.push(options.verificationStatus);
      filters.push(`readiness.profile_verification_status = $${values.length}`);
    }
    if (options.requiresMarking !== undefined) {
      values.push(options.requiresMarking);
      filters.push(`readiness.requires_marking = $${values.length}`);
    }
    if (options.search) {
      values.push(`%${escapeLike(options.search)}%`);
      filters.push(`(
        readiness.sku ILIKE $${values.length} ESCAPE '\\'
        OR readiness.offer_id ILIKE $${values.length} ESCAPE '\\'
        OR readiness.ozon_sku ILIKE $${values.length} ESCAPE '\\'
        OR readiness.gtin ILIKE $${values.length} ESCAPE '\\'
        OR readiness.design ILIKE $${values.length} ESCAPE '\\'
        OR readiness.category ILIKE $${values.length} ESCAPE '\\'
      )`);
    }
    if (options.channel) {
      values.push(options.channel);
      filters.push(`readiness.channel = $${values.length}`);
    }
    if (options.conflictsOnly) {
      filters.push(`readiness.conflict_count > 0`);
    }
    if (cursor) {
      values.push(cursor.timestamp, cursor.id);
      filters.push(
        `(readiness.created_at, readiness.product_id) < `
        + `($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
      );
    }
    values.push(options.limit + 1);

    const result = await this.query<ReadinessRow>(
      `
        WITH evidence_counts AS (
          SELECT
            evidence.product_profile_id,
            count(*) FILTER (
              WHERE evidence.verification_status = 'verified'
            ) AS verified_evidence_count,
            count(*) FILTER (
              WHERE evidence.verification_status = 'verified'
                AND evidence.evidence_type = 'product_profile_mapping'
            ) AS product_mapping_count,
            count(*) FILTER (
              WHERE evidence.verification_status = 'verified'
                AND evidence.evidence_type = 'shared_trade_item_mapping'
            ) AS shared_mapping_count
          FROM public.merch_marking_evidence AS evidence
          WHERE evidence.product_profile_id IS NOT NULL
          GROUP BY evidence.product_profile_id
        ),
        trade_profile_counts AS (
          SELECT profile.trade_item_id, count(*) AS active_verified_count
          FROM public.merch_marking_product_profiles AS profile
          WHERE profile.trade_item_id IS NOT NULL
            AND profile.archived_at IS NULL
            AND profile.requires_marking
            AND profile.verification_status = 'verified'
            AND profile.operational_status = 'enabled'
          GROUP BY profile.trade_item_id
        ),
        latest_ozon_requirement AS (
          SELECT DISTINCT ON (item.offer_id)
            item.offer_id,
            item.marking_requirement,
            item.updated_at
          FROM public.merch_fulfillment_order_items AS item
          JOIN public.merch_fulfillment_orders AS fulfillment_order
            ON fulfillment_order.id = item.fulfillment_order_id
          WHERE fulfillment_order.source_channel = 'ozon_fbs'
            AND item.source_active
            AND item.offer_id IS NOT NULL
          ORDER BY item.offer_id, item.updated_at DESC, item.id DESC
        ),
        sku_gtin_conflicts AS (
          SELECT
            coalesce(profile_channel.external_sku, profile_channel.offer_id)
              AS seller_sku
          FROM public.merch_marking_product_profile_channels AS profile_channel
          JOIN public.merch_marking_product_profiles AS active_profile
            ON active_profile.id = profile_channel.product_profile_id
           AND active_profile.archived_at IS NULL
          JOIN public.merch_marking_trade_items AS mapped_trade_item
            ON mapped_trade_item.id = active_profile.trade_item_id
          WHERE profile_channel.is_enabled
            AND coalesce(
              profile_channel.external_sku,
              profile_channel.offer_id
            ) IS NOT NULL
          GROUP BY coalesce(
            profile_channel.external_sku,
            profile_channel.offer_id
          )
          HAVING count(DISTINCT mapped_trade_item.gtin) > 1
        ),
        readiness AS (
          SELECT
            profile.id AS profile_id,
            profile.product_id,
            product.sku,
            coalesce(channel.offer_id, product.sku) AS offer_id,
            product.ozon_sku::text AS ozon_sku,
            channel.external_product_id,
            channel.channel,
            category.name AS category,
            fabric.name AS fabric,
            color.name AS color,
            size.name AS size,
            design.name AS design,
            profile.requires_marking,
            coalesce(profile.marking_requirement, 'unknown') AS marking_requirement,
            profile.marking_requirement_source,
            profile.marking_requirement_observed_at,
            profile.production_mode,
            profile.fulfillment_marking_mode,
            profile.verification_status AS profile_verification_status,
            profile.operational_status,
            profile.operational_status_reason,
            profile.revision,
            trade_item.id AS trade_item_id,
            trade_item.gtin,
            trade_item.product_group,
            trade_item.national_catalog_card_id,
            trade_item.national_catalog_status,
            trade_item.verification_status AS trade_item_verification_status,
            coalesce(evidence.verified_evidence_count, 0)::text
              AS verified_evidence_count,
            (
              CASE
                WHEN trade_item.declared_color IS NOT NULL
                  AND color.name IS NOT NULL
                  AND getomerch_marking.normalized_attribute(trade_item.declared_color)
                    <> getomerch_marking.normalized_attribute(color.name)
                  THEN 1 ELSE 0
              END
              + CASE
                WHEN trade_item.declared_size_int IS NOT NULL
                  AND size.name IS NOT NULL
                  AND getomerch_marking.normalized_attribute(trade_item.declared_size_int)
                    <> getomerch_marking.normalized_attribute(size.name)
                  THEN 1 ELSE 0
              END
              + CASE
                WHEN ozon.marking_requirement IS NOT NULL
                  AND ozon.marking_requirement <> 'unknown'
                  AND profile.marking_requirement <> 'unknown'
                  AND ozon.marking_requirement <> profile.marking_requirement
                  THEN 1 ELSE 0
              END
              + CASE
                WHEN sku_conflict.seller_sku IS NOT NULL THEN 1 ELSE 0
              END
            )::integer AS conflict_count,
            CASE
              WHEN profile.id IS NULL THEN 'blocked'
              WHEN profile.marking_requirement = 'unknown' THEN 'blocked'
              WHEN profile.marking_requirement = 'not_required' THEN 'not_required'
              WHEN profile.operational_status <> 'enabled' THEN 'blocked'
              WHEN profile.verification_status <> 'verified' THEN 'blocked'
              WHEN trade_item.id IS NULL THEN 'blocked'
              WHEN trade_item.archived_at IS NOT NULL THEN 'blocked'
              WHEN trade_item.verification_status <> 'verified' THEN 'blocked'
              WHEN coalesce(evidence.product_mapping_count, 0) < 1 THEN 'blocked'
              WHEN coalesce(trade_count.active_verified_count, 0) > 1
                AND coalesce(evidence.shared_mapping_count, 0) < 1
                THEN 'blocked'
              WHEN (
                (trade_item.declared_color IS NOT NULL
                  AND color.name IS NOT NULL
                  AND getomerch_marking.normalized_attribute(trade_item.declared_color)
                    <> getomerch_marking.normalized_attribute(color.name))
                OR
                (trade_item.declared_size_int IS NOT NULL
                  AND size.name IS NOT NULL
                  AND getomerch_marking.normalized_attribute(trade_item.declared_size_int)
                    <> getomerch_marking.normalized_attribute(size.name))
                OR
                (ozon.marking_requirement IS NOT NULL
                  AND ozon.marking_requirement <> 'unknown'
                  AND profile.marking_requirement <> 'unknown'
                  AND ozon.marking_requirement <> profile.marking_requirement)
                OR sku_conflict.seller_sku IS NOT NULL
              ) THEN 'blocked'
              ELSE 'ready'
            END AS readiness_status,
            array_remove(ARRAY[
              CASE WHEN profile.id IS NULL THEN 'profile_missing' END,
              CASE
                WHEN profile.id IS NOT NULL
                  AND profile.marking_requirement = 'unknown'
                  THEN 'marking_requirement_unknown'
              END,
              CASE
                WHEN profile.marking_requirement = 'required'
                  AND profile.operational_status = 'draft'
                  THEN 'profile_not_enabled'
              END,
              CASE
                WHEN profile.marking_requirement = 'required'
                  AND profile.operational_status = 'paused'
                  THEN 'profile_paused'
              END,
              CASE
                WHEN profile.marking_requirement = 'required'
                  AND profile.verification_status <> 'verified'
                  THEN 'profile_not_verified'
              END,
              CASE
                WHEN profile.marking_requirement = 'required' AND trade_item.id IS NULL
                  THEN 'trade_item_missing'
              END,
              CASE
                WHEN profile.marking_requirement = 'required'
                  AND trade_item.id IS NOT NULL
                  AND (
                    trade_item.archived_at IS NOT NULL
                    OR trade_item.verification_status <> 'verified'
                  )
                  THEN 'trade_item_not_verified'
              END,
              CASE
                WHEN profile.marking_requirement = 'required'
                  AND coalesce(evidence.product_mapping_count, 0) < 1
                  THEN 'mapping_evidence_missing'
              END,
              CASE
                WHEN profile.marking_requirement = 'required'
                  AND coalesce(trade_count.active_verified_count, 0) > 1
                  AND coalesce(evidence.shared_mapping_count, 0) < 1
                  THEN 'shared_gtin_evidence_missing'
              END,
              CASE
                WHEN sku_conflict.seller_sku IS NOT NULL
                  THEN 'sku_multiple_gtin'
              END,
              CASE
                WHEN trade_item.declared_color IS NOT NULL
                  AND color.name IS NOT NULL
                  AND getomerch_marking.normalized_attribute(trade_item.declared_color)
                    <> getomerch_marking.normalized_attribute(color.name)
                  THEN 'catalog_color_mismatch'
              END,
              CASE
                WHEN trade_item.declared_size_int IS NOT NULL
                  AND size.name IS NOT NULL
                  AND getomerch_marking.normalized_attribute(trade_item.declared_size_int)
                    <> getomerch_marking.normalized_attribute(size.name)
                  THEN 'catalog_size_mismatch'
              END,
              CASE
                WHEN ozon.marking_requirement IS NOT NULL
                  AND ozon.marking_requirement <> 'unknown'
                  AND profile.marking_requirement <> 'unknown'
                  AND ozon.marking_requirement <> profile.marking_requirement
                  THEN 'ozon_requirement_mismatch'
              END
            ], NULL) AS blocker_reasons,
            array_remove(ARRAY[
              CASE
                WHEN EXISTS (
                  SELECT 1
                  FROM public.merch_marking_trade_item_documents AS document
                  WHERE document.trade_item_id = trade_item.id
                    AND document.archived_at IS NULL
                    AND (
                      document.status <> 'valid'
                      OR document.valid_until < current_date
                    )
                ) THEN 'document_reference_attention'
              END,
              CASE
                WHEN channel.channel = 'ozon_fbs'
                  AND (
                    ozon.marking_requirement IS NULL
                    OR ozon.marking_requirement = 'unknown'
                  )
                  THEN 'ozon_requirement_not_observed'
              END
            ], NULL) AS warnings,
            product.created_at,
            coalesce(profile.updated_at, product.created_at) AS updated_at
          FROM public.merch_products AS product
          LEFT JOIN public.merch_marking_product_profiles AS profile
            ON profile.product_id = product.id
           AND profile.archived_at IS NULL
          LEFT JOIN LATERAL (
            SELECT
              profile_channel.channel,
              profile_channel.offer_id,
              profile_channel.external_product_id,
              profile_channel.external_sku
            FROM public.merch_marking_product_profile_channels AS profile_channel
            WHERE profile_channel.product_profile_id = profile.id
              AND profile_channel.is_enabled
            ORDER BY
              CASE WHEN profile_channel.channel = 'ozon_fbs' THEN 0 ELSE 1 END,
              profile_channel.id
            LIMIT 1
          ) AS channel ON true
          LEFT JOIN public.merch_product_categories AS category
            ON category.id = product.category_id
          LEFT JOIN public.merch_fabric_types AS fabric
            ON fabric.id = product.fabric_id
          LEFT JOIN public.merch_colors AS color ON color.id = product.color_id
          LEFT JOIN public.merch_sizes AS size ON size.id = product.size_id
          LEFT JOIN public.merch_designs AS design ON design.id = product.design_id
          LEFT JOIN public.merch_marking_trade_items AS trade_item
            ON trade_item.id = profile.trade_item_id
          LEFT JOIN evidence_counts AS evidence
            ON evidence.product_profile_id = profile.id
          LEFT JOIN trade_profile_counts AS trade_count
            ON trade_count.trade_item_id = profile.trade_item_id
          LEFT JOIN latest_ozon_requirement AS ozon
            ON ozon.offer_id = coalesce(channel.offer_id, product.sku)
          LEFT JOIN sku_gtin_conflicts AS sku_conflict
            ON sku_conflict.seller_sku = coalesce(
              channel.external_sku,
              channel.offer_id
            )
          WHERE NOT product.is_blank
        )
        SELECT
          readiness.profile_id,
          readiness.product_id,
          readiness.sku,
          readiness.offer_id,
          readiness.ozon_sku,
          readiness.external_product_id,
          readiness.channel,
          readiness.category,
          readiness.fabric,
          readiness.color,
          readiness.size,
          readiness.design,
          readiness.requires_marking,
          readiness.marking_requirement,
          readiness.marking_requirement_source,
          readiness.marking_requirement_observed_at,
          readiness.production_mode,
          readiness.fulfillment_marking_mode,
          readiness.profile_verification_status,
          readiness.operational_status,
          readiness.operational_status_reason,
          readiness.revision,
          readiness.trade_item_id,
          readiness.gtin,
          readiness.product_group,
          readiness.national_catalog_card_id,
          readiness.national_catalog_status,
          readiness.trade_item_verification_status,
          readiness.verified_evidence_count,
          readiness.conflict_count,
          readiness.readiness_status,
          readiness.blocker_reasons,
          readiness.warnings,
          readiness.created_at,
          readiness.updated_at
        FROM readiness
        ${whereClause(filters)}
        ORDER BY readiness.created_at DESC, readiness.product_id DESC
        LIMIT $${values.length}
      `,
      values,
    );
    return pageRows(
      result.rows,
      options.limit,
      (row) => mapReadiness(row),
      (row) => encodeMarkingCursor("readiness", toIso(row.created_at), row.product_id),
    );
  }

  async listConflicts(options: {
    limit: number;
    severity?: MarkingConflictItem["severity"];
    conflictType?: MarkingConflictItem["conflictType"];
  }): Promise<MarkingConflictItem[]> {
    const values: unknown[] = [];
    const filters: string[] = [];
    if (options.severity) {
      values.push(options.severity);
      filters.push(`conflict.severity = $${values.length}`);
    }
    if (options.conflictType) {
      values.push(options.conflictType);
      filters.push(`conflict.conflict_type = $${values.length}`);
    }
    values.push(options.limit);
    const result = await this.query<ConflictRow>(
      `
        WITH latest_ozon_requirement AS (
          SELECT DISTINCT ON (item.offer_id)
            item.offer_id,
            item.marking_requirement,
            item.updated_at
          FROM public.merch_fulfillment_order_items AS item
          JOIN public.merch_fulfillment_orders AS fulfillment_order
            ON fulfillment_order.id = item.fulfillment_order_id
          WHERE fulfillment_order.source_channel = 'ozon_fbs'
            AND item.source_active
            AND item.offer_id IS NOT NULL
          ORDER BY item.offer_id, item.updated_at DESC, item.id DESC
        ),
        shared_trade_conflicts AS (
          SELECT
            profile.trade_item_id,
            count(DISTINCT getomerch_marking.normalized_attribute(color.name))
              FILTER (WHERE color.name IS NOT NULL) AS color_count,
            count(DISTINCT getomerch_marking.normalized_attribute(size.name))
              FILTER (WHERE size.name IS NOT NULL) AS size_count,
            max(profile.updated_at) AS observed_at
          FROM public.merch_marking_product_profiles AS profile
          JOIN public.merch_products AS product ON product.id = profile.product_id
          LEFT JOIN public.merch_colors AS color ON color.id = product.color_id
          LEFT JOIN public.merch_sizes AS size ON size.id = product.size_id
          WHERE profile.trade_item_id IS NOT NULL
            AND profile.archived_at IS NULL
          GROUP BY profile.trade_item_id
          HAVING
            count(DISTINCT getomerch_marking.normalized_attribute(color.name))
              FILTER (WHERE color.name IS NOT NULL) > 1
            OR count(DISTINCT getomerch_marking.normalized_attribute(size.name))
              FILTER (WHERE size.name IS NOT NULL) > 1
        ),
        sku_gtin_conflicts AS (
          SELECT
            coalesce(channel.external_sku, channel.offer_id) AS seller_sku,
            max(channel.updated_at) AS observed_at
          FROM public.merch_marking_product_profile_channels AS channel
          JOIN public.merch_marking_product_profiles AS profile
            ON profile.id = channel.product_profile_id
           AND profile.archived_at IS NULL
          JOIN public.merch_marking_trade_items AS trade_item
            ON trade_item.id = profile.trade_item_id
          WHERE channel.is_enabled
            AND coalesce(channel.external_sku, channel.offer_id) IS NOT NULL
          GROUP BY coalesce(channel.external_sku, channel.offer_id)
          HAVING count(DISTINCT trade_item.gtin) > 1
        ),
        conflict AS (
          SELECT
            concat('catalog-color:', profile.id) AS conflict_key,
            'catalog_attribute_mismatch'::text AS conflict_type,
            'blocking'::text AS severity,
            product.id AS product_id,
            profile.id AS profile_id,
            product.sku,
            trade_item.gtin,
            'color'::text AS field,
            color.name AS local_value,
            trade_item.declared_color AS external_value,
            'Цвет варианта не совпадает с данными Национального каталога'::text
              AS message,
            greatest(profile.updated_at, trade_item.updated_at) AS observed_at
          FROM public.merch_marking_product_profiles AS profile
          JOIN public.merch_products AS product ON product.id = profile.product_id
          JOIN public.merch_marking_trade_items AS trade_item
            ON trade_item.id = profile.trade_item_id
          LEFT JOIN public.merch_colors AS color ON color.id = product.color_id
          WHERE profile.archived_at IS NULL
            AND trade_item.declared_color IS NOT NULL
            AND color.name IS NOT NULL
            AND getomerch_marking.normalized_attribute(trade_item.declared_color)
              <> getomerch_marking.normalized_attribute(color.name)

          UNION ALL

          SELECT
            concat('sku-multiple-gtin:', profile.id),
            'sku_multiple_gtin'::text,
            'blocking'::text,
            product.id,
            profile.id,
            product.sku,
            trade_item.gtin,
            'external_sku'::text,
            sku_conflict.seller_sku,
            trade_item.gtin,
            'Один внешний SKU связан с несколькими активными GTIN'::text,
            sku_conflict.observed_at
          FROM sku_gtin_conflicts AS sku_conflict
          JOIN public.merch_marking_product_profile_channels AS channel
            ON coalesce(channel.external_sku, channel.offer_id)
              = sku_conflict.seller_sku
           AND channel.is_enabled
          JOIN public.merch_marking_product_profiles AS profile
            ON profile.id = channel.product_profile_id
           AND profile.archived_at IS NULL
          JOIN public.merch_products AS product ON product.id = profile.product_id
          JOIN public.merch_marking_trade_items AS trade_item
            ON trade_item.id = profile.trade_item_id

          UNION ALL

          SELECT
            concat('catalog-size:', profile.id),
            'catalog_attribute_mismatch'::text,
            'blocking'::text,
            product.id,
            profile.id,
            product.sku,
            trade_item.gtin,
            'size_int'::text,
            size.name,
            trade_item.declared_size_int,
            'Размер варианта не совпадает с данными Национального каталога'::text,
            greatest(profile.updated_at, trade_item.updated_at)
          FROM public.merch_marking_product_profiles AS profile
          JOIN public.merch_products AS product ON product.id = profile.product_id
          JOIN public.merch_marking_trade_items AS trade_item
            ON trade_item.id = profile.trade_item_id
          LEFT JOIN public.merch_sizes AS size ON size.id = product.size_id
          WHERE profile.archived_at IS NULL
            AND trade_item.declared_size_int IS NOT NULL
            AND size.name IS NOT NULL
            AND getomerch_marking.normalized_attribute(trade_item.declared_size_int)
              <> getomerch_marking.normalized_attribute(size.name)

          UNION ALL

          SELECT
            concat('shared-gtin:', profile.id),
            'shared_gtin_incompatible_attributes'::text,
            'blocking'::text,
            product.id,
            profile.id,
            product.sku,
            trade_item.gtin,
            'gtin'::text,
            concat_ws(' / ', color.name, size.name),
            concat(
              'colors=', shared.color_count::text,
              ', sizes=', shared.size_count::text
            ),
            'Один GTIN связан с вариантами, у которых различаются цвет или размер'::text,
            shared.observed_at
          FROM shared_trade_conflicts AS shared
          JOIN public.merch_marking_product_profiles AS profile
            ON profile.trade_item_id = shared.trade_item_id
           AND profile.archived_at IS NULL
          JOIN public.merch_products AS product ON product.id = profile.product_id
          JOIN public.merch_marking_trade_items AS trade_item
            ON trade_item.id = shared.trade_item_id
          LEFT JOIN public.merch_colors AS color ON color.id = product.color_id
          LEFT JOIN public.merch_sizes AS size ON size.id = product.size_id

          UNION ALL

          SELECT
            concat('ozon-requirement:', profile.id),
            'ozon_requirement_mismatch'::text,
            'blocking'::text,
            product.id,
            profile.id,
            product.sku,
            trade_item.gtin,
            'marking_requirement'::text,
            profile.marking_requirement,
            ozon.marking_requirement,
            'Требование маркировки в последнем заказе Ozon не совпадает с профилем'::text,
            ozon.updated_at
          FROM public.merch_marking_product_profiles AS profile
          JOIN public.merch_products AS product ON product.id = profile.product_id
          LEFT JOIN public.merch_marking_product_profile_channels AS channel
            ON channel.product_profile_id = profile.id
           AND channel.channel = 'ozon_fbs'
           AND channel.is_enabled
          LEFT JOIN public.merch_marking_trade_items AS trade_item
            ON trade_item.id = profile.trade_item_id
          JOIN latest_ozon_requirement AS ozon
            ON ozon.offer_id = coalesce(channel.offer_id, product.sku)
          WHERE profile.archived_at IS NULL
            AND profile.marking_requirement <> 'unknown'
            AND ozon.marking_requirement <> 'unknown'
            AND profile.marking_requirement <> ozon.marking_requirement

          UNION ALL

          SELECT
            concat('document:', document.id),
            'document_reference_warning'::text,
            'warning'::text,
            product.id,
            profile.id,
            product.sku,
            trade_item.gtin,
            'document_status'::text,
            document.status,
            document.valid_until::text,
            'Справочный документ требует внимания; это не блокирует готовность'::text,
            document.updated_at
          FROM public.merch_marking_trade_item_documents AS document
          JOIN public.merch_marking_trade_items AS trade_item
            ON trade_item.id = document.trade_item_id
          LEFT JOIN public.merch_marking_product_profiles AS profile
            ON profile.trade_item_id = trade_item.id
           AND profile.archived_at IS NULL
          LEFT JOIN public.merch_products AS product ON product.id = profile.product_id
          WHERE document.archived_at IS NULL
            AND (
              document.status <> 'valid'
              OR document.valid_until < current_date
            )
        )
        SELECT
          conflict.conflict_key,
          conflict.conflict_type,
          conflict.severity,
          conflict.product_id,
          conflict.profile_id,
          conflict.sku,
          conflict.gtin,
          conflict.field,
          conflict.local_value,
          conflict.external_value,
          conflict.message,
          conflict.observed_at
        FROM conflict
        ${whereClause(filters)}
        ORDER BY
          CASE WHEN conflict.severity = 'blocking' THEN 0 ELSE 1 END,
          conflict.observed_at DESC,
          conflict.conflict_key
        LIMIT $${values.length}
      `,
      values,
    );
    return result.rows.map(mapConflict);
  }

  async listProfileBackfills(limit: number): Promise<MarkingProfileBackfillRun[]> {
    const result = await this.query<BackfillRunRow>(
      `
        SELECT
          run.id,
          run.status,
          run.source,
          run.summary,
          run.created_by,
          run.created_at,
          run.applied_by,
          run.applied_at
        FROM public.merch_marking_profile_backfill_runs AS run
        ORDER BY run.created_at DESC, run.id DESC
        LIMIT $1
      `,
      [limit],
    );
    return result.rows.map(mapBackfillRun);
  }

  async getProfileBackfill(runId: string): Promise<MarkingProfileBackfillDetail | null> {
    const runResult = await this.query<BackfillRunRow>(
      `
        SELECT
          run.id,
          run.status,
          run.source,
          run.summary,
          run.created_by,
          run.created_at,
          run.applied_by,
          run.applied_at
        FROM public.merch_marking_profile_backfill_runs AS run
        WHERE run.id = $1::uuid
      `,
      [runId],
    );
    const run = runResult.rows[0];
    if (!run) return null;
    const itemResult = await this.query<BackfillItemRow>(
      `
        SELECT
          item.id,
          item.product_id,
          product.sku,
          item.action,
          item.channel,
          item.offer_id,
          item.external_sku,
          item.proposed_requirement,
          item.exact_gtin,
          item.errors,
          item.warnings,
          item.apply_status,
          item.applied_profile_id
        FROM public.merch_marking_profile_backfill_items AS item
        JOIN public.merch_products AS product ON product.id = item.product_id
        WHERE item.run_id = $1::uuid
        ORDER BY
          CASE item.action
            WHEN 'conflict' THEN 0
            WHEN 'create_draft' THEN 1
            ELSE 2
          END,
          product.sku NULLS LAST,
          item.id
        LIMIT 5000
      `,
      [runId],
    );
    return {
      run: mapBackfillRun(run),
      items: itemResult.rows.map(mapBackfillItem),
    };
  }

  async listProcesses(options: {
    limit: number;
    cursor?: string | null;
    status?: MarkingProcessStatus;
    processType?: string;
    source?: string;
  }): Promise<CursorPage<MarkingProcessListItem>> {
    const cursor = decodeMarkingCursor(options.cursor, "processes");
    const values: unknown[] = [];
    const filters: string[] = [];
    if (options.status) {
      values.push(options.status);
      filters.push(`process.status = $${values.length}`);
    }
    if (options.processType) {
      values.push(options.processType);
      filters.push(`process.process_type = $${values.length}`);
    }
    if (options.source) {
      values.push(options.source);
      filters.push(`process.source = $${values.length}`);
    }
    if (cursor) {
      values.push(cursor.timestamp, cursor.id);
      filters.push(
        `(process.updated_at, process.id) < `
        + `($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
      );
    }
    values.push(options.limit + 1);
    const result = await this.query<ProcessRow>(
      `
        SELECT
          process.id,
          process.process_type,
          process.status,
          process.source,
          process.source_key,
          process.priority,
          process.current_step,
          process.next_action,
          process.deadline_at,
          process.manual_review_reason,
          process.last_error_code,
          process.owner,
          process.version,
          process.fulfillment_order_id,
          process.fulfillment_item_id,
          fulfillment_order.external_posting_number AS posting_number,
          fulfillment_item.offer_id,
          process.created_at,
          process.updated_at,
          process.completed_at
        FROM public.merch_marking_processes AS process
        LEFT JOIN public.merch_fulfillment_orders AS fulfillment_order
          ON fulfillment_order.id = process.fulfillment_order_id
        LEFT JOIN public.merch_fulfillment_order_items AS fulfillment_item
          ON fulfillment_item.id = process.fulfillment_item_id
        ${whereClause(filters)}
        ORDER BY process.updated_at DESC, process.id DESC
        LIMIT $${values.length}
      `,
      values,
    );
    return pageRows(
      result.rows,
      options.limit,
      mapProcess,
      (row) => encodeMarkingCursor("processes", toIso(row.updated_at), row.id),
    );
  }

  async getProcess(processId: string): Promise<MarkingProcessDetail | null> {
    const processResult = await this.query<ProcessRow>(
      `
        SELECT
          process.id,
          process.process_type,
          process.status,
          process.source,
          process.source_key,
          process.priority,
          process.current_step,
          process.next_action,
          process.deadline_at,
          process.manual_review_reason,
          process.last_error_code,
          process.owner,
          process.version,
          process.fulfillment_order_id,
          process.fulfillment_item_id,
          fulfillment_order.external_posting_number AS posting_number,
          fulfillment_item.offer_id,
          process.created_at,
          process.updated_at,
          process.completed_at
        FROM public.merch_marking_processes AS process
        LEFT JOIN public.merch_fulfillment_orders AS fulfillment_order
          ON fulfillment_order.id = process.fulfillment_order_id
        LEFT JOIN public.merch_fulfillment_order_items AS fulfillment_item
          ON fulfillment_item.id = process.fulfillment_item_id
        WHERE process.id = $1::uuid
      `,
      [processId],
    );
    const process = processResult.rows[0];
    if (!process) return null;

    const eventResult = await this.query<EventRow>(
      `
        SELECT
          event.id::text AS id,
          event.process_id,
          event.product_profile_id,
          event.marking_code_id,
          event.event_type,
          event.actor_type,
          event.actor_id,
          event.source,
          event.details_redacted,
          event.occurred_at,
          event.created_at
        FROM public.merch_marking_events AS event
        WHERE event.process_id = $1::uuid
        ORDER BY event.occurred_at DESC, event.id DESC
        LIMIT 100
      `,
      [processId],
    );
    const evidenceResult = await this.query<EvidenceRow>(
      `
        SELECT
          evidence.id,
          evidence.process_id,
          evidence.product_profile_id,
          evidence.evidence_type,
          evidence.source,
          evidence.external_reference,
          evidence.scope_snapshot,
          evidence.observed_at,
          evidence.details_redacted,
          evidence.verification_status,
          evidence.verified_by,
          evidence.verified_at,
          evidence.created_at
        FROM public.merch_marking_evidence AS evidence
        WHERE evidence.process_id = $1::uuid
        ORDER BY evidence.observed_at DESC, evidence.id DESC
        LIMIT 100
      `,
      [processId],
    );
    return {
      process: mapProcess(process),
      events: eventResult.rows.map(mapEvent),
      evidence: evidenceResult.rows.map(mapEvidence),
    };
  }

  async listCodePool(options: {
    limit: number;
    cursor?: string | null;
    poolState?: MarkingCodePoolItem["poolState"];
    gtin?: string;
    search?: string;
  }): Promise<CursorPage<MarkingCodePoolItem> & { summary: MarkingCodePoolSummary }> {
    const cursor = decodeMarkingCursor(options.cursor, "code_pool");
    const values: unknown[] = [];
    const filters: string[] = [];
    if (options.poolState) {
      values.push(options.poolState);
      filters.push(`code.pool_state = $${values.length}`);
    }
    if (options.gtin) {
      values.push(options.gtin);
      filters.push(`code.gtin_snapshot = $${values.length}`);
    }
    if (options.search) {
      values.push(`%${escapeLike(options.search)}%`);
      filters.push(`(
        code.gtin_snapshot ILIKE $${values.length} ESCAPE '\\'
        OR code.fingerprint ILIKE $${values.length} ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM public.merch_marking_product_profiles AS search_profile
          JOIN public.merch_products AS search_product
            ON search_product.id = search_profile.product_id
          WHERE search_profile.trade_item_id = code.trade_item_id
            AND search_profile.archived_at IS NULL
            AND search_product.sku ILIKE $${values.length} ESCAPE '\\'
        )
      )`);
    }
    const summaryValues = [...values];
    const summaryFilters = [...filters];
    if (cursor) {
      values.push(cursor.timestamp, cursor.id);
      filters.push(
        `(code.created_at, code.id) < `
        + `($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
      );
    }
    values.push(options.limit + 1);
    const result = await this.query<CodePoolRow>(
      `
        SELECT
          code.id,
          code.trade_item_id,
          code.gtin_snapshot,
          code.fingerprint,
          coalesce(
            array_agg(DISTINCT product.sku) FILTER (WHERE product.sku IS NOT NULL),
            '{}'::text[]
          ) AS product_skus,
          code.acquisition_mode,
          code.import_batch_id,
          code.pool_state,
          code.crpt_state,
          code.crpt_status_raw,
          code.crpt_checked_at,
          code.blocked_reason,
          code.label_exposed_at,
          code.quarantined_at,
          code.revision,
          code.created_at,
          code.updated_at
        FROM getomerch_marking.code_pool_safe AS code
        LEFT JOIN public.merch_marking_product_profiles AS profile
          ON profile.trade_item_id = code.trade_item_id
         AND profile.archived_at IS NULL
        LEFT JOIN public.merch_products AS product
          ON product.id = profile.product_id
        ${whereClause(filters)}
        GROUP BY
          code.id,
          code.trade_item_id,
          code.gtin_snapshot,
          code.fingerprint,
          code.acquisition_mode,
          code.import_batch_id,
          code.pool_state,
          code.crpt_state,
          code.crpt_status_raw,
          code.crpt_checked_at,
          code.blocked_reason,
          code.label_exposed_at,
          code.quarantined_at,
          code.revision,
          code.created_at,
          code.updated_at
        ORDER BY code.created_at DESC, code.id DESC
        LIMIT $${values.length}
      `,
      values,
    );
    const summaryResult = await this.query<{
      total: string;
      available: string;
      reserved: string;
      bound: string;
      quarantined: string;
      invalid: string;
      terminal: string;
    }>(
      `
        SELECT
          count(*)::text AS total,
          count(*) FILTER (WHERE code.pool_state = 'available')::text AS available,
          count(*) FILTER (WHERE code.pool_state = 'reserved')::text AS reserved,
          count(*) FILTER (WHERE code.pool_state = 'bound')::text AS bound,
          count(*) FILTER (WHERE code.pool_state = 'quarantined')::text AS quarantined,
          count(*) FILTER (WHERE code.pool_state = 'invalid')::text AS invalid,
          count(*) FILTER (
            WHERE code.pool_state IN ('retired', 'replaced')
          )::text AS terminal
        FROM getomerch_marking.code_pool_safe AS code
        ${whereClause(summaryFilters)}
      `,
      summaryValues,
    );
    return {
      ...pageRows(
        result.rows,
        options.limit,
        mapCodePoolItem,
        (row) => encodeMarkingCursor("code_pool", toIso(row.created_at), row.id),
      ),
      summary: mapCodePoolSummary(summaryResult.rows[0]),
    };
  }

  async listCodeImports(options: {
    limit: number;
    cursor?: string | null;
  }): Promise<CursorPage<MarkingCodeImportBatch>> {
    const cursor = decodeMarkingCursor(options.cursor, "code_imports");
    const values: unknown[] = [];
    const filters: string[] = [];
    if (cursor) {
      values.push(cursor.timestamp, cursor.id);
      filters.push(
        `(batch.created_at, batch.id) < `
        + `($1::timestamptz, $2::uuid)`,
      );
    }
    values.push(options.limit + 1);
    const result = await this.query<CodeImportBatchRow>(
      `
        SELECT
          batch.id,
          batch.source,
          batch.filename,
          batch.content_type,
          batch.file_sha256,
          batch.file_size_bytes::text AS file_size_bytes,
          batch.expected_gtin,
          batch.trade_item_id,
          batch.acquisition_mode,
          batch.status,
          batch.rows_total,
          batch.rows_valid,
          batch.rows_duplicate,
          batch.rows_rejected,
          batch.rows_applied,
          batch.rows_race_duplicate,
          batch.created_by,
          batch.created_at,
          batch.expires_at,
          batch.applied_by,
          batch.applied_at,
          batch.error_summary
        FROM getomerch_marking.import_batches_safe AS batch
        ${whereClause(filters)}
        ORDER BY batch.created_at DESC, batch.id DESC
        LIMIT $${values.length}
      `,
      values,
    );
    return pageRows(
      result.rows,
      options.limit,
      mapCodeImportBatch,
      (row) => encodeMarkingCursor("code_imports", toIso(row.created_at), row.id),
    );
  }

  async getCodeImport(batchId: string): Promise<MarkingCodeImportDetail | null> {
    const batch = (
      await this.query<CodeImportBatchRow>(
        `
          SELECT
            batch.id,
            batch.source,
            batch.filename,
            batch.content_type,
            batch.file_sha256,
            batch.file_size_bytes::text AS file_size_bytes,
            batch.expected_gtin,
            batch.trade_item_id,
            batch.acquisition_mode,
            batch.status,
            batch.rows_total,
            batch.rows_valid,
            batch.rows_duplicate,
            batch.rows_rejected,
            batch.rows_applied,
            batch.rows_race_duplicate,
            batch.created_by,
            batch.created_at,
            batch.expires_at,
            batch.applied_by,
            batch.applied_at,
            batch.error_summary
          FROM getomerch_marking.import_batches_safe AS batch
          WHERE batch.id = $1::uuid
        `,
        [batchId],
      )
    ).rows[0];
    if (!batch) return null;
    const rowResult = await this.query<CodeImportRowRow>(
      `
        SELECT
          row_data.id,
          row_data.row_number,
          row_data.gtin,
          row_data.fingerprint,
          row_data.validation_status,
          row_data.error_codes,
          row_data.applied_code_id,
          row_data.created_at,
          row_data.scrubbed_at
        FROM getomerch_marking.import_rows_safe AS row_data
        WHERE row_data.batch_id = $1::uuid
        ORDER BY row_data.row_number
        LIMIT 501
      `,
      [batchId],
    );
    return {
      batch: mapCodeImportBatch(batch),
      rows: rowResult.rows.slice(0, 500).map(mapCodeImportRow),
      rowsTruncated: rowResult.rows.length > 500,
    };
  }

  async listJitCandidates(options: {
    limit: number;
    search?: string;
    fulfillmentItemIds?: readonly string[];
  }): Promise<MarkingJitCandidate[]> {
    const values: unknown[] = [];
    const filters = ["candidate.unassigned_quantity > 0"];
    if (options.search) {
      values.push(`%${escapeLike(options.search)}%`);
      filters.push(`(
        candidate.external_posting_number ILIKE $${values.length} ESCAPE '\\'
        OR candidate.offer_id ILIKE $${values.length} ESCAPE '\\'
        OR candidate.sku ILIKE $${values.length} ESCAPE '\\'
        OR candidate.gtin ILIKE $${values.length} ESCAPE '\\'
      )`);
    }
    if (options.fulfillmentItemIds) {
      if (options.fulfillmentItemIds.length === 0) return [];
      values.push(options.fulfillmentItemIds);
      filters.push(
        `candidate.fulfillment_item_id = ANY($${values.length}::uuid[])`,
      );
    }
    values.push(options.limit);
    const result = await this.query<JitCandidateRow>(
      `
        SELECT
          candidate.fulfillment_item_id,
          candidate.fulfillment_order_id,
          candidate.source_channel,
          candidate.external_posting_number,
          candidate.source_status,
          candidate.offer_id,
          candidate.product_id,
          candidate.sku,
          candidate.quantity,
          candidate.exemplar_flow_available,
          candidate.product_profile_id,
          candidate.operational_status,
          candidate.profile_verification_status,
          candidate.production_mode,
          candidate.fulfillment_marking_mode,
          candidate.trade_item_id,
          candidate.gtin,
          candidate.warehouse_id,
          candidate.warehouse_name,
          candidate.warehouse_type,
          candidate.blank_product_id,
          candidate.blank_quantity,
          candidate.decoration_slug,
          candidate.decoration_made_at,
          candidate.decoration_quantity,
          candidate.available_code_count,
          candidate.active_assignment_count,
          candidate.unassigned_quantity,
          candidate.can_prepare,
          candidate.prepare_blocker,
          candidate.updated_at
        FROM getomerch_marking.jit_candidate_action_safe AS candidate
        ${whereClause(filters)}
        ORDER BY
          candidate.updated_at DESC,
          candidate.fulfillment_item_id,
          candidate.warehouse_id
        LIMIT $${values.length}
      `,
      values,
    );
    return result.rows.map(mapJitCandidate);
  }

  async listAssignments(options: {
    limit: number;
    cursor?: string | null;
    status?: MarkingAssignmentListItem["assignmentStatus"];
    search?: string;
    fulfillmentItemIds?: readonly string[];
  }): Promise<CursorPage<MarkingAssignmentListItem>> {
    const cursor = decodeMarkingCursor(options.cursor, "assignments");
    const values: unknown[] = [];
    const filters: string[] = [];
    if (options.status) {
      values.push(options.status);
      filters.push(`assignment.assignment_status = $${values.length}`);
    }
    if (options.search) {
      values.push(`%${escapeLike(options.search)}%`);
      filters.push(`(
        assignment.external_posting_number ILIKE $${values.length} ESCAPE '\\'
        OR assignment.offer_id ILIKE $${values.length} ESCAPE '\\'
        OR assignment.sku ILIKE $${values.length} ESCAPE '\\'
        OR assignment.gtin_snapshot ILIKE $${values.length} ESCAPE '\\'
        OR assignment.code_fingerprint ILIKE $${values.length} ESCAPE '\\'
      )`);
    }
    if (options.fulfillmentItemIds) {
      if (options.fulfillmentItemIds.length === 0) {
        return {
          items: [],
          page: { nextCursor: null, hasMore: false },
        };
      }
      values.push(options.fulfillmentItemIds);
      filters.push(
        `assignment.fulfillment_item_id = ANY($${values.length}::uuid[])`,
      );
    }
    if (cursor) {
      values.push(cursor.timestamp, cursor.id);
      filters.push(
        `(assignment.updated_at, assignment.id) < `
        + `($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
      );
    }
    values.push(options.limit + 1);
    const result = await this.query<AssignmentRow>(
      `
        SELECT
          assignment.id,
          assignment.fulfillment_item_id,
          assignment.fulfillment_order_id,
          assignment.source_channel,
          assignment.external_posting_number,
          assignment.source_status,
          assignment.offer_id,
          assignment.product_id,
          assignment.sku,
          assignment.item_quantity,
          assignment.unit_ordinal,
          assignment.product_profile_id,
          assignment.gtin_snapshot,
          assignment.assignment_status,
          assignment.assignment_revision,
          assignment.assigned_by,
          assignment.assigned_at,
          assignment.released_at,
          assignment.release_reason,
          assignment.completed_at,
          assignment.marking_unit_id,
          assignment.internal_serial,
          assignment.unit_state,
          assignment.custody_state,
          assignment.warehouse_id,
          assignment.warehouse_name,
          assignment.code_binding_id,
          assignment.binding_status,
          assignment.label_state,
          assignment.template_version,
          assignment.render_count,
          assignment.print_confirmed_count,
          assignment.marking_code_id,
          assignment.code_fingerprint,
          assignment.code_pool_state,
          assignment.crpt_state,
          assignment.process_id,
          assignment.process_status,
          assignment.current_step,
          assignment.next_action,
          assignment.last_error_code,
          assignment.last_event_type,
          assignment.last_event_at,
          assignment.ozon_state,
          assignment.can_render_label,
          assignment.can_reprint_label,
          assignment.can_confirm_applied,
          assignment.can_cancel,
          assignment.can_validate_ozon,
          assignment.can_submit_ozon,
          assignment.shipping_blocker,
          assignment.created_at,
          assignment.updated_at
        FROM getomerch_marking.assignment_action_safe AS assignment
        ${whereClause(filters)}
        ORDER BY assignment.updated_at DESC, assignment.id DESC
        LIMIT $${values.length}
      `,
      values,
    );
    return pageRows(
      result.rows,
      options.limit,
      mapAssignment,
      (row) => encodeMarkingCursor("assignments", toIso(row.updated_at), row.id),
    );
  }

  async listEvents(options: {
    limit: number;
    cursor?: string | null;
    processId?: string;
    eventType?: string;
    source?: string;
  }): Promise<CursorPage<MarkingEventListItem>> {
    const cursor = decodeMarkingCursor(options.cursor, "events");
    const values: unknown[] = [];
    const filters: string[] = [];
    if (options.processId) {
      values.push(options.processId);
      filters.push(`event.process_id = $${values.length}::uuid`);
    }
    if (options.eventType) {
      values.push(options.eventType);
      filters.push(`event.event_type = $${values.length}`);
    }
    if (options.source) {
      values.push(options.source);
      filters.push(`event.source = $${values.length}`);
    }
    if (cursor) {
      values.push(cursor.timestamp, cursor.id);
      filters.push(
        `(event.occurred_at, event.id) < `
        + `($${values.length - 1}::timestamptz, $${values.length}::bigint)`,
      );
    }
    values.push(options.limit + 1);
    const result = await this.query<EventRow>(
      `
        SELECT
          event.id::text AS id,
          event.process_id,
          event.product_profile_id,
          event.marking_code_id,
          event.event_type,
          event.actor_type,
          event.actor_id,
          event.source,
          event.details_redacted,
          event.occurred_at,
          event.created_at
        FROM public.merch_marking_events AS event
        ${whereClause(filters)}
        ORDER BY event.occurred_at DESC, event.id DESC
        LIMIT $${values.length}
      `,
      values,
    );
    return pageRows(
      result.rows,
      options.limit,
      mapEvent,
      (row) => encodeMarkingCursor("events", toIso(row.occurred_at), row.id),
    );
  }
}

export const markingReadRepository = new PostgresMarkingReadRepository();

function whereClause(filters: string[]) {
  return filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
}

function pageRows<Row, Item>(
  rows: Row[],
  limit: number,
  map: (row: Row) => Item,
  cursor: (row: Row) => string,
): CursorPage<Item> {
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(map),
    page: {
      hasMore,
      nextCursor: hasMore && last ? cursor(last) : null,
    },
  };
}

function mapReadiness(row: ReadinessRow): MarkingReadinessItem {
  return {
    profileId: row.profile_id,
    productId: row.product_id,
    sku: row.sku,
    offerId: row.offer_id,
    ozonSku: row.ozon_sku,
    externalProductId: row.external_product_id,
    channel: row.channel,
    category: row.category,
    fabric: row.fabric,
    color: row.color,
    size: row.size,
    design: row.design,
    requiresMarking: row.requires_marking,
    markingRequirement: row.marking_requirement,
    markingRequirementSource: row.marking_requirement_source,
    markingRequirementObservedAt: nullableIso(row.marking_requirement_observed_at),
    productionMode: row.production_mode,
    fulfillmentMarkingMode: row.fulfillment_marking_mode,
    profileVerificationStatus: row.profile_verification_status,
    operationalStatus: row.operational_status,
    operationalStatusReason: row.operational_status_reason,
    revision: row.revision == null ? null : Number(row.revision),
    tradeItemId: row.trade_item_id,
    gtin: row.gtin,
    productGroup: row.product_group,
    nationalCatalogCardId: row.national_catalog_card_id,
    nationalCatalogStatus: row.national_catalog_status,
    tradeItemVerificationStatus: row.trade_item_verification_status,
    verifiedEvidenceCount: Number(row.verified_evidence_count),
    conflictCount: Number(row.conflict_count),
    readinessStatus: row.readiness_status,
    blockerReasons: row.blocker_reasons ?? [],
    warnings: row.warnings ?? [],
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapProcess(row: ProcessRow): MarkingProcessListItem {
  return {
    id: row.id,
    processType: row.process_type,
    status: row.status,
    source: row.source,
    sourceKey: row.source_key,
    priority: row.priority,
    currentStep: row.current_step,
    nextAction: row.next_action,
    deadlineAt: nullableIso(row.deadline_at),
    manualReviewReason: row.manual_review_reason,
    lastErrorCode: row.last_error_code,
    owner: row.owner,
    version: Number(row.version),
    fulfillmentOrderId: row.fulfillment_order_id,
    fulfillmentItemId: row.fulfillment_item_id,
    postingNumber: row.posting_number,
    offerId: row.offer_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    completedAt: nullableIso(row.completed_at),
  };
}

function mapEvent(row: EventRow): MarkingEventListItem {
  return {
    id: row.id,
    processId: row.process_id,
    productProfileId: row.product_profile_id,
    markingCodeId: row.marking_code_id,
    eventType: row.event_type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    source: row.source,
    details: row.details_redacted,
    occurredAt: toIso(row.occurred_at),
    createdAt: toIso(row.created_at),
  };
}

function mapEvidence(row: EvidenceRow): MarkingEvidenceListItem {
  return {
    id: row.id,
    processId: row.process_id,
    productProfileId: row.product_profile_id,
    evidenceType: row.evidence_type,
    source: row.source,
    externalReference: row.external_reference,
    scope: row.scope_snapshot,
    observedAt: toIso(row.observed_at),
    details: row.details_redacted,
    verificationStatus: row.verification_status,
    verifiedBy: row.verified_by,
    verifiedAt: nullableIso(row.verified_at),
    createdAt: toIso(row.created_at),
  };
}

function mapConflict(row: ConflictRow): MarkingConflictItem {
  return {
    conflictKey: row.conflict_key,
    conflictType: row.conflict_type,
    severity: row.severity,
    productId: row.product_id,
    profileId: row.profile_id,
    sku: row.sku,
    gtin: row.gtin,
    field: row.field,
    localValue: row.local_value,
    externalValue: row.external_value,
    message: row.message,
    observedAt: toIso(row.observed_at),
  };
}

function mapBackfillRun(row: BackfillRunRow): MarkingProfileBackfillRun {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    summary: row.summary ?? { total: 0 },
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    appliedBy: row.applied_by,
    appliedAt: nullableIso(row.applied_at),
  };
}

function mapBackfillItem(row: BackfillItemRow): MarkingProfileBackfillItem {
  return {
    id: row.id,
    productId: row.product_id,
    sku: row.sku,
    action: row.action,
    channel: row.channel,
    offerId: row.offer_id,
    externalSku: row.external_sku,
    proposedRequirement: row.proposed_requirement,
    exactGtin: row.exact_gtin,
    errors: row.errors ?? [],
    warnings: row.warnings ?? [],
    applyStatus: row.apply_status,
    appliedProfileId: row.applied_profile_id,
  };
}

function mapCodePoolItem(row: CodePoolRow): MarkingCodePoolItem {
  return {
    id: row.id,
    tradeItemId: row.trade_item_id,
    gtin: row.gtin_snapshot,
    fingerprint: row.fingerprint,
    productSkus: row.product_skus ?? [],
    acquisitionMode: row.acquisition_mode,
    importBatchId: row.import_batch_id,
    poolState: row.pool_state,
    crptState: row.crpt_state,
    crptStatusRaw: row.crpt_status_raw,
    crptCheckedAt: nullableIso(row.crpt_checked_at),
    blockedReason: row.blocked_reason,
    labelExposedAt: nullableIso(row.label_exposed_at),
    quarantinedAt: nullableIso(row.quarantined_at),
    revision: Number(row.revision),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapCodePoolSummary(row: {
  total: string;
  available: string;
  reserved: string;
  bound: string;
  quarantined: string;
  invalid: string;
  terminal: string;
}): MarkingCodePoolSummary {
  return {
    total: Number(row.total),
    available: Number(row.available),
    reserved: Number(row.reserved),
    bound: Number(row.bound),
    quarantined: Number(row.quarantined),
    invalid: Number(row.invalid),
    terminal: Number(row.terminal),
  };
}

function mapCodeImportBatch(row: CodeImportBatchRow): MarkingCodeImportBatch {
  return {
    id: row.id,
    source: row.source,
    filename: row.filename,
    contentType: row.content_type,
    fileSha256: row.file_sha256,
    fileSizeBytes: Number(row.file_size_bytes),
    expectedGtin: row.expected_gtin,
    tradeItemId: row.trade_item_id,
    acquisitionMode: row.acquisition_mode,
    status: row.status,
    rowsTotal: row.rows_total,
    rowsValid: row.rows_valid,
    rowsDuplicate: row.rows_duplicate,
    rowsRejected: row.rows_rejected,
    rowsApplied: row.rows_applied,
    rowsRaceDuplicate: row.rows_race_duplicate,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    appliedBy: row.applied_by,
    appliedAt: nullableIso(row.applied_at),
    summary: row.error_summary ?? {},
  };
}

function mapCodeImportRow(row: CodeImportRowRow): MarkingCodeImportRow {
  return {
    id: row.id,
    rowNumber: row.row_number,
    gtin: row.gtin,
    fingerprint: row.fingerprint,
    validationStatus: row.validation_status,
    errorCodes: row.error_codes ?? [],
    appliedCodeId: row.applied_code_id,
    createdAt: toIso(row.created_at),
    scrubbedAt: nullableIso(row.scrubbed_at),
  };
}

function mapJitCandidate(row: JitCandidateRow): MarkingJitCandidate {
  return {
    fulfillmentItemId: row.fulfillment_item_id,
    fulfillmentOrderId: row.fulfillment_order_id,
    sourceChannel: row.source_channel,
    postingNumber: row.external_posting_number,
    sourceStatus: row.source_status,
    offerId: row.offer_id,
    productId: row.product_id,
    sku: row.sku,
    quantity: row.quantity,
    exemplarFlowAvailable: row.exemplar_flow_available,
    productProfileId: row.product_profile_id,
    operationalStatus: row.operational_status,
    profileVerificationStatus: row.profile_verification_status,
    productionMode: row.production_mode,
    fulfillmentMarkingMode: row.fulfillment_marking_mode,
    tradeItemId: row.trade_item_id,
    gtin: row.gtin,
    warehouseId: row.warehouse_id,
    warehouseName: row.warehouse_name,
    warehouseType: row.warehouse_type,
    blankProductId: row.blank_product_id,
    blankQuantity: row.blank_quantity,
    decorationSlug: row.decoration_slug,
    decorationMadeAt: row.decoration_made_at,
    decorationQuantity: row.decoration_quantity,
    availableCodeCount: row.available_code_count,
    activeAssignmentCount: row.active_assignment_count,
    unassignedQuantity: row.unassigned_quantity,
    canPrepare: row.can_prepare,
    prepareBlocker: row.prepare_blocker,
    updatedAt: toIso(row.updated_at),
  };
}

function mapAssignment(row: AssignmentRow): MarkingAssignmentListItem {
  return {
    id: row.id,
    fulfillmentItemId: row.fulfillment_item_id,
    fulfillmentOrderId: row.fulfillment_order_id,
    sourceChannel: row.source_channel,
    postingNumber: row.external_posting_number,
    sourceStatus: row.source_status,
    offerId: row.offer_id,
    productId: row.product_id,
    sku: row.sku,
    itemQuantity: row.item_quantity,
    unitOrdinal: row.unit_ordinal,
    productProfileId: row.product_profile_id,
    gtin: row.gtin_snapshot,
    assignmentStatus: row.assignment_status,
    assignmentRevision: Number(row.assignment_revision),
    assignedBy: row.assigned_by,
    assignedAt: toIso(row.assigned_at),
    releasedAt: nullableIso(row.released_at),
    releaseReason: row.release_reason,
    completedAt: nullableIso(row.completed_at),
    markingUnitId: row.marking_unit_id,
    internalSerial: row.internal_serial,
    unitState: row.unit_state,
    custodyState: row.custody_state,
    warehouseId: row.warehouse_id,
    warehouseName: row.warehouse_name,
    codeBindingId: row.code_binding_id,
    bindingStatus: row.binding_status,
    labelState: row.label_state,
    templateVersion: row.template_version,
    renderCount: row.render_count,
    printConfirmedCount: row.print_confirmed_count,
    markingCodeId: row.marking_code_id,
    codeFingerprint: row.code_fingerprint,
    codePoolState: row.code_pool_state,
    crptState: row.crpt_state,
    processId: row.process_id,
    processStatus: row.process_status,
    currentStep: row.current_step,
    nextAction: row.next_action,
    lastErrorCode: row.last_error_code,
    lastEventType: row.last_event_type,
    lastEventAt: nullableIso(row.last_event_at),
    ozonState: row.ozon_state,
    canRenderLabel: row.can_render_label,
    canReprintLabel: row.can_reprint_label,
    canConfirmApplied: row.can_confirm_applied,
    canCancel: row.can_cancel,
    canValidateOzon: row.can_validate_ozon,
    canSubmitOzon: row.can_submit_ozon,
    shippingBlocker: row.shipping_blocker,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null) {
  return value == null ? null : toIso(value);
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}
