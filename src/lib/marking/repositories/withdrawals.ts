import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import type { MarkingDocumentStatus } from "@/lib/marking/repositories/documents";
import type { EncryptedMarkingValue } from "@/lib/marking/security/keyring";

type MaterialRow = {
  document_id: string;
  document_status: MarkingDocumentStatus;
  api_contract_version: string;
  posting_number: string;
  action_date: Date | string;
  kpp: string;
  fias_id: string;
  location_name: string;
  code_fingerprint: string;
  gtin: string;
  offer_id: string | null;
  product_cost_minor: string;
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

export async function prepareWithdrawalDocument(
  query: DatabaseQueryExecutor,
  input: { handoverId: string; actorId: string; requestId: string; forceCorrection?: boolean },
) {
  const row = (await query<{
    document_id: string;
    document_status: MarkingDocumentStatus;
    document_revision: number;
    reused: boolean;
  }>(
    `SELECT document_id, document_status, document_revision, reused
     FROM getomerch_marking.prepare_withdrawal_document($1::uuid,$2,$3::uuid,$4)`,
    [input.handoverId, input.actorId, input.requestId, input.forceCorrection === true],
  )).rows[0];
  return {
    id: row.document_id,
    status: row.document_status,
    revision: row.document_revision,
    reused: row.reused,
  };
}

export async function getWithdrawalDocumentMaterial(
  query: DatabaseQueryExecutor,
  documentId: string,
  actorId: string,
) {
  const rows = (await query<MaterialRow>(
    `SELECT document_id, document_status, api_contract_version,
      posting_number, action_date, kpp, fias_id, location_name,
      code_fingerprint, gtin, offer_id, product_cost_minor,
      code_ciphertext, code_nonce, code_auth_tag, code_key_version,
      payload_hash, payload_ciphertext, payload_nonce, payload_auth_tag,
      payload_key_version, signature_hash, signature_ciphertext,
      signature_nonce, signature_auth_tag, signature_key_version,
      external_document_id
     FROM getomerch_marking.get_withdrawal_document_material($1::uuid,$2)`,
    [documentId, actorId],
  )).rows;
  if (rows.length === 0) throw new Error("Withdrawal document material is missing");
  const first = rows[0];
  const sensitive = rows.flatMap((row) => [
    row.code_ciphertext, row.code_nonce, row.code_auth_tag,
    row.payload_ciphertext, row.payload_nonce, row.payload_auth_tag,
    row.signature_ciphertext, row.signature_nonce, row.signature_auth_tag,
  ]).filter((value): value is Buffer => Buffer.isBuffer(value));
  try {
    return {
      documentId: first.document_id,
      status: first.document_status,
      contractVersion: first.api_contract_version,
      postingNumber: first.posting_number,
      actionDate: new Date(first.action_date).toISOString().slice(0, 10),
      kpp: first.kpp,
      fiasId: first.fias_id,
      locationName: first.location_name,
      payloadHash: first.payload_hash,
      encryptedPayload: optionalEncrypted(first.payload_ciphertext, first.payload_nonce,
        first.payload_auth_tag, first.payload_key_version),
      signatureHash: first.signature_hash,
      encryptedSignature: optionalEncrypted(first.signature_ciphertext, first.signature_nonce,
        first.signature_auth_tag, first.signature_key_version),
      externalDocumentId: first.external_document_id,
      products: rows.map((row) => ({
        gtin: row.gtin,
        offerId: row.offer_id,
        fingerprint: row.code_fingerprint,
        productCostMinor: Number(row.product_cost_minor),
        encryptedCode: encrypted(row.code_ciphertext, row.code_nonce,
          row.code_auth_tag, row.code_key_version),
      })),
    };
  } finally {
    for (const value of sensitive) value.fill(0);
  }
}

export async function getMarkingDocumentType(
  query: DatabaseQueryExecutor,
  documentId: string,
) {
  return (await query<{ document_type: "introduction" | "withdrawal_remote_sale" | "return_to_circulation" }>(
    `SELECT document_type FROM getomerch_marking.document_safe WHERE id = $1::uuid`,
    [documentId],
  )).rows[0]?.document_type ?? null;
}

export async function recordWithdrawalPoll(
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
    `SELECT getomerch_marking.record_withdrawal_poll(
      $1::uuid,$2,$3::jsonb,$4,$5,$6
    ) AS status`,
    [input.documentId, input.remoteStatus, JSON.stringify(input.response),
      input.errorCode ?? null, input.errorMessage ?? null, input.actorId],
  )).rows[0].status;
}

export async function recordWithdrawalManualReview(
  query: DatabaseQueryExecutor,
  input: { documentId: string; errorCode: string; errorMessage: string; phase: string },
) {
  return (await query<{ status: MarkingDocumentStatus }>(
    `SELECT getomerch_marking.record_withdrawal_manual_review(
      $1::uuid,$2,$3,$4
    ) AS status`,
    [input.documentId, input.errorCode, input.errorMessage, input.phase],
  )).rows[0].status;
}

function encrypted(
  ciphertext: Buffer,
  nonce: Buffer,
  authTag: Buffer,
  keyVersion: number,
): EncryptedMarkingValue {
  return {
    algorithm: "aes-256-gcm",
    keyVersion,
    ciphertext: ciphertext.toString("base64"),
    iv: nonce.toString("base64"),
    authTag: authTag.toString("base64"),
  };
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
