import "server-only";

import type { DatabaseQueryExecutor } from "@/lib/db/pool";
import type { MarkingAgentTelemetry } from "@/lib/marking/agent/protocol";
import type { EncryptedMarkingValue } from "@/lib/marking/security/keyring";
import type { SignerCertificateInfo, SignerPurpose } from "@/lib/marking/signer/protocol";

export type RemoteSignatureStatus =
  | "pending"
  | "leased"
  | "signed"
  | "consumed"
  | "failed"
  | "expired"
  | "cancelled";

export type SigningAgentSafe = {
  agentId: string;
  displayName: string;
  state: MarkingAgentTelemetry["state"];
  readerDetected: boolean;
  signerReachable: boolean;
  pinState: MarkingAgentTelemetry["pinState"];
  certificateThumbprint: string | null;
  certificateValidTo: string | null;
  softwareVersion: string;
  errorCode: string | null;
  errorMessage: string | null;
  lastSeenAt: string;
};

export type SignatureRequestSafe = {
  id: string;
  purpose: SignerPurpose;
  payloadSha256: string;
  status: RemoteSignatureStatus;
  requestedBy: string;
  leaseAgentId: string | null;
  attemptCount: number;
  certificateThumbprint: string | null;
  certificateValidTo: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  expiresAt: string;
  signedAt: string | null;
  consumedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type CipherRow = {
  signature_request_id: string;
  purpose: SignerPurpose;
  payload_sha256: string;
  payload_ciphertext: Buffer;
  payload_nonce: Buffer;
  payload_auth_tag: Buffer;
  encryption_key_version: number;
  expires_at: Date | string;
};

export async function createRemoteSignatureRequest(
  query: DatabaseQueryExecutor,
  input: {
    purpose: SignerPurpose;
    payloadSha256: string;
    encryptedPayload: EncryptedMarkingValue;
    requestedBy: string;
    requestId: string;
    expiresAt: Date;
  },
) {
  const encrypted = encryptedBuffers(input.encryptedPayload);
  try {
    const result = await query<{
      signature_request_id: string;
      request_status: RemoteSignatureStatus;
      reused: boolean;
    }>(
      `
        SELECT * FROM getomerch_marking.create_remote_signature_request(
          $1,$2,$3::bytea,$4::bytea,$5::bytea,$6,$7,$8::uuid,$9::timestamptz
        )
      `,
      [
        input.purpose,
        input.payloadSha256,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authTag,
        input.encryptedPayload.keyVersion,
        input.requestedBy,
        input.requestId,
        input.expiresAt,
      ],
    );
    return {
      id: result.rows[0].signature_request_id,
      status: result.rows[0].request_status,
      reused: result.rows[0].reused,
    };
  } finally {
    wipe(encrypted);
  }
}

export async function getRemoteSignatureResult(
  query: DatabaseQueryExecutor,
  id: string,
  requestedBy: string,
) {
  const result = await query<{
    request_status: RemoteSignatureStatus;
    signature_ciphertext: Buffer | null;
    signature_nonce: Buffer | null;
    signature_auth_tag: Buffer | null;
    signature_key_version: number | null;
    certificate_thumbprint: string | null;
    certificate_subject: string | null;
    certificate_inn: string | null;
    certificate_ogrn: string | null;
    certificate_valid_from: Date | string | null;
    certificate_valid_to: Date | string | null;
    certificate_algorithm: string | null;
    error_code: string | null;
    error_message: string | null;
    expires_at: Date | string;
  }>(
    `SELECT * FROM getomerch_marking.get_remote_signature_result($1::uuid,$2)`,
    [id, requestedBy],
  );
  const row = result.rows[0];
  return {
    status: row.request_status,
    encryptedSignature: row.signature_ciphertext && row.signature_nonce
      && row.signature_auth_tag && row.signature_key_version
      ? encryptedValue(
          row.signature_ciphertext,
          row.signature_nonce,
          row.signature_auth_tag,
          row.signature_key_version,
        )
      : null,
    certificate: row.certificate_thumbprint && row.certificate_subject
      && row.certificate_inn && row.certificate_valid_from
      && row.certificate_valid_to && row.certificate_algorithm
      ? {
          thumbprint: row.certificate_thumbprint,
          subject: row.certificate_subject,
          inn: row.certificate_inn,
          ogrn: row.certificate_ogrn,
          validFrom: iso(row.certificate_valid_from),
          validTo: iso(row.certificate_valid_to),
          algorithm: row.certificate_algorithm,
        } satisfies SignerCertificateInfo
      : null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    expiresAt: iso(row.expires_at),
  };
}

export async function consumeRemoteSignatureRequest(
  query: DatabaseQueryExecutor,
  id: string,
  requestedBy: string,
) {
  await query(
    `SELECT getomerch_marking.consume_remote_signature_request($1::uuid,$2)`,
    [id, requestedBy],
  );
}

export async function acceptSigningAgentEnvelope(
  query: DatabaseQueryExecutor,
  input: {
    agentId: string;
    nonce: string;
    requestId: string;
    issuedAt: string;
    telemetry: MarkingAgentTelemetry;
  },
) {
  const telemetry = input.telemetry;
  await query(
    `
      SELECT getomerch_marking.accept_signing_agent_envelope(
        $1,$2,$3::uuid,$4::timestamptz,$5,$6,$7,$8,$9,$10,$11::timestamptz,
        $12,$13,$14
      )
    `,
    [
      input.agentId,
      input.nonce,
      input.requestId,
      input.issuedAt,
      telemetry.displayName,
      telemetry.state,
      telemetry.readerDetected,
      telemetry.signerReachable,
      telemetry.pinState,
      telemetry.certificateThumbprint,
      telemetry.certificateValidTo,
      telemetry.softwareVersion,
      telemetry.errorCode,
      telemetry.errorMessage,
    ],
  );
}

export async function claimRemoteSignatureRequest(
  query: DatabaseQueryExecutor,
  agentId: string,
  leaseSeconds = 90,
) {
  const result = await query<CipherRow>(
    `SELECT * FROM getomerch_marking.claim_remote_signature_request($1,$2)`,
    [agentId, leaseSeconds],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.signature_request_id,
    purpose: row.purpose,
    payloadSha256: row.payload_sha256,
    encryptedPayload: encryptedValue(
      row.payload_ciphertext,
      row.payload_nonce,
      row.payload_auth_tag,
      row.encryption_key_version,
    ),
    expiresAt: iso(row.expires_at),
  };
}

export async function completeRemoteSignatureRequest(
  query: DatabaseQueryExecutor,
  input: {
    agentId: string;
    signatureRequestId: string;
    encryptedSignature: EncryptedMarkingValue;
    certificate: SignerCertificateInfo;
  },
) {
  const encrypted = encryptedBuffers(input.encryptedSignature);
  try {
    await query(
      `
        SELECT getomerch_marking.complete_remote_signature_request(
          $1,$2::uuid,$3::bytea,$4::bytea,$5::bytea,$6,$7,$8,$9,$10,
          $11::timestamptz,$12::timestamptz,$13
        )
      `,
      [
        input.agentId,
        input.signatureRequestId,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authTag,
        input.encryptedSignature.keyVersion,
        input.certificate.thumbprint,
        input.certificate.subject,
        input.certificate.inn,
        input.certificate.ogrn,
        input.certificate.validFrom,
        input.certificate.validTo,
        input.certificate.algorithm,
      ],
    );
  } finally {
    wipe(encrypted);
  }
}

export async function failRemoteSignatureRequest(
  query: DatabaseQueryExecutor,
  input: {
    agentId: string;
    signatureRequestId: string;
    errorCode: string;
    errorMessage: string;
    retryable: boolean;
  },
) {
  const result = await query<{ status: RemoteSignatureStatus }>(
    `
      SELECT getomerch_marking.fail_remote_signature_request(
        $1,$2::uuid,$3,$4,$5
      ) AS status
    `,
    [
      input.agentId,
      input.signatureRequestId,
      input.errorCode,
      input.errorMessage,
      input.retryable,
    ],
  );
  return result.rows[0].status;
}

export async function listSigningAgents(query: DatabaseQueryExecutor, limit = 20) {
  const result = await query<{
    agent_id: string;
    display_name: string;
    state: SigningAgentSafe["state"];
    reader_detected: boolean;
    signer_reachable: boolean;
    pin_state: SigningAgentSafe["pinState"];
    certificate_thumbprint: string | null;
    certificate_valid_to: Date | string | null;
    software_version: string;
    last_error_code: string | null;
    last_error_message: string | null;
    last_seen_at: Date | string;
  }>(
    `
      SELECT agent_id, display_name, state, reader_detected, signer_reachable,
        pin_state, certificate_thumbprint, certificate_valid_to,
        software_version, last_error_code, last_error_message, last_seen_at
      FROM getomerch_marking.signing_agent_safe
      ORDER BY last_seen_at DESC, agent_id
      LIMIT $1
    `,
    [Math.max(1, Math.min(50, Math.trunc(limit)))],
  );
  return result.rows.map((row): SigningAgentSafe => ({
    agentId: row.agent_id,
    displayName: row.display_name,
    state: row.state,
    readerDetected: row.reader_detected,
    signerReachable: row.signer_reachable,
    pinState: row.pin_state,
    certificateThumbprint: row.certificate_thumbprint,
    certificateValidTo: nullableIso(row.certificate_valid_to),
    softwareVersion: row.software_version,
    errorCode: row.last_error_code,
    errorMessage: row.last_error_message,
    lastSeenAt: iso(row.last_seen_at),
  }));
}

export async function listSignatureRequests(query: DatabaseQueryExecutor, limit = 50) {
  const result = await query<{
    id: string;
    purpose: SignerPurpose;
    payload_sha256: string;
    status: RemoteSignatureStatus;
    requested_by: string;
    lease_agent_id: string | null;
    attempt_count: number;
    certificate_thumbprint: string | null;
    certificate_valid_to: Date | string | null;
    error_code: string | null;
    error_message: string | null;
    expires_at: Date | string;
    signed_at: Date | string | null;
    consumed_at: Date | string | null;
    created_at: Date | string;
    updated_at: Date | string;
  }>(
    `
      SELECT id, purpose, payload_sha256, status, requested_by, lease_agent_id,
        attempt_count, certificate_thumbprint, certificate_valid_to,
        error_code, error_message, expires_at, signed_at, consumed_at,
        created_at, updated_at
      FROM getomerch_marking.signature_request_safe
      ORDER BY created_at DESC, id DESC
      LIMIT $1
    `,
    [Math.max(1, Math.min(100, Math.trunc(limit)))],
  );
  return result.rows.map((row): SignatureRequestSafe => ({
    id: row.id,
    purpose: row.purpose,
    payloadSha256: row.payload_sha256,
    status: row.status,
    requestedBy: row.requested_by,
    leaseAgentId: row.lease_agent_id,
    attemptCount: Number(row.attempt_count),
    certificateThumbprint: row.certificate_thumbprint,
    certificateValidTo: nullableIso(row.certificate_valid_to),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    expiresAt: iso(row.expires_at),
    signedAt: nullableIso(row.signed_at),
    consumedAt: nullableIso(row.consumed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }));
}

export async function getSignatureRequestSummary(query: DatabaseQueryExecutor) {
  const result = await query<{
    pending: string | number;
    leased: string | number;
    failed_24h: string | number;
    signed_24h: string | number;
  }>(
    `
      SELECT
        count(*) FILTER (WHERE status = 'pending') AS pending,
        count(*) FILTER (WHERE status = 'leased') AS leased,
        count(*) FILTER (WHERE status = 'failed'
          AND updated_at >= clock_timestamp() - interval '24 hours') AS failed_24h,
        count(*) FILTER (WHERE status = ANY (ARRAY['signed'::text, 'consumed'::text])
          AND signed_at >= clock_timestamp() - interval '24 hours') AS signed_24h
      FROM getomerch_marking.signature_request_safe
    `,
  );
  const row = result.rows[0];
  return {
    pending: Number(row.pending),
    leased: Number(row.leased),
    failed24h: Number(row.failed_24h),
    signed24h: Number(row.signed_24h),
  };
}

export async function getLatestCrptAuthorization(query: DatabaseQueryExecutor) {
  const result = await query<{
    id: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    result: unknown;
    error_code: string | null;
    error_message: string | null;
    updated_at: Date | string;
  }>(
    `
      SELECT id, status, result, error_code, error_message, updated_at
      FROM getomerch_jobs.marking_jobs
      WHERE type = 'marking_crpt_auth_refresh'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
  );
  const row = result.rows[0];
  if (!row) {
    return {
      status: "not_started" as const,
      tokenExpiresAt: null,
      certificateThumbprint: null,
      certificateValidTo: null,
      errorCode: null,
      errorMessage: null,
      updatedAt: null,
    };
  }
  const payload = isRecord(row.result) ? row.result : {};
  const certificate = isRecord(payload.certificate) ? payload.certificate : {};
  const tokenExpiresAt = validDateString(payload.tokenExpiresAt);
  const status = row.status === "succeeded"
    ? tokenExpiresAt && Date.parse(tokenExpiresAt) > Date.now() ? "active" : "expired"
    : row.status;
  return {
    status,
    tokenExpiresAt,
    certificateThumbprint: safeThumbprint(certificate.thumbprint),
    certificateValidTo: validDateString(certificate.validTo),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    updatedAt: iso(row.updated_at),
  };
}

function encryptedBuffers(value: EncryptedMarkingValue) {
  return {
    ciphertext: Buffer.from(value.ciphertext, "base64"),
    nonce: Buffer.from(value.iv, "base64"),
    authTag: Buffer.from(value.authTag, "base64"),
  };
}

function encryptedValue(
  ciphertext: Buffer,
  nonce: Buffer,
  authTag: Buffer,
  keyVersion: number,
): EncryptedMarkingValue {
  return {
    algorithm: "aes-256-gcm",
    keyVersion: Number(keyVersion),
    ciphertext: ciphertext.toString("base64"),
    iv: nonce.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

function wipe(value: { ciphertext: Buffer; nonce: Buffer; authTag: Buffer }) {
  value.ciphertext.fill(0);
  value.nonce.fill(0);
  value.authTag.fill(0);
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null) {
  return value === null ? null : iso(value);
}

function validDateString(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function safeThumbprint(value: unknown) {
  return typeof value === "string" && /^[0-9A-F]{40,128}$/.test(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
