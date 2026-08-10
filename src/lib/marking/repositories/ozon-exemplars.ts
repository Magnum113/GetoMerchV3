import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";

export type OzonSubmissionBatchStatus =
  | "prepared"
  | "validating"
  | "validation_failed"
  | "validated"
  | "submitting"
  | "polling"
  | "accepted"
  | "partially_rejected"
  | "rejected"
  | "timed_out"
  | "manual_review"
  | "superseded";

export type OzonSubmissionBatch = {
  id: string;
  fulfillmentOrderId: string;
  postingNumber: string;
  postingSnapshotHash: string;
  requestRevision: number;
  supersedesBatchId: string | null;
  operationKind: "initial_set" | "correction";
  status: OzonSubmissionBatchStatus;
  requestHash: string;
  apiContractVersion: string;
  multiBoxQuantity: number;
  attemptCount: number;
  unitCount: number;
  acceptedCount: number;
  rejectedCount: number;
  createdAt: string;
  updatedAt: string;
};

export type OzonSubmissionUnit = {
  id: string;
  batchId: string;
  assignmentId: string;
  assignmentRevision: number;
  productId: number;
  exemplarId: number | null;
  unitOrdinal: number;
  fulfillmentOrderId: string;
  offerId: string | null;
  gtin: string;
  codeFingerprint: string;
  status: string;
  errorCodes: string[];
  errorMessage: string | null;
};

export type OzonSubmissionMaterial = OzonSubmissionUnit & {
  postingNumber: string;
  operationKind: "initial_set" | "correction";
  encryptionKeyVersion: number;
  codeCiphertext: Buffer;
  codeNonce: Buffer;
  codeAuthTag: Buffer;
};

export async function prepareOzonSubmissionBatch(
  query: DatabaseQueryExecutor,
  input: { fulfillmentOrderId: string; actorId: string; forceCorrection: boolean },
) {
  const row = (
    await query<{
      batch_id: string;
      request_revision: number;
      batch_status: OzonSubmissionBatchStatus;
      posting_number: string;
      posting_snapshot_hash: string;
      reused: boolean;
    }>(
      `
        SELECT batch_id, request_revision, batch_status, posting_number,
          posting_snapshot_hash, reused
        FROM getomerch_marking.prepare_ozon_submission_batch($1::uuid, $2, $3)
      `,
      [input.fulfillmentOrderId, input.actorId, input.forceCorrection],
    )
  ).rows[0];
  return {
    batchId: row.batch_id,
    requestRevision: row.request_revision,
    status: row.batch_status,
    postingNumber: row.posting_number,
    postingSnapshotHash: row.posting_snapshot_hash,
    reused: row.reused,
  };
}

export async function getOzonSubmissionBatch(
  query: DatabaseQueryExecutor,
  batchId: string,
): Promise<OzonSubmissionBatch | null> {
  const row = (
    await query<BatchRow>(
      `
        SELECT id, fulfillment_order_id, posting_number, posting_snapshot_hash,
          request_revision, supersedes_batch_id, operation_kind, status,
          request_hash, api_contract_version, multi_box_quantity, attempt_count, unit_count,
          accepted_count, rejected_count, created_at, updated_at
        FROM getomerch_marking.ozon_submission_batch_safe
        WHERE id = $1::uuid
      `,
      [batchId],
    )
  ).rows[0];
  return row ? mapBatch(row) : null;
}

export async function listOzonSubmissionBatches(
  query: DatabaseQueryExecutor,
  limit = 50,
) {
  const rows = await query<BatchRow>(
    `
      SELECT id, fulfillment_order_id, posting_number, posting_snapshot_hash,
        request_revision, supersedes_batch_id, operation_kind, status,
        request_hash, api_contract_version, multi_box_quantity, attempt_count, unit_count,
        accepted_count, rejected_count, created_at, updated_at
      FROM getomerch_marking.ozon_submission_batch_safe
      ORDER BY updated_at DESC, id DESC
      LIMIT $1
    `,
    [Math.max(1, Math.min(100, limit))],
  );
  return rows.rows.map(mapBatch);
}

export async function listOzonSubmissionUnits(
  query: DatabaseQueryExecutor,
  batchId: string,
): Promise<OzonSubmissionUnit[]> {
  const rows = await query<UnitRow>(
    `
      SELECT id, batch_id, assignment_id, assignment_revision,
        ozon_product_id, exemplar_id, unit_ordinal, fulfillment_order_id,
        offer_id, gtin, code_fingerprint, status, error_codes, error_message
      FROM getomerch_marking.ozon_submission_safe
      WHERE batch_id = $1::uuid
      ORDER BY ozon_product_id, unit_ordinal, assignment_id
    `,
    [batchId],
  );
  return rows.rows.map(mapUnit);
}

export async function listOzonOrderAccessUnits(
  query: DatabaseQueryExecutor,
  fulfillmentOrderId: string,
) {
  const rows = await query<{ gtin: string; offer_id: string | null }>(
    `
      SELECT DISTINCT gtin_snapshot AS gtin, offer_id
      FROM getomerch_marking.assignment_action_safe
      WHERE fulfillment_order_id = $1::uuid
        AND assignment_status = 'active'
      ORDER BY gtin_snapshot, offer_id
    `,
    [fulfillmentOrderId],
  );
  return rows.rows.map((row) => ({ gtin: row.gtin, offerId: row.offer_id }));
}

export async function recordOzonExemplarMapping(
  query: DatabaseQueryExecutor,
  input: {
    batchId: string;
    mapping: Array<{ assignmentId: string; exemplarId: number }>;
    multiBoxQuantity: number;
    responseRedacted: Record<string, unknown>;
    actorId: string;
  },
) {
  await query(
    `SELECT getomerch_marking.record_ozon_exemplar_mapping(
      $1::uuid, $2::jsonb, $3::integer, $4::jsonb, $5
    )`,
    [
      input.batchId,
      JSON.stringify(input.mapping.map((item) => ({
        assignment_id: item.assignmentId,
        exemplar_id: item.exemplarId,
      }))),
      input.multiBoxQuantity,
      JSON.stringify(input.responseRedacted),
      input.actorId,
    ],
  );
}

export async function getOzonSubmissionMaterial(
  query: DatabaseQueryExecutor,
  input: { batchId: string; operation: "validate" | "set"; actorId: string },
) {
  const rows = await query<MaterialRow>(
    `
      SELECT posting_number, operation_kind, assignment_id,
        assignment_revision, ozon_product_id, exemplar_id, unit_ordinal,
        encryption_key_version, code_ciphertext, code_nonce, code_auth_tag,
        code_fingerprint, gtin, offer_id
      FROM getomerch_marking.get_ozon_submission_material($1::uuid, $2, $3)
    `,
    [input.batchId, input.operation, input.actorId],
  );
  return rows.rows.map((row): OzonSubmissionMaterial => ({
    id: "",
    batchId: input.batchId,
    assignmentId: row.assignment_id,
    assignmentRevision: Number(row.assignment_revision),
    productId: Number(row.ozon_product_id),
    exemplarId: row.exemplar_id == null ? null : Number(row.exemplar_id),
    unitOrdinal: row.unit_ordinal,
    fulfillmentOrderId: "",
    offerId: row.offer_id,
    gtin: row.gtin,
    codeFingerprint: row.code_fingerprint,
    status: input.operation === "validate" ? "validating" : "submitting",
    errorCodes: [],
    errorMessage: null,
    postingNumber: row.posting_number,
    operationKind: row.operation_kind,
    encryptionKeyVersion: row.encryption_key_version,
    codeCiphertext: row.code_ciphertext,
    codeNonce: row.code_nonce,
    codeAuthTag: row.code_auth_tag,
  }));
}

export async function recordOzonValidation(
  query: DatabaseQueryExecutor,
  input: {
    batchId: string;
    results: Array<{
      assignmentId: string;
      valid: boolean;
      errorCodes: string[];
      errorMessage: string | null;
    }>;
    responseRedacted: Record<string, unknown>;
  },
) {
  const result = await query<{ status: OzonSubmissionBatchStatus }>(
    `SELECT getomerch_marking.record_ozon_validation(
      $1::uuid, $2::jsonb, $3::jsonb
    ) AS status`,
    [
      input.batchId,
      JSON.stringify(input.results.map((item) => ({
        assignment_id: item.assignmentId,
        valid: item.valid,
        error_codes: item.errorCodes,
        error_message: item.errorMessage,
      }))),
      JSON.stringify(input.responseRedacted),
    ],
  );
  return result.rows[0].status;
}

export async function recordOzonSetQueuedForPoll(
  query: DatabaseQueryExecutor,
  input: { batchId: string; requestHash: string; responseRedacted: Record<string, unknown> },
) {
  await query(
    `SELECT getomerch_marking.record_ozon_set_queued_for_poll(
      $1::uuid, $2, $3::jsonb
    )`,
    [input.batchId, input.requestHash, JSON.stringify(input.responseRedacted)],
  );
}

export async function recordOzonPoll(
  query: DatabaseQueryExecutor,
  input: {
    batchId: string;
    remoteStatus: string;
    results: Array<{ exemplarId: number; errorCodes: string[]; errorMessage: string | null }>;
    responseRedacted: Record<string, unknown>;
  },
) {
  const result = await query<{ status: OzonSubmissionBatchStatus }>(
    `SELECT getomerch_marking.record_ozon_poll(
      $1::uuid, $2, $3::jsonb, $4::jsonb
    ) AS status`,
    [
      input.batchId,
      input.remoteStatus,
      JSON.stringify(input.results.map((item) => ({
        exemplar_id: item.exemplarId,
        error_codes: item.errorCodes,
        error_message: item.errorMessage,
      }))),
      JSON.stringify(input.responseRedacted),
    ],
  );
  return result.rows[0].status;
}

export async function recordOzonBatchFailure(
  query: DatabaseQueryExecutor,
  input: { batchId: string; phase: "validate" | "set" | "poll"; errorCode: string; errorMessage: string },
) {
  const result = await query<{ status: OzonSubmissionBatchStatus }>(
    `SELECT getomerch_marking.record_ozon_batch_failure(
      $1::uuid, $2, $3, $4
    ) AS status`,
    [input.batchId, input.phase, input.errorCode, input.errorMessage.slice(0, 1000)],
  );
  return result.rows[0].status;
}

type BatchRow = {
  id: string;
  fulfillment_order_id: string;
  posting_number: string;
  posting_snapshot_hash: string;
  request_revision: number;
  supersedes_batch_id: string | null;
  operation_kind: "initial_set" | "correction";
  status: OzonSubmissionBatchStatus;
  request_hash: string;
  api_contract_version: string;
  multi_box_quantity: number;
  attempt_count: number;
  unit_count: number;
  accepted_count: number;
  rejected_count: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type UnitRow = {
  id: string;
  batch_id: string;
  assignment_id: string;
  assignment_revision: string | number;
  ozon_product_id: string | number;
  exemplar_id: string | number | null;
  unit_ordinal: number;
  fulfillment_order_id: string;
  offer_id: string | null;
  gtin: string;
  code_fingerprint: string;
  status: string;
  error_codes: string[];
  error_message: string | null;
};

type MaterialRow = {
  posting_number: string;
  operation_kind: "initial_set" | "correction";
  assignment_id: string;
  assignment_revision: string | number;
  ozon_product_id: string | number;
  exemplar_id: string | number | null;
  unit_ordinal: number;
  encryption_key_version: number;
  code_ciphertext: Buffer;
  code_nonce: Buffer;
  code_auth_tag: Buffer;
  code_fingerprint: string;
  gtin: string;
  offer_id: string | null;
};

function mapBatch(row: BatchRow): OzonSubmissionBatch {
  return {
    id: row.id,
    fulfillmentOrderId: row.fulfillment_order_id,
    postingNumber: row.posting_number,
    postingSnapshotHash: row.posting_snapshot_hash,
    requestRevision: row.request_revision,
    supersedesBatchId: row.supersedes_batch_id,
    operationKind: row.operation_kind,
    status: row.status,
    requestHash: row.request_hash,
    apiContractVersion: row.api_contract_version,
    multiBoxQuantity: row.multi_box_quantity,
    attemptCount: row.attempt_count,
    unitCount: row.unit_count,
    acceptedCount: row.accepted_count,
    rejectedCount: row.rejected_count,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapUnit(row: UnitRow): OzonSubmissionUnit {
  return {
    id: row.id,
    batchId: row.batch_id,
    assignmentId: row.assignment_id,
    assignmentRevision: Number(row.assignment_revision),
    productId: Number(row.ozon_product_id),
    exemplarId: row.exemplar_id == null ? null : Number(row.exemplar_id),
    unitOrdinal: row.unit_ordinal,
    fulfillmentOrderId: row.fulfillment_order_id,
    offerId: row.offer_id,
    gtin: row.gtin,
    codeFingerprint: row.code_fingerprint,
    status: row.status,
    errorCodes: row.error_codes,
    errorMessage: row.error_message,
  };
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
