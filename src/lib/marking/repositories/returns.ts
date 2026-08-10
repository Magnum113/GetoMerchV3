import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import type { MarkingDocumentStatus } from "@/lib/marking/repositories/documents";
import type { EncryptedMarkingValue } from "@/lib/marking/security/keyring";

export type MarkingReturnCase = {
  id: string;
  sourceReturnId: string;
  sourceReturnItemId: string;
  fulfillmentOrderId: string | null;
  assignmentId: string | null;
  markingUnitId: string | null;
  markingCodeId: string | null;
  postingNumber: string;
  offerId: string | null;
  ozonSku: string | null;
  quantity: number;
  returnKind: string;
  destination: "unknown" | "to_seller" | "to_ozon_fbo" | "lost_destroyed";
  sourceStatus: string;
  processStatus: string;
  paid: boolean | null;
  codeFingerprint: string | null;
  crptState: string | null;
  unitState: string | null;
  custodyState: string | null;
  documentId: string | null;
  documentStatus: MarkingDocumentStatus | null;
  documentRevision: number | null;
  returnConfirmationState: string | null;
  physicalCondition: string | null;
  receivingWarehouseId: string | null;
  receivingWarehouseName: string | null;
  fboIntakeReference: string | null;
  edoDocumentReference: string | null;
  manualReviewReason: string | null;
  detectedAt: string;
  sourceObservedAt: string | null;
  directionConfirmedAt: string | null;
  sellerReceivedAt: string | null;
  fboTransferConfirmedAt: string | null;
  version: number;
  updatedAt: string;
};

export async function upsertOzonReturnCase(
  query: DatabaseQueryExecutor,
  input: {
    sourceReturnId: string;
    sourceReturnItemId: string;
    postingNumber: string;
    offerId: string | null;
    ozonSku: string | null;
    quantity: number;
    returnKind: string;
    sourceStatus: string;
    snapshotHash: string;
    contractVersion: string;
    evidence: Record<string, unknown>;
    observedAt: string | null;
    actorId: string;
  },
) {
  const row = (await query<{
    return_case_id: string;
    case_version: string;
    process_status: string;
    identity_linked: boolean;
  }>(
    `SELECT return_case_id, case_version, process_status, identity_linked
     FROM getomerch_marking.upsert_ozon_return_case(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::timestamptz,$13
     )`,
    [input.sourceReturnId, input.sourceReturnItemId, input.postingNumber,
      input.offerId, input.ozonSku, input.quantity, input.returnKind,
      input.sourceStatus, input.snapshotHash, input.contractVersion,
      JSON.stringify(input.evidence), input.observedAt, input.actorId],
  )).rows[0];
  return {
    id: row.return_case_id,
    version: Number(row.case_version),
    processStatus: row.process_status,
    identityLinked: row.identity_linked,
  };
}

export async function listReturnCases(query: DatabaseQueryExecutor, limit = 100) {
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const result = await query<ReturnCaseRow>(
    `SELECT id, source_return_id, source_return_item_id,
      original_fulfillment_order_id, original_assignment_id,
      marking_unit_id, marking_code_id, posting_number, offer_id, ozon_sku,
      quantity, return_kind, destination, source_status, process_status, paid,
      code_fingerprint, crpt_state, unit_state, custody_state,
      return_document_id, return_document_status, return_document_revision,
      return_confirmation_state, physical_condition, receiving_warehouse_id,
      receiving_warehouse_name, fbo_intake_reference, edo_document_reference,
      manual_review_reason, detected_at, source_observed_at,
      direction_confirmed_at, seller_received_at, fbo_transfer_confirmed_at,
      version, updated_at
     FROM getomerch_marking.return_case_safe
     ORDER BY updated_at DESC, id DESC LIMIT $1`,
    [safeLimit],
  );
  return result.rows.map(mapReturnCase);
}

export async function getReturnCaseAccess(
  query: DatabaseQueryExecutor,
  returnCaseId: string,
) {
  return (await query<{
    id: string;
    version: string;
    offer_id: string | null;
    gtin: string | null;
    process_status: string;
    destination: MarkingReturnCase["destination"];
  }>(
    `SELECT id, version, offer_id, gtin, process_status, destination
     FROM getomerch_marking.return_case_safe
     WHERE id = $1::uuid`,
    [returnCaseId],
  )).rows[0] ?? null;
}

export async function confirmReturnDirection(
  query: DatabaseQueryExecutor,
  input: {
    returnCaseId: string;
    expectedVersion: number;
    destination: "to_seller" | "to_ozon_fbo";
    paid: boolean;
    actorId: string;
    requestId: string;
  },
) {
  return (await query<CommandRow>(
    `SELECT return_case_id, case_version, process_status, destination
     FROM getomerch_marking.confirm_return_direction(
       $1::uuid,$2::bigint,$3,$4,$5,$6::uuid
     )`,
    [input.returnCaseId, input.expectedVersion, input.destination, input.paid,
      input.actorId, input.requestId],
  )).rows[0];
}

export async function prepareReturnDocument(
  query: DatabaseQueryExecutor,
  input: {
    returnCaseId: string;
    actorId: string;
    requestId: string;
    forceCorrection?: boolean;
  },
) {
  const row = (await query<{
    document_id: string | null;
    document_status: MarkingDocumentStatus;
    document_revision: number;
    reused: boolean;
    no_op: boolean;
  }>(
    `SELECT document_id, document_status, document_revision, reused, no_op
     FROM getomerch_marking.prepare_return_document($1::uuid,$2,$3::uuid,$4)`,
    [input.returnCaseId, input.actorId, input.requestId,
      input.forceCorrection === true],
  )).rows[0];
  return {
    documentId: row.document_id,
    status: row.document_status,
    revision: row.document_revision,
    reused: row.reused,
    noOp: row.no_op,
  };
}

export async function getReturnDocumentMaterial(
  query: DatabaseQueryExecutor,
  documentId: string,
  actorId: string,
) {
  const row = (await query<MaterialRow>(
    `SELECT document_id, document_status, api_contract_version,
      return_case_id, source_return_id, posting_number, action_date, paid,
      code_fingerprint, gtin, offer_id, code_ciphertext, code_nonce,
      code_auth_tag, code_key_version, payload_hash, payload_ciphertext,
      payload_nonce, payload_auth_tag, payload_key_version, signature_hash,
      signature_ciphertext, signature_nonce, signature_auth_tag,
      signature_key_version, external_document_id
     FROM getomerch_marking.get_return_document_material($1::uuid,$2)`,
    [documentId, actorId],
  )).rows[0];
  if (!row) throw new Error("Return document material is missing");
  const sensitive = [row.code_ciphertext, row.code_nonce, row.code_auth_tag,
    row.payload_ciphertext, row.payload_nonce, row.payload_auth_tag,
    row.signature_ciphertext, row.signature_nonce, row.signature_auth_tag]
    .filter((value): value is Buffer => Buffer.isBuffer(value));
  try {
    return {
      documentId: row.document_id,
      status: row.document_status,
      contractVersion: row.api_contract_version,
      returnCaseId: row.return_case_id,
      sourceReturnId: row.source_return_id,
      postingNumber: row.posting_number,
      actionDate: new Date(row.action_date).toISOString().slice(0, 10),
      paid: row.paid,
      fingerprint: row.code_fingerprint,
      gtin: row.gtin,
      offerId: row.offer_id,
      encryptedCode: encrypted(row.code_ciphertext, row.code_nonce,
        row.code_auth_tag, row.code_key_version),
      payloadHash: row.payload_hash,
      encryptedPayload: optionalEncrypted(row.payload_ciphertext, row.payload_nonce,
        row.payload_auth_tag, row.payload_key_version),
      signatureHash: row.signature_hash,
      encryptedSignature: optionalEncrypted(row.signature_ciphertext,
        row.signature_nonce, row.signature_auth_tag, row.signature_key_version),
      externalDocumentId: row.external_document_id,
    };
  } finally {
    for (const value of sensitive) value.fill(0);
  }
}

export async function recordReturnPoll(
  query: DatabaseQueryExecutor,
  input: {
    documentId: string;
    remoteStatus: string;
    response: Record<string, unknown>;
    actorId: string;
    errorCode?: string | null;
    errorMessage?: string | null;
  },
) {
  return (await query<{ status: MarkingDocumentStatus }>(
    `SELECT getomerch_marking.record_return_poll(
      $1::uuid,$2,$3::jsonb,$4,$5,$6
    ) AS status`,
    [input.documentId, input.remoteStatus, JSON.stringify(input.response),
      input.errorCode ?? null, input.errorMessage ?? null, input.actorId],
  )).rows[0].status;
}

export async function recordReturnManualReview(
  query: DatabaseQueryExecutor,
  input: { documentId: string; errorCode: string; errorMessage: string; phase: string },
) {
  return (await query<{ status: MarkingDocumentStatus }>(
    `SELECT getomerch_marking.record_return_manual_review($1::uuid,$2,$3,$4) AS status`,
    [input.documentId, input.errorCode, input.errorMessage, input.phase],
  )).rows[0].status;
}

export async function lockSellerReceiptContext(
  query: DatabaseQueryExecutor,
  returnCaseId: string,
) {
  return (await query<{
    id: string;
    version: string;
    process_status: string;
    destination: string;
    seller_received_at: Date | string | null;
    product_id_snapshot: string;
  }>(
    `SELECT id, version, process_status, destination, seller_received_at,
      product_id_snapshot
     FROM getomerch_marking.get_seller_receipt_context($1::uuid)`,
    [returnCaseId],
  )).rows[0] ?? null;
}

export async function recordSellerReturnReceipt(
  query: DatabaseQueryExecutor,
  input: {
    returnCaseId: string;
    expectedVersion: number;
    condition: "intact" | "relabel_same_code" | "remark_required" | "destroy_pending";
    warehouseId: string;
    inventoryTransactionId: string | null;
    actorId: string;
    requestId: string;
  },
) {
  const row = (await query<{
    return_case_id: string;
    case_version: string;
    process_status: string;
    stock_received: boolean;
  }>(
    `SELECT return_case_id, case_version, process_status, stock_received
     FROM getomerch_marking.record_seller_return_receipt(
       $1::uuid,$2::bigint,$3,$4::uuid,$5::uuid,$6,$7::uuid
     )`,
    [input.returnCaseId, input.expectedVersion, input.condition,
      input.warehouseId, input.inventoryTransactionId, input.actorId,
      input.requestId],
  )).rows[0];
  return { id: row.return_case_id, version: Number(row.case_version),
    processStatus: row.process_status, stockReceived: row.stock_received };
}

export async function confirmReturnFboTransfer(
  query: DatabaseQueryExecutor,
  input: {
    returnCaseId: string;
    expectedVersion: number;
    fboIntakeReference: string;
    edoDocumentReference: string;
    actorId: string;
    requestId: string;
  },
) {
  const row = (await query<CommandRow>(
    `SELECT return_case_id, case_version, process_status
     FROM getomerch_marking.confirm_return_fbo_transfer(
       $1::uuid,$2::bigint,$3,$4,$5,$6::uuid
     )`,
    [input.returnCaseId, input.expectedVersion, input.fboIntakeReference,
      input.edoDocumentReference, input.actorId, input.requestId],
  )).rows[0];
  return { id: row.return_case_id, version: Number(row.case_version),
    processStatus: row.process_status };
}

type CommandRow = {
  return_case_id: string;
  case_version: string;
  process_status: string;
  destination?: string;
};

type ReturnCaseRow = {
  id: string;
  source_return_id: string;
  source_return_item_id: string;
  original_fulfillment_order_id: string | null;
  original_assignment_id: string | null;
  marking_unit_id: string | null;
  marking_code_id: string | null;
  posting_number: string;
  offer_id: string | null;
  ozon_sku: string | null;
  quantity: number;
  return_kind: string;
  destination: MarkingReturnCase["destination"];
  source_status: string;
  process_status: string;
  paid: boolean | null;
  code_fingerprint: string | null;
  crpt_state: string | null;
  unit_state: string | null;
  custody_state: string | null;
  return_document_id: string | null;
  return_document_status: MarkingDocumentStatus | null;
  return_document_revision: number | null;
  return_confirmation_state: string | null;
  physical_condition: string | null;
  receiving_warehouse_id: string | null;
  receiving_warehouse_name: string | null;
  fbo_intake_reference: string | null;
  edo_document_reference: string | null;
  manual_review_reason: string | null;
  detected_at: Date | string;
  source_observed_at: Date | string | null;
  direction_confirmed_at: Date | string | null;
  seller_received_at: Date | string | null;
  fbo_transfer_confirmed_at: Date | string | null;
  version: string;
  updated_at: Date | string;
};

type MaterialRow = {
  document_id: string;
  document_status: MarkingDocumentStatus;
  api_contract_version: string;
  return_case_id: string;
  source_return_id: string;
  posting_number: string;
  action_date: Date | string;
  paid: boolean;
  code_fingerprint: string;
  gtin: string;
  offer_id: string | null;
  code_ciphertext: Buffer;
  code_nonce: Buffer;
  code_auth_tag: Buffer;
  code_key_version: number;
  payload_hash: string | null;
  payload_ciphertext: Buffer | null;
  payload_nonce: Buffer | null;
  payload_auth_tag: Buffer | null;
  payload_key_version: number | null;
  signature_hash: string | null;
  signature_ciphertext: Buffer | null;
  signature_nonce: Buffer | null;
  signature_auth_tag: Buffer | null;
  signature_key_version: number | null;
  external_document_id: string | null;
};

function mapReturnCase(row: ReturnCaseRow): MarkingReturnCase {
  return {
    id: row.id,
    sourceReturnId: row.source_return_id,
    sourceReturnItemId: row.source_return_item_id,
    fulfillmentOrderId: row.original_fulfillment_order_id,
    assignmentId: row.original_assignment_id,
    markingUnitId: row.marking_unit_id,
    markingCodeId: row.marking_code_id,
    postingNumber: row.posting_number,
    offerId: row.offer_id,
    ozonSku: row.ozon_sku,
    quantity: row.quantity,
    returnKind: row.return_kind,
    destination: row.destination,
    sourceStatus: row.source_status,
    processStatus: row.process_status,
    paid: row.paid,
    codeFingerprint: row.code_fingerprint,
    crptState: row.crpt_state,
    unitState: row.unit_state,
    custodyState: row.custody_state,
    documentId: row.return_document_id,
    documentStatus: row.return_document_status,
    documentRevision: row.return_document_revision,
    returnConfirmationState: row.return_confirmation_state,
    physicalCondition: row.physical_condition,
    receivingWarehouseId: row.receiving_warehouse_id,
    receivingWarehouseName: row.receiving_warehouse_name,
    fboIntakeReference: row.fbo_intake_reference,
    edoDocumentReference: row.edo_document_reference,
    manualReviewReason: row.manual_review_reason,
    detectedAt: iso(row.detected_at)!,
    sourceObservedAt: iso(row.source_observed_at),
    directionConfirmedAt: iso(row.direction_confirmed_at),
    sellerReceivedAt: iso(row.seller_received_at),
    fboTransferConfirmedAt: iso(row.fbo_transfer_confirmed_at),
    version: Number(row.version),
    updatedAt: iso(row.updated_at)!,
  };
}

function encrypted(
  ciphertext: Buffer,
  nonce: Buffer,
  authTag: Buffer,
  keyVersion: number,
): EncryptedMarkingValue {
  return { algorithm: "aes-256-gcm", keyVersion,
    ciphertext: ciphertext.toString("base64"), iv: nonce.toString("base64"),
    authTag: authTag.toString("base64") };
}

function optionalEncrypted(
  ciphertext: Buffer | null,
  nonce: Buffer | null,
  authTag: Buffer | null,
  keyVersion: number | null,
) {
  return ciphertext && nonce && authTag && keyVersion
    ? encrypted(ciphertext, nonce, authTag, keyVersion)
    : null;
}

function iso(value: Date | string | null) {
  return value == null ? null : new Date(value).toISOString();
}
