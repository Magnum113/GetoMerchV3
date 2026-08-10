import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";

export type SuzPoolForecast = {
  tradeItemId: string;
  gtin: string;
  policyEnabled: boolean;
  minimum: number;
  target: number;
  leadTimeHours: number;
  averageWindowDays: number;
  orderLimit: number;
  policyRevision: number;
  available: number;
  pendingUtilisation: number;
  quarantined: number;
  rejected: number;
  activeDemand: number;
  consumedInWindow: number;
  averageDailyUse: number;
  leadTimeDemand: number;
  inbound: number;
  calculatedTarget: number;
  recommendedQuantity: number;
  poolLow: boolean;
  updatedAt: string;
};

export type SuzCodeOrder = {
  orderId: string;
  orderItemId: string;
  tradeItemId: string;
  gtin: string;
  contour: "sandbox" | "production";
  source: "forecast" | "manual" | "automation";
  status: string;
  itemStatus: string;
  requestedQuantity: number;
  receivedQuantity: number;
  ingestedQuantity: number;
  duplicateQuantity: number;
  rejectedQuantity: number;
  utilisedQuantity: number;
  availableQuantity: number;
  remoteOrderStatus: string | null;
  remoteBufferStatus: string | null;
  remoteAvailableCodes: number | null;
  blockCount: number;
  externalOrderId: string | null;
  expectedCompletionTimeMs: number | null;
  utilisationReceiptId: string | null;
  utilisationState: string | null;
  utilisationCode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  manualReviewReason: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  submittedAt: string | null;
  lastPolledAt: string | null;
  utilisationCheckedAt: string | null;
  completedAt: string | null;
  contractVersion: string;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  alertCodes: string[];
};

export type SuzOrderMaterial = {
  orderId: string;
  orderItemId: string;
  contour: "sandbox" | "production";
  orderStatus: string;
  gtin: string;
  requestedQuantity: number;
  externalOrderId: string | null;
  receivedQuantity: number;
  ingestedQuantity: number;
  utilisedQuantity: number;
  blockCount: number;
  blockIds: string[];
};

export async function listSuzPoolForecasts(query: DatabaseQueryExecutor) {
  const result = await query<ForecastRow>(`
    SELECT trade_item_id, gtin, pool_policy_enabled, pool_minimum,
      pool_target, pool_lead_time_hours, pool_average_window_days,
      suz_order_quantity_limit, pool_policy_revision, available,
      pending_utilisation, quarantined, rejected, active_demand,
      consumed_in_window, average_daily_use, lead_time_demand, inbound,
      calculated_target, recommended_quantity, pool_low, updated_at
    FROM getomerch_marking.suz_pool_forecast_safe
    ORDER BY pool_low DESC, recommended_quantity DESC, gtin
    LIMIT 500
  `);
  return result.rows.map(mapForecast);
}

export async function listSuzOrders(query: DatabaseQueryExecutor, limit = 100) {
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const result = await query<OrderRow>(`
    SELECT order_id, order_item_id, trade_item_id, gtin, contour,
      production_mode, source, status, item_status, requested_quantity,
      received_quantity, ingested_quantity, duplicate_quantity,
      rejected_quantity, utilised_quantity, available_quantity,
      remote_order_status, remote_buffer_status, remote_available_codes,
      block_count, external_order_id, expected_completion_time_ms,
      utilisation_receipt_id, utilisation_state, utilisation_code,
      error_code, error_message, manual_review_reason, approved_by,
      approved_at, submit_started_at, submitted_at, last_polled_at,
      utilisation_checked_at, completed_at, contract_version, revision,
      created_by, created_at, updated_at, alert_codes
    FROM getomerch_marking.suz_code_order_safe
    ORDER BY created_at DESC, order_id DESC
    LIMIT $1
  `, [safeLimit]);
  return result.rows.map(mapOrder);
}

export async function getSuzForecast(query: DatabaseQueryExecutor, tradeItemId: string) {
  const row = (await query<ForecastRow>(`
    SELECT trade_item_id, gtin, pool_policy_enabled, pool_minimum,
      pool_target, pool_lead_time_hours, pool_average_window_days,
      suz_order_quantity_limit, pool_policy_revision, available,
      pending_utilisation, quarantined, rejected, active_demand,
      consumed_in_window, average_daily_use, lead_time_demand, inbound,
      calculated_target, recommended_quantity, pool_low, updated_at
    FROM getomerch_marking.suz_pool_forecast_safe
    WHERE trade_item_id = $1::uuid
  `, [tradeItemId])).rows[0];
  return row ? mapForecast(row) : null;
}

export async function updateSuzPoolPolicy(query: DatabaseQueryExecutor, input: {
  tradeItemId: string;
  expectedRevision: number;
  enabled: boolean;
  minimum: number;
  target: number;
  leadTimeHours: number;
  averageWindowDays: number;
  orderLimit: number;
  actorId: string;
}) {
  const row = (await query<{ trade_item_id: string; policy_revision: string }>(`
    SELECT trade_item_id, policy_revision
    FROM getomerch_marking.update_suz_pool_policy(
      $1::uuid,$2::bigint,$3,$4,$5,$6,$7,$8,$9
    )
  `, [input.tradeItemId, input.expectedRevision, input.enabled,
    input.minimum, input.target, input.leadTimeHours,
    input.averageWindowDays, input.orderLimit, input.actorId])).rows[0];
  return { tradeItemId: row.trade_item_id, policyRevision: Number(row.policy_revision) };
}

export async function createSuzOrderDraft(query: DatabaseQueryExecutor, input: {
  tradeItemId: string;
  quantity: number;
  contour: "sandbox" | "production";
  source: "forecast" | "manual" | "automation";
  idempotencyKey: string;
  forecastSnapshot: Record<string, unknown>;
  actorId: string;
}) {
  const row = (await query<{
    order_id: string; order_item_id: string; order_revision: string; reused: boolean;
  }>(`
    SELECT order_id, order_item_id, order_revision, reused
    FROM getomerch_marking.create_suz_order_draft(
      $1::uuid,$2,$3,$4,$5,$6::jsonb,$7
    )
  `, [input.tradeItemId, input.quantity, input.contour, input.source,
    input.idempotencyKey, JSON.stringify(input.forecastSnapshot), input.actorId])).rows[0];
  return { orderId: row.order_id, orderItemId: row.order_item_id,
    revision: Number(row.order_revision), reused: row.reused };
}

export async function approveSuzOrder(query: DatabaseQueryExecutor, input: {
  orderId: string; expectedRevision: number; actorId: string;
}) {
  const row = (await query<{ order_id: string; order_revision: string; order_status: string }>(`
    SELECT order_id, order_revision, order_status
    FROM getomerch_marking.approve_suz_order($1::uuid,$2::bigint,$3)
  `, [input.orderId, input.expectedRevision, input.actorId])).rows[0];
  return { orderId: row.order_id, revision: Number(row.order_revision), status: row.order_status };
}

export async function cancelSuzOrder(query: DatabaseQueryExecutor, input: {
  orderId: string; expectedRevision: number; reason: string; actorId: string;
}) {
  const row = (await query<{ order_id: string; order_revision: string; order_status: string }>(`
    SELECT order_id, order_revision, order_status
    FROM getomerch_marking.cancel_suz_order($1::uuid,$2::bigint,$3,$4)
  `, [input.orderId, input.expectedRevision, input.reason, input.actorId])).rows[0];
  return { orderId: row.order_id, revision: Number(row.order_revision), status: row.order_status };
}

export async function getSuzOrderMaterial(query: DatabaseQueryExecutor, orderId: string) {
  const row = (await query<MaterialRow>(`
    SELECT order_id, order_item_id, contour, order_status, gtin,
      requested_quantity, external_order_id, received_quantity,
      ingested_quantity, utilised_quantity, block_count, block_ids
    FROM getomerch_marking.get_suz_order_material($1::uuid)
  `, [orderId])).rows[0];
  return row ? mapMaterial(row) : null;
}

export async function recordSuzSubmitStarted(query: DatabaseQueryExecutor, input: {
  orderId: string; requestHash: string; signatureHash: string;
  certificateThumbprint: string; actorId: string;
}) {
  const result = await query<{ revision: string }>(`
    SELECT getomerch_marking.record_suz_submit_started($1::uuid,$2,$3,$4,$5) AS revision
  `, [input.orderId, input.requestHash, input.signatureHash,
    input.certificateThumbprint, input.actorId]);
  return Number(result.rows[0].revision);
}

export async function recordSuzSubmitted(query: DatabaseQueryExecutor, input: {
  orderId: string; omsId: string; externalOrderId: string;
  expectedCompletionTimeMs: number; responseRedacted: Record<string, unknown>;
}) {
  const result = await query<{ status: string }>(`
    SELECT getomerch_marking.record_suz_submitted(
      $1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb
    ) AS status
  `, [input.orderId, input.omsId, input.externalOrderId,
    input.expectedCompletionTimeMs, JSON.stringify(input.responseRedacted)]);
  return result.rows[0].status;
}

export async function recordSuzOrderStatus(query: DatabaseQueryExecutor, input: {
  orderId: string; remoteOrderStatus: string; remoteBufferStatus: string;
  remoteAvailableCodes: number; responseRedacted: Record<string, unknown>;
}) {
  const result = await query<{ status: string }>(`
    SELECT getomerch_marking.record_suz_order_status(
      $1::uuid,$2,$3,$4,$5::jsonb
    ) AS status
  `, [input.orderId, input.remoteOrderStatus, input.remoteBufferStatus,
    input.remoteAvailableCodes, JSON.stringify(input.responseRedacted)]);
  return result.rows[0].status;
}

export async function attachSuzCodeBlock(query: DatabaseQueryExecutor, input: {
  orderItemId: string; importBatchId: string; blockId: string;
  received: number; applied: number; duplicate: number; rejected: number; actorId: string;
}) {
  const row = (await query<{
    order_status: string; received_quantity: number;
    ingested_quantity: number; reused: boolean;
  }>(`
    SELECT order_status, received_quantity, ingested_quantity, reused
    FROM getomerch_marking.attach_suz_code_block(
      $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8
    )
  `, [input.orderItemId, input.importBatchId, input.blockId,
    input.received, input.applied, input.duplicate, input.rejected,
    input.actorId])).rows[0];
  return { status: row.order_status, received: Number(row.received_quantity),
    ingested: Number(row.ingested_quantity), reused: row.reused };
}

export async function confirmSuzUtilisation(query: DatabaseQueryExecutor, input: {
  orderId: string; receiptId: string; state: string; code: number;
  processed: number; total: number; responseRedacted: Record<string, unknown>;
}) {
  const row = (await query<{ order_status: string; released_quantity: number }>(`
    SELECT order_status, released_quantity
    FROM getomerch_marking.confirm_suz_utilisation(
      $1::uuid,$2::uuid,$3,$4,$5,$6,$7::jsonb
    )
  `, [input.orderId, input.receiptId, input.state, input.code,
    input.processed, input.total, JSON.stringify(input.responseRedacted)])).rows[0];
  return { status: row.order_status, released: Number(row.released_quantity) };
}

export async function recordSuzManualReview(query: DatabaseQueryExecutor, input: {
  orderId: string; errorCode: string; errorMessage: string; reason: string;
}) {
  const result = await query<{ status: string }>(`
    SELECT getomerch_marking.record_suz_order_manual_review($1::uuid,$2,$3,$4) AS status
  `, [input.orderId, input.errorCode, input.errorMessage, input.reason]);
  return result.rows[0].status;
}

type ForecastRow = {
  trade_item_id: string; gtin: string; pool_policy_enabled: boolean;
  pool_minimum: number; pool_target: number; pool_lead_time_hours: number;
  pool_average_window_days: number; suz_order_quantity_limit: number;
  pool_policy_revision: string; available: number; pending_utilisation: number;
  quarantined: number; rejected: number; active_demand: number;
  consumed_in_window: number; average_daily_use: string; lead_time_demand: number;
  inbound: number; calculated_target: number; recommended_quantity: number;
  pool_low: boolean; updated_at: Date | string;
};

type OrderRow = {
  order_id: string; order_item_id: string; trade_item_id: string; gtin: string;
  contour: "sandbox" | "production"; production_mode: string;
  source: "forecast" | "manual" | "automation"; status: string; item_status: string;
  requested_quantity: number; received_quantity: number; ingested_quantity: number;
  duplicate_quantity: number; rejected_quantity: number; utilised_quantity: number;
  available_quantity: number; remote_order_status: string | null;
  remote_buffer_status: string | null; remote_available_codes: number | null;
  block_count: number; external_order_id: string | null;
  expected_completion_time_ms: number | null; utilisation_receipt_id: string | null;
  utilisation_state: string | null; utilisation_code: number | null;
  error_code: string | null; error_message: string | null;
  manual_review_reason: string | null; approved_by: string | null;
  approved_at: Date | string | null; submit_started_at: Date | string | null;
  submitted_at: Date | string | null; last_polled_at: Date | string | null;
  utilisation_checked_at: Date | string | null; completed_at: Date | string | null;
  contract_version: string; revision: string; created_by: string;
  created_at: Date | string; updated_at: Date | string; alert_codes: string[];
};

type MaterialRow = {
  order_id: string; order_item_id: string; contour: "sandbox" | "production";
  order_status: string; gtin: string; requested_quantity: number;
  external_order_id: string | null; received_quantity: number;
  ingested_quantity: number; utilised_quantity: number; block_count: number;
  block_ids: string[];
};

function mapForecast(row: ForecastRow): SuzPoolForecast {
  return {
    tradeItemId: row.trade_item_id, gtin: row.gtin,
    policyEnabled: row.pool_policy_enabled, minimum: Number(row.pool_minimum),
    target: Number(row.pool_target), leadTimeHours: Number(row.pool_lead_time_hours),
    averageWindowDays: Number(row.pool_average_window_days),
    orderLimit: Number(row.suz_order_quantity_limit),
    policyRevision: Number(row.pool_policy_revision), available: Number(row.available),
    pendingUtilisation: Number(row.pending_utilisation), quarantined: Number(row.quarantined),
    rejected: Number(row.rejected), activeDemand: Number(row.active_demand),
    consumedInWindow: Number(row.consumed_in_window),
    averageDailyUse: Number(row.average_daily_use), leadTimeDemand: Number(row.lead_time_demand),
    inbound: Number(row.inbound), calculatedTarget: Number(row.calculated_target),
    recommendedQuantity: Number(row.recommended_quantity), poolLow: row.pool_low,
    updatedAt: iso(row.updated_at)!,
  };
}

function mapOrder(row: OrderRow): SuzCodeOrder {
  return {
    orderId: row.order_id, orderItemId: row.order_item_id,
    tradeItemId: row.trade_item_id, gtin: row.gtin, contour: row.contour,
    source: row.source, status: row.status, itemStatus: row.item_status,
    requestedQuantity: Number(row.requested_quantity), receivedQuantity: Number(row.received_quantity),
    ingestedQuantity: Number(row.ingested_quantity), duplicateQuantity: Number(row.duplicate_quantity),
    rejectedQuantity: Number(row.rejected_quantity), utilisedQuantity: Number(row.utilised_quantity),
    availableQuantity: Number(row.available_quantity), remoteOrderStatus: row.remote_order_status,
    remoteBufferStatus: row.remote_buffer_status,
    remoteAvailableCodes: row.remote_available_codes === null ? null : Number(row.remote_available_codes),
    blockCount: Number(row.block_count), externalOrderId: row.external_order_id,
    expectedCompletionTimeMs: row.expected_completion_time_ms === null
      ? null : Number(row.expected_completion_time_ms),
    utilisationReceiptId: row.utilisation_receipt_id, utilisationState: row.utilisation_state,
    utilisationCode: row.utilisation_code === null ? null : Number(row.utilisation_code),
    errorCode: row.error_code, errorMessage: row.error_message,
    manualReviewReason: row.manual_review_reason, approvedBy: row.approved_by,
    approvedAt: iso(row.approved_at), submittedAt: iso(row.submitted_at),
    lastPolledAt: iso(row.last_polled_at), utilisationCheckedAt: iso(row.utilisation_checked_at),
    completedAt: iso(row.completed_at), contractVersion: row.contract_version,
    revision: Number(row.revision), createdBy: row.created_by,
    createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!,
    alertCodes: row.alert_codes ?? [],
  };
}

function mapMaterial(row: MaterialRow): SuzOrderMaterial {
  return {
    orderId: row.order_id, orderItemId: row.order_item_id,
    contour: row.contour, orderStatus: row.order_status, gtin: row.gtin,
    requestedQuantity: Number(row.requested_quantity), externalOrderId: row.external_order_id,
    receivedQuantity: Number(row.received_quantity), ingestedQuantity: Number(row.ingested_quantity),
    utilisedQuantity: Number(row.utilised_quantity), blockCount: Number(row.block_count),
    blockIds: row.block_ids ?? [],
  };
}

function iso(value: Date | string | null) {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
