import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";

export type JitAssignmentAccessContext = {
  fulfillmentItemId: string;
  assignmentId?: string;
  warehouseId: string;
  gtin: string;
  offerId: string;
  sourceChannel: "ozon_fbs" | "komui";
};

export type PreparedJitAssignment = {
  assignmentId: string;
  markingUnitId: string;
  codeBindingId: string;
  processId: string;
  unitOrdinal: number;
  assignmentRevision: number;
  gtin: string;
  codeFingerprint: string;
  warehouseId: string;
};

export type LockedJitApplication = {
  assignmentId: string;
  markingUnitId: string;
  codeBindingId: string;
  processId: string;
  finishedProductId: string;
  blankProductId: string;
  warehouseId: string;
  assignmentRevision: number;
  gtin: string;
  offerId: string;
};

export type JitAssignmentTransition = {
  assignmentId: string;
  assignmentStatus?: string;
  assignmentRevision: number;
  unitState: string;
  bindingStatus: string;
  labelState?: string;
  codePoolState: string;
  processStatus: string;
};

export async function getJitCandidateAccessContext(
  query: DatabaseQueryExecutor,
  fulfillmentItemId: string,
  warehouseId: string,
): Promise<JitAssignmentAccessContext | null> {
  const row = (
    await query<{
      fulfillment_item_id: string;
      warehouse_id: string;
      gtin: string | null;
      offer_id: string | null;
      source_channel: "ozon_fbs" | "komui";
    }>(
      `
        SELECT
          candidate.fulfillment_item_id,
          candidate.warehouse_id,
          candidate.gtin,
          candidate.offer_id,
          candidate.source_channel
        FROM getomerch_marking.jit_candidate_safe AS candidate
        WHERE candidate.fulfillment_item_id = $1::uuid
          AND candidate.warehouse_id = $2::uuid
      `,
      [fulfillmentItemId, warehouseId],
    )
  ).rows[0];
  if (!row?.gtin || !row.offer_id) return null;
  return {
    fulfillmentItemId: row.fulfillment_item_id,
    warehouseId: row.warehouse_id,
    gtin: row.gtin,
    offerId: row.offer_id,
    sourceChannel: row.source_channel,
  };
}

export async function getJitAssignmentAccessContext(
  query: DatabaseQueryExecutor,
  assignmentId: string,
): Promise<JitAssignmentAccessContext | null> {
  const row = (
    await query<{
      id: string;
      fulfillment_item_id: string;
      warehouse_id: string;
      gtin_snapshot: string;
      offer_id: string | null;
      source_channel: "ozon_fbs" | "komui";
    }>(
      `
        SELECT
          assignment.id,
          assignment.fulfillment_item_id,
          assignment.warehouse_id,
          assignment.gtin_snapshot,
          assignment.offer_id,
          assignment.source_channel
        FROM getomerch_marking.assignment_safe AS assignment
        WHERE assignment.id = $1::uuid
      `,
      [assignmentId],
    )
  ).rows[0];
  if (!row?.offer_id) return null;
  return {
    assignmentId: row.id,
    fulfillmentItemId: row.fulfillment_item_id,
    warehouseId: row.warehouse_id,
    gtin: row.gtin_snapshot,
    offerId: row.offer_id,
    sourceChannel: row.source_channel,
  };
}

export async function prepareJitAssignment(
  query: DatabaseQueryExecutor,
  input: {
    fulfillmentItemId: string;
    warehouseId: string;
    actorId: string;
  },
): Promise<PreparedJitAssignment> {
  const row = (
    await query<{
      assignment_id: string;
      marking_unit_id: string;
      code_binding_id: string;
      process_id: string;
      unit_ordinal: number;
      assignment_revision: string;
      gtin: string;
      code_fingerprint: string;
      warehouse_id: string;
    }>(
      `
        SELECT
          assignment_id,
          marking_unit_id,
          code_binding_id,
          process_id,
          unit_ordinal,
          assignment_revision,
          gtin,
          code_fingerprint,
          warehouse_id
        FROM getomerch_marking.prepare_jit_assignment($1::uuid, $2::uuid, $3)
      `,
      [input.fulfillmentItemId, input.warehouseId, input.actorId],
    )
  ).rows[0];
  return {
    assignmentId: row.assignment_id,
    markingUnitId: row.marking_unit_id,
    codeBindingId: row.code_binding_id,
    processId: row.process_id,
    unitOrdinal: Number(row.unit_ordinal),
    assignmentRevision: Number(row.assignment_revision),
    gtin: row.gtin,
    codeFingerprint: row.code_fingerprint,
    warehouseId: row.warehouse_id,
  };
}

export async function lockJitAssignmentForApply(
  query: DatabaseQueryExecutor,
  input: {
    assignmentId: string;
    expectedRevision: number;
    actorId: string;
  },
): Promise<LockedJitApplication> {
  const row = (
    await query<{
      assignment_id: string;
      marking_unit_id: string;
      code_binding_id: string;
      process_id: string;
      finished_product_id: string;
      blank_product_id: string;
      warehouse_id: string;
      assignment_revision: string;
      gtin: string;
      offer_id: string;
    }>(
      `
        SELECT
          assignment_id,
          marking_unit_id,
          code_binding_id,
          process_id,
          finished_product_id,
          blank_product_id,
          warehouse_id,
          assignment_revision,
          gtin,
          offer_id
        FROM getomerch_marking.lock_jit_assignment_for_apply(
          $1::uuid,
          $2::bigint,
          $3
        )
      `,
      [input.assignmentId, input.expectedRevision, input.actorId],
    )
  ).rows[0];
  return {
    assignmentId: row.assignment_id,
    markingUnitId: row.marking_unit_id,
    codeBindingId: row.code_binding_id,
    processId: row.process_id,
    finishedProductId: row.finished_product_id,
    blankProductId: row.blank_product_id,
    warehouseId: row.warehouse_id,
    assignmentRevision: Number(row.assignment_revision),
    gtin: row.gtin,
    offerId: row.offer_id,
  };
}

export async function completeJitApplication(
  query: DatabaseQueryExecutor,
  input: {
    assignmentId: string;
    expectedRevision: number;
    stockTransactionId: string;
    actorId: string;
  },
): Promise<JitAssignmentTransition> {
  const row = (
    await query<{
      assignment_id: string;
      assignment_revision: string;
      unit_state: string;
      binding_status: string;
      label_state: string;
      code_pool_state: string;
      process_status: string;
    }>(
      `
        SELECT
          assignment_id,
          assignment_revision,
          unit_state,
          binding_status,
          label_state,
          code_pool_state,
          process_status
        FROM getomerch_marking.complete_jit_application(
          $1::uuid,
          $2::bigint,
          $3::uuid,
          $4
        )
      `,
      [
        input.assignmentId,
        input.expectedRevision,
        input.stockTransactionId,
        input.actorId,
      ],
    )
  ).rows[0];
  return {
    assignmentId: row.assignment_id,
    assignmentRevision: Number(row.assignment_revision),
    unitState: row.unit_state,
    bindingStatus: row.binding_status,
    labelState: row.label_state,
    codePoolState: row.code_pool_state,
    processStatus: row.process_status,
  };
}

export async function cancelJitAssignment(
  query: DatabaseQueryExecutor,
  input: {
    assignmentId: string;
    expectedRevision: number;
    reason: string;
    actorId: string;
  },
): Promise<JitAssignmentTransition> {
  const row = (
    await query<{
      assignment_id: string;
      assignment_status: string;
      assignment_revision: string;
      unit_state: string;
      binding_status: string;
      code_pool_state: string;
      process_status: string;
    }>(
      `
        SELECT
          assignment_id,
          assignment_status,
          assignment_revision,
          unit_state,
          binding_status,
          code_pool_state,
          process_status
        FROM getomerch_marking.cancel_jit_assignment(
          $1::uuid,
          $2::bigint,
          $3,
          $4
        )
      `,
      [
        input.assignmentId,
        input.expectedRevision,
        input.reason,
        input.actorId,
      ],
    )
  ).rows[0];
  return {
    assignmentId: row.assignment_id,
    assignmentStatus: row.assignment_status,
    assignmentRevision: Number(row.assignment_revision),
    unitState: row.unit_state,
    bindingStatus: row.binding_status,
    codePoolState: row.code_pool_state,
    processStatus: row.process_status,
  };
}

export async function enqueueCrptApplicationPreparation(
  query: DatabaseQueryExecutor,
  input: {
    assignmentId: string;
    markingUnitId: string;
    codeBindingId: string;
    gtin: string;
    actorId: string;
    requestId: string;
    requestHash: string;
  },
) {
  const idempotencyKey = `marking-crpt-application:${input.assignmentId}`;
  const dedupeKey = `assignment:${input.assignmentId}`;
  const payload = {
    assignmentId: input.assignmentId,
    markingUnitId: input.markingUnitId,
    codeBindingId: input.codeBindingId,
    gtin: input.gtin,
  };
  const inserted = (
    await query<{ id: string }>(
      `
        INSERT INTO getomerch_jobs.jobs (
          type,
          dedupe_key,
          idempotency_key,
          request_hash,
          payload,
          actor,
          request_id,
          max_attempts
        )
        VALUES (
          'marking_crpt_application_submit',
          $1,
          $2,
          $3,
          $4::jsonb,
          $5,
          $6::uuid,
          5
        )
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id
      `,
      [
        dedupeKey,
        idempotencyKey,
        input.requestHash,
        JSON.stringify(payload),
        input.actorId,
        input.requestId,
      ],
    )
  ).rows[0];
  if (inserted) {
    await query(
      `
        INSERT INTO getomerch_jobs.job_events (job_id, level, event, details)
        VALUES ($1::uuid, 'info', 'queued', $2::jsonb)
      `,
      [
        inserted.id,
        JSON.stringify({
          type: "marking_crpt_application_submit",
          assignmentId: input.assignmentId,
        }),
      ],
    );
    return inserted.id;
  }
  const existing = (
    await query<{ id: string; request_hash: string }>(
      `
        SELECT job.id, job.request_hash
        FROM getomerch_jobs.jobs AS job
        WHERE job.idempotency_key = $1
      `,
      [idempotencyKey],
    )
  ).rows[0];
  if (!existing || existing.request_hash !== input.requestHash) {
    throw new Error("CRPT application job idempotency conflict");
  }
  return existing.id;
}
