import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import {
  CRPT_CONFORMITY_DOCUMENT_TYPES,
  type CrptConformityDocument,
} from "@/lib/marking/domain/crpt-introduction";
import type { EncryptedMarkingValue } from "@/lib/marking/security/keyring";

export type MarkingDocumentStatus =
  | "draft"
  | "payload_built"
  | "signed"
  | "submitting"
  | "processing"
  | "accepted"
  | "rejected"
  | "requires_manual_review"
  | "superseded";

export type MarkingDocument = {
  id: string;
  documentType: "introduction" | "withdrawal_remote_sale" | "return_to_circulation";
  operationMode: "own_production" | "distance_sale" | "remote_sale_return";
  status: MarkingDocumentStatus;
  revision: number;
  externalDocumentId: string | null;
  payloadHash: string | null;
  signatureHash: string | null;
  certificateThumbprint: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  handoverId: string | null;
  returnCaseId: string | null;
  postingNumber: string | null;
  handoverAt: string | null;
  withdrawalDeadlineAt: string | null;
  circulationState: "pending" | "confirmed" | "requires_manual_review" | null;
  circulationErrorCode: string | null;
  circulationErrorMessage: string | null;
  circulationConfirmedAt: string | null;
  withdrawalState: "pending" | "confirmed" | "requires_manual_review" | null;
  withdrawalErrorCode: string | null;
  withdrawalErrorMessage: string | null;
  withdrawalConfirmedAt: string | null;
  returnState: "pending" | "confirmed" | "requires_manual_review" | null;
  returnErrorCode: string | null;
  returnErrorMessage: string | null;
  returnConfirmedAt: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
  codes: MarkingDocumentCode[];
};

export type MarkingDocumentCode = {
  assignmentId: string;
  markingCodeId: string;
  markingUnitId: string;
  gtin: string;
  fingerprint: string;
  postingNumber: string;
  offerId: string | null;
  unitOrdinal: number;
  result: string;
  operationKind: "introduction" | "withdrawal" | "return_to_circulation";
  crptState: string;
  errorCode: string | null;
  errorMessage: string | null;
};

export async function prepareIntroductionDocument(
  query: DatabaseQueryExecutor,
  input: { assignmentId: string; actorId: string; requestId: string; forceCorrection?: boolean },
) {
  const row = (await query<{
    document_id: string;
    document_status: MarkingDocumentStatus;
    document_revision: number;
    reused: boolean;
  }>(
    `SELECT document_id, document_status, document_revision, reused
     FROM getomerch_marking.prepare_introduction_document($1::uuid,$2,$3::uuid,$4)`,
    [input.assignmentId, input.actorId, input.requestId, input.forceCorrection === true],
  )).rows[0];
  return {
    id: row.document_id,
    status: row.document_status,
    revision: row.document_revision,
    reused: row.reused,
  };
}

export async function getIntroductionDocumentMaterial(
  query: DatabaseQueryExecutor,
  documentId: string,
  actorId: string,
) {
  const row = (await query<MaterialRow>(
    `SELECT document_id, document_status, api_contract_version, gtin, offer_id,
      tnved_code, production_date, conformity_documents, code_fingerprint, code_ciphertext,
      code_nonce, code_auth_tag, code_key_version, payload_hash,
      payload_ciphertext, payload_nonce, payload_auth_tag, payload_key_version,
      signature_hash, signature_ciphertext, signature_nonce,
      signature_auth_tag, signature_key_version, external_document_id
     FROM getomerch_marking.get_introduction_document_material($1::uuid,$2)`,
    [documentId, actorId],
  )).rows[0];
  const sensitiveBuffers = [
    row.code_ciphertext, row.code_nonce, row.code_auth_tag,
    row.payload_ciphertext, row.payload_nonce, row.payload_auth_tag,
    row.signature_ciphertext, row.signature_nonce, row.signature_auth_tag,
  ].filter((value): value is Buffer => Buffer.isBuffer(value));
  try {
    return {
      documentId: row.document_id,
      status: row.document_status,
      contractVersion: row.api_contract_version,
      gtin: row.gtin,
      offerId: row.offer_id,
      tnvedCode: row.tnved_code,
      productionDate: isoDate(row.production_date),
      conformityDocuments: parseConformityDocuments(row.conformity_documents),
      fingerprint: row.code_fingerprint,
      encryptedCode: encrypted(
        row.code_ciphertext, row.code_nonce, row.code_auth_tag, row.code_key_version,
      ),
      payloadHash: row.payload_hash,
      encryptedPayload: optionalEncrypted(
        row.payload_ciphertext, row.payload_nonce, row.payload_auth_tag, row.payload_key_version,
      ),
      signatureHash: row.signature_hash,
      encryptedSignature: optionalEncrypted(
        row.signature_ciphertext, row.signature_nonce, row.signature_auth_tag,
        row.signature_key_version,
      ),
      externalDocumentId: row.external_document_id,
    };
  } finally {
    for (const value of sensitiveBuffers) value.fill(0);
  }
}

export async function storeIntroductionPayload(
  query: DatabaseQueryExecutor,
  input: { documentId: string; payloadHash: string; encrypted: EncryptedMarkingValue; actorId: string },
) {
  const value = buffers(input.encrypted);
  try {
    const result = await query<{ status: MarkingDocumentStatus }>(
      `SELECT getomerch_marking.store_introduction_payload(
        $1::uuid,$2,$3::bytea,$4::bytea,$5::bytea,$6,$7
      ) AS status`,
      [input.documentId, input.payloadHash, value.ciphertext, value.nonce,
        value.authTag, input.encrypted.keyVersion, input.actorId],
    );
    return result.rows[0].status;
  } finally {
    wipe(value);
  }
}

export async function storeIntroductionSignature(
  query: DatabaseQueryExecutor,
  input: {
    documentId: string;
    signatureHash: string;
    encrypted: EncryptedMarkingValue;
    certificateThumbprint: string;
    actorId: string;
  },
) {
  const value = buffers(input.encrypted);
  try {
    const result = await query<{ status: MarkingDocumentStatus }>(
      `SELECT getomerch_marking.store_introduction_signature(
        $1::uuid,$2,$3::bytea,$4::bytea,$5::bytea,$6,$7,$8
      ) AS status`,
      [input.documentId, input.signatureHash, value.ciphertext, value.nonce,
        value.authTag, input.encrypted.keyVersion, input.certificateThumbprint,
        input.actorId],
    );
    return result.rows[0].status;
  } finally {
    wipe(value);
  }
}

export async function recordIntroductionSubmitted(
  query: DatabaseQueryExecutor,
  input: { documentId: string; externalDocumentId: string; actorId: string },
) {
  const result = await query<{ status: MarkingDocumentStatus }>(
    `SELECT getomerch_marking.record_introduction_submitted(
      $1::uuid,$2,$3::jsonb,$4
    ) AS status`,
    [input.documentId, input.externalDocumentId,
      JSON.stringify({ acceptedForProcessing: true }), input.actorId],
  );
  return result.rows[0].status;
}

export async function recordIntroductionSubmitStarted(
  query: DatabaseQueryExecutor,
  input: { documentId: string; actorId: string },
) {
  const result = await query<{ status: MarkingDocumentStatus }>(
    `SELECT getomerch_marking.record_introduction_submit_started($1::uuid,$2) AS status`,
    [input.documentId, input.actorId],
  );
  return result.rows[0].status;
}

export async function recordIntroductionPoll(
  query: DatabaseQueryExecutor,
  input: {
    documentId: string;
    remoteStatus: string;
    response: Record<string, unknown>;
    errorCode?: string | null;
    errorMessage?: string | null;
  },
) {
  const result = await query<{ status: MarkingDocumentStatus }>(
    `SELECT getomerch_marking.record_introduction_poll(
      $1::uuid,$2,$3::jsonb,$4,$5
    ) AS status`,
    [input.documentId, input.remoteStatus, JSON.stringify(input.response),
      input.errorCode ?? null, input.errorMessage ?? null],
  );
  return result.rows[0].status;
}

export async function recordIntroductionManualReview(
  query: DatabaseQueryExecutor,
  input: { documentId: string; errorCode: string; errorMessage: string; phase: string },
) {
  const result = await query<{ status: MarkingDocumentStatus }>(
    `SELECT getomerch_marking.record_introduction_manual_review(
      $1::uuid,$2,$3,$4::jsonb
    ) AS status`,
    [input.documentId, input.errorCode, input.errorMessage,
      JSON.stringify({ phase: input.phase })],
  );
  return result.rows[0].status;
}

export async function reconcileIntroductionSubmission(
  query: DatabaseQueryExecutor,
  input: {
    documentId: string;
    externalDocumentId: string;
    remoteStatus: string;
    response: Record<string, unknown>;
    errorCode?: string | null;
    errorMessage?: string | null;
    actorId: string;
  },
) {
  const result = await query<{ status: MarkingDocumentStatus }>(
    `SELECT getomerch_marking.reconcile_introduction_submission(
      $1::uuid,$2,$3,$4::jsonb,$5,$6,$7
    ) AS status`,
    [input.documentId, input.externalDocumentId, input.remoteStatus,
      JSON.stringify(input.response), input.errorCode ?? null,
      input.errorMessage ?? null, input.actorId],
  );
  return result.rows[0].status;
}

export async function confirmIntroductionCirculation(
  query: DatabaseQueryExecutor,
  input: { documentId: string; rawStatus: string; actorId: string },
) {
  await query(
    `SELECT getomerch_marking.confirm_introduction_circulation($1::uuid,$2,$3)`,
    [input.documentId, input.rawStatus, input.actorId],
  );
}

export async function recordIntroductionCirculationReview(
  query: DatabaseQueryExecutor,
  input: { documentId: string; errorCode: string; errorMessage: string; rawStatus?: string | null },
) {
  const result = await query<{ status: "requires_manual_review" }>(
    `SELECT getomerch_marking.record_introduction_circulation_review(
      $1::uuid,$2,$3,$4
    ) AS status`,
    [input.documentId, input.errorCode, input.errorMessage, input.rawStatus ?? null],
  );
  return result.rows[0].status;
}

export async function listMarkingDocuments(query: DatabaseQueryExecutor, limit = 100) {
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
  const documents = await query<DocumentRow>(
    `SELECT id, document_type, operation_mode, status, revision,
      handover_id, return_case_id, posting_number, handover_at, withdrawal_deadline_at,
      external_document_id, payload_hash,
      signature_hash, certificate_thumbprint, error_code, error_message,
      circulation_state, circulation_error_code, circulation_error_message,
      circulation_confirmed_at, withdrawal_state, withdrawal_error_code,
      withdrawal_error_message, withdrawal_confirmed_at,
      return_state, return_error_code, return_error_message, return_confirmed_at,
      attempt_count, created_at, updated_at, accepted_at
     FROM getomerch_marking.document_safe
     ORDER BY updated_at DESC, id DESC LIMIT $1`,
    [safeLimit],
  );
  if (documents.rows.length === 0) return [];
  const codes = await query<CodeRow>(
    `SELECT document_id, assignment_id, marking_code_id, marking_unit_id,
      gtin_snapshot, code_fingerprint, external_posting_number, offer_id,
      operation_kind,
      unit_ordinal, operation_result, crpt_state, error_code, error_message
     FROM getomerch_marking.document_code_safe
     WHERE document_id = ANY($1::uuid[])
     ORDER BY document_id, unit_ordinal, assignment_id`,
    [documents.rows.map((row) => row.id)],
  );
  const byDocument = new Map<string, MarkingDocumentCode[]>();
  for (const row of codes.rows) {
    const collection = byDocument.get(row.document_id) ?? [];
    collection.push({
      assignmentId: row.assignment_id,
      markingCodeId: row.marking_code_id,
      markingUnitId: row.marking_unit_id,
      gtin: row.gtin_snapshot,
      fingerprint: row.code_fingerprint,
      postingNumber: row.external_posting_number,
      offerId: row.offer_id,
      unitOrdinal: row.unit_ordinal,
      result: row.operation_result,
      operationKind: row.operation_kind,
      crptState: row.crpt_state,
      errorCode: row.error_code,
      errorMessage: row.error_message,
    });
    byDocument.set(row.document_id, collection);
  }
  return documents.rows.map((row): MarkingDocument => ({
    id: row.id,
    documentType: row.document_type,
    operationMode: row.operation_mode,
    status: row.status,
    revision: row.revision,
    externalDocumentId: row.external_document_id,
    payloadHash: row.payload_hash,
    signatureHash: row.signature_hash,
    certificateThumbprint: row.certificate_thumbprint,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    handoverId: row.handover_id,
    returnCaseId: row.return_case_id,
    postingNumber: row.posting_number,
    handoverAt: nullableIso(row.handover_at),
    withdrawalDeadlineAt: nullableIso(row.withdrawal_deadline_at),
    circulationState: row.circulation_state,
    circulationErrorCode: row.circulation_error_code,
    circulationErrorMessage: row.circulation_error_message,
    circulationConfirmedAt: nullableIso(row.circulation_confirmed_at),
    withdrawalState: row.withdrawal_state,
    withdrawalErrorCode: row.withdrawal_error_code,
    withdrawalErrorMessage: row.withdrawal_error_message,
    withdrawalConfirmedAt: nullableIso(row.withdrawal_confirmed_at),
    returnState: row.return_state,
    returnErrorCode: row.return_error_code,
    returnErrorMessage: row.return_error_message,
    returnConfirmedAt: nullableIso(row.return_confirmed_at),
    attemptCount: row.attempt_count,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    acceptedAt: nullableIso(row.accepted_at),
    codes: byDocument.get(row.id) ?? [],
  }));
}

type MaterialRow = {
  document_id: string; document_status: MarkingDocumentStatus; api_contract_version: string;
  gtin: string; offer_id: string | null; tnved_code: string;
  production_date: Date | string; conformity_documents: unknown; code_fingerprint: string;
  code_ciphertext: Buffer; code_nonce: Buffer; code_auth_tag: Buffer; code_key_version: number;
  payload_hash: string | null; payload_ciphertext: Buffer | null; payload_nonce: Buffer | null;
  payload_auth_tag: Buffer | null; payload_key_version: number | null;
  signature_hash: string | null; signature_ciphertext: Buffer | null; signature_nonce: Buffer | null;
  signature_auth_tag: Buffer | null; signature_key_version: number | null;
  external_document_id: string | null;
};

function parseConformityDocuments(value: unknown): CrptConformityDocument[] {
  if (!Array.isArray(value)) throw new Error("CRPT conformity document projection is invalid");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("CRPT conformity document projection is invalid");
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.type !== "string"
      || !CRPT_CONFORMITY_DOCUMENT_TYPES.includes(record.type as never)
      || typeof record.number !== "string"
      || record.number.length < 1
      || record.number.length > 300
      || typeof record.date !== "string"
      || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)
    ) {
      throw new Error("CRPT conformity document projection is invalid");
    }
    return {
      type: record.type as CrptConformityDocument["type"],
      number: record.number,
      date: record.date,
    };
  });
}
type DocumentRow = {
  id: string; document_type: "introduction" | "withdrawal_remote_sale" | "return_to_circulation";
  operation_mode: "own_production" | "distance_sale" | "remote_sale_return";
  status: MarkingDocumentStatus; revision: number; external_document_id: string | null;
  handover_id: string | null; return_case_id: string | null; posting_number: string | null;
  handover_at: Date | string | null; withdrawal_deadline_at: Date | string | null;
  payload_hash: string | null; signature_hash: string | null; certificate_thumbprint: string | null;
  error_code: string | null; error_message: string | null;
  circulation_state: "pending" | "confirmed" | "requires_manual_review" | null;
  circulation_error_code: string | null; circulation_error_message: string | null;
  circulation_confirmed_at: Date | string | null; attempt_count: number;
  withdrawal_state: "pending" | "confirmed" | "requires_manual_review" | null;
  withdrawal_error_code: string | null; withdrawal_error_message: string | null;
  withdrawal_confirmed_at: Date | string | null;
  return_state: "pending" | "confirmed" | "requires_manual_review" | null;
  return_error_code: string | null; return_error_message: string | null;
  return_confirmed_at: Date | string | null;
  created_at: Date | string; updated_at: Date | string; accepted_at: Date | string | null;
};
type CodeRow = {
  document_id: string; assignment_id: string; marking_code_id: string; marking_unit_id: string;
  gtin_snapshot: string; code_fingerprint: string; external_posting_number: string;
  offer_id: string | null; unit_ordinal: number; operation_result: string;
  operation_kind: "introduction" | "withdrawal" | "return_to_circulation";
  crpt_state: string;
  error_code: string | null; error_message: string | null;
};

function encrypted(ciphertext: Buffer, nonce: Buffer, authTag: Buffer, keyVersion: number): EncryptedMarkingValue {
  return { algorithm: "aes-256-gcm", keyVersion, ciphertext: ciphertext.toString("base64"),
    iv: nonce.toString("base64"), authTag: authTag.toString("base64") };
}
function optionalEncrypted(
  ciphertext: Buffer | null, nonce: Buffer | null, authTag: Buffer | null, keyVersion: number | null,
) {
  return ciphertext && nonce && authTag && keyVersion
    ? encrypted(ciphertext, nonce, authTag, keyVersion) : null;
}
function buffers(value: EncryptedMarkingValue) {
  return { ciphertext: Buffer.from(value.ciphertext, "base64"), nonce: Buffer.from(value.iv, "base64"),
    authTag: Buffer.from(value.authTag, "base64") };
}
function wipe(value: { ciphertext: Buffer; nonce: Buffer; authTag: Buffer }) {
  value.ciphertext.fill(0); value.nonce.fill(0); value.authTag.fill(0);
}
function iso(value: Date | string) { return new Date(value).toISOString(); }
function nullableIso(value: Date | string | null) { return value == null ? null : iso(value); }
function isoDate(value: Date | string) { return new Date(value).toISOString().slice(0, 10); }
