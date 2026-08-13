#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { QueryResultRow } from "pg";
import {
  createAgentRequestAuth,
  createAgentResponseAuth,
  parseAgentTelemetry,
  verifyAgentRequestAuth,
  verifyAgentResponseAuth,
} from "@/lib/marking/agent/protocol";
import { clearRecoveredAgentConnectionError } from "@/lib/marking/agent/runtime";
import { parseMarkingRuntimeConfig } from "@/lib/marking/config";
import type { DatabaseQueryExecutor, DatabaseQueryResult } from "@/lib/db/pool";
import { MarkingKeyring } from "@/lib/marking/security/keyring";
import { resolveSigningAgentState } from "@/lib/marking/repositories/remote-signer";
import { exchangeSignerRequest } from "@/lib/marking/signer/client";
import { providerErrorFromStderr } from "@/lib/marking/signer/provider";
import { createRemoteMarkingSignerClient } from "@/lib/marking/signer/remote-client";
import type { SignerCertificateInfo } from "@/lib/marking/signer/protocol";

const TEST_ID = "10000000-0000-4000-8000-000000000001";

main().catch((error) => {
  console.error("Mac marking agent checks failed", error);
  process.exitCode = 1;
});

async function main() {
  testAgentProtocol();
  testTelemetry();
  testRecoveredConnectionError();
  testOperationalFailureStates();
  testRemoteConfiguration();
  await testDelayedUnixSocketResponse();
  await testEncryptedBrokerClient();
  console.log("Mac marking agent protocol, encryption and remote signer checks passed");
}

function testOperationalFailureStates() {
  const now = Date.now();
  assert.equal(resolveSigningAgentState("ready", new Date(now - 16_000), now), "offline");
  assert.equal(resolveSigningAgentState("ready", new Date(now - 14_000), now), "ready");
  assert.equal(
    providerErrorFromStderr("Error: License is expired. [ErrorCode: 0x20000325]").code,
    "provider_license_expired",
  );
  const opaqueProviderError = providerErrorFromStderr([
    "internal provider detail that must not be exposed",
    "[ErrorCode: 0x80090020]",
  ].join("\n"));
  assert.equal(opaqueProviderError.code, "provider_exit_error");
  assert.equal(
    opaqueProviderError.message,
    "Signature provider returned an error (0x80090020)",
  );
  assert.equal(opaqueProviderError.message.includes("internal provider detail"), false);
}

async function testDelayedUnixSocketResponse() {
  const socketPath = join("/tmp", `gm-signer-${randomUUID()}.sock`);
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let body = "";
    socket.on("data", (chunk) => {
      body += chunk;
      if (!body.includes("\n")) return;
      setTimeout(() => socket.end(`${JSON.stringify({ ok: true })}\n`), 10);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    assert.deepEqual(
      await exchangeSignerRequest(socketPath, { operation: "delayed-response" }, 2_000),
      { ok: true },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => undefined);
  }
}

function testRecoveredConnectionError() {
  for (const errorCode of [
    "agent_auth_failed",
    "agent_endpoint_disabled",
    "agent_response_auth_failed",
    "agent_response_invalid",
    "agent_server_unavailable",
  ]) {
    assert.equal(clearRecoveredAgentConnectionError({
      code: errorCode,
      message: "Recovered transport failure",
    }), null);
  }
  const providerError = { code: "provider_pin_unavailable", message: "PIN required" };
  assert.deepEqual(clearRecoveredAgentConnectionError(providerError), providerError);
  assert.equal(clearRecoveredAgentConnectionError(null), null);
}

function testAgentProtocol() {
  const secret = randomBytes(48);
  const body = JSON.stringify({ version: 1, operation: "heartbeat", telemetry: {} });
  try {
    const auth = createAgentRequestAuth({
      method: "POST",
      pathname: "/api/marking-agent/v1",
      agentId: "macbook-marking",
      body,
      secret,
    });
    const headers = lower(auth.headers);
    const verified = verifyAgentRequestAuth({
      method: "POST",
      pathname: "/api/marking-agent/v1",
      headers,
      body,
      secret,
    });
    assert.equal(verified.requestId, auth.requestId);
    assert.throws(() => verifyAgentRequestAuth({
      method: "POST",
      pathname: "/api/marking-agent/v1",
      headers,
      body: `${body} `,
      secret,
    }), (error: unknown) => code(error) === "agent_auth_failed");
    assert.throws(() => createAgentRequestAuth({
      method: "POST",
      pathname: "/api/marking-agent/v1",
      agentId: "macbook-marking",
      issuedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      body,
      secret,
    }), (error: unknown) => code(error) === "agent_auth_failed");

    const responseBody = JSON.stringify({ ok: true });
    const responseHeaders = createAgentResponseAuth({
      status: 200,
      requestId: auth.requestId,
      body: responseBody,
      secret,
    });
    verifyAgentResponseAuth({
      status: 200,
      expectedRequestId: auth.requestId,
      headers: lower(responseHeaders),
      body: responseBody,
      secret,
    });
    assert.throws(() => verifyAgentResponseAuth({
      status: 200,
      expectedRequestId: auth.requestId,
      headers: lower(responseHeaders),
      body: JSON.stringify({ ok: false }),
      secret,
    }), (error: unknown) => code(error) === "agent_response_auth_failed");
  } finally {
    secret.fill(0);
  }
}

function testTelemetry() {
  const parsed = parseAgentTelemetry({
    displayName: "MacBook marking",
    state: "ready",
    readerDetected: true,
    signerReachable: true,
    pinState: "unknown",
    certificateThumbprint: "A".repeat(40),
    certificateValidTo: new Date(Date.now() + 86_400_000).toISOString(),
    softwareVersion: "1.0.0",
    errorCode: null,
    errorMessage: null,
  });
  assert.equal(parsed.readerDetected, true);
  assert.throws(() => parseAgentTelemetry({ ...parsed, errorCode: undefined }));
  assert.throws(() => parseAgentTelemetry({ ...parsed, certificateThumbprint: "A".repeat(39) }));
}

function testRemoteConfiguration() {
  const config = parseMarkingRuntimeConfig({
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_SIGNER_ENABLED: "true",
    GETOMERCH_MARKING_CRPT_READ_ENABLED: "true",
    GETOMERCH_MARKING_SIGNER_TRANSPORT: "remote",
    GETOMERCH_MARKING_KEYRING_FILE: "/run/credentials/marking-keyring",
    GETOMERCH_MARKING_AGENT_SECRETS_FILE: "/run/credentials/marking-agent-secrets",
    GETOMERCH_MARKING_ALLOWED_GTINS: "04628837736075",
    GETOMERCH_MARKING_ALLOWED_ADMIN_IDS: "owner",
  });
  assert.equal(config.signerTransport, "remote");
  assert.equal(config.signerProviderCommand, "");
  const workerConfig = parseMarkingRuntimeConfig({
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_SIGNER_ENABLED: "true",
    GETOMERCH_MARKING_CRPT_READ_ENABLED: "true",
    GETOMERCH_MARKING_SIGNER_TRANSPORT: "remote",
    GETOMERCH_MARKING_KEYRING_FILE: "/run/credentials/marking-keyring",
    GETOMERCH_MARKING_ALLOWED_GTINS: "04628837736075",
    GETOMERCH_MARKING_ALLOWED_ADMIN_IDS: "owner",
  });
  assert.equal(workerConfig.agentSecretsFile, "");
}

async function testEncryptedBrokerClient() {
  const encryptionKey = randomBytes(32);
  const hmacKey = randomBytes(32);
  const keyring = new MarkingKeyring({
    currentEncryptionKeyVersion: 1,
    encryptionKeys: { 1: encryptionKey.toString("base64") },
    currentHmacKeyVersion: 1,
    hmacKeys: { 1: hmacKey.toString("base64") },
  });
  const expectedSignature = Buffer.alloc(128, 0x5a);
  const encryptedSignature = keyring.encryptBytes(expectedSignature);
  let resultReads = 0;
  let consumed = false;
  let persistedPayload = "";
  const query: DatabaseQueryExecutor = async <Row extends QueryResultRow>(
    sql: string,
    values: readonly unknown[] = [],
  ) => {
    if (sql.includes("create_remote_signature_request")) {
      persistedPayload = JSON.stringify(values.map((value) => Buffer.isBuffer(value) ? value.toString("base64") : value));
      return rows<Row>([{ signature_request_id: TEST_ID, request_status: "pending", reused: false }]);
    }
    if (sql.includes("get_remote_signature_result")) {
      resultReads += 1;
      if (resultReads === 1) {
        return rows<Row>([pendingResult()]);
      }
      return rows<Row>([signedResult(encryptedSignature, certificate())]);
    }
    if (sql.includes("consume_remote_signature_request")) {
      consumed = true;
      return rows<Row>([]);
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  try {
    const client = createRemoteMarkingSignerClient({
      query,
      keyring,
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });
    const payload = Buffer.from("synthetic-remote-crpt-challenge", "utf8");
    const result = await client.sign(payload, "crpt_auth_attached_cades_bes");
    assert.equal(result.signatureBase64, expectedSignature.toString("base64"));
    assert.equal(result.certificate.thumbprint, certificate().thumbprint);
    assert.equal(consumed, true);
    assert.equal(persistedPayload.includes(payload.toString("utf8")), false);
    payload.fill(0);
  } finally {
    encryptionKey.fill(0);
    hmacKey.fill(0);
    expectedSignature.fill(0);
  }
}

function pendingResult() {
  return {
    request_status: "pending",
    signature_ciphertext: null,
    signature_nonce: null,
    signature_auth_tag: null,
    signature_key_version: null,
    certificate_thumbprint: null,
    certificate_subject: null,
    certificate_inn: null,
    certificate_ogrn: null,
    certificate_valid_from: null,
    certificate_valid_to: null,
    certificate_algorithm: null,
    error_code: null,
    error_message: null,
    expires_at: new Date(Date.now() + 60_000),
  };
}

function signedResult(
  encrypted: ReturnType<MarkingKeyring["encryptBytes"]>,
  cert: SignerCertificateInfo,
) {
  return {
    request_status: "signed",
    signature_ciphertext: Buffer.from(encrypted.ciphertext, "base64"),
    signature_nonce: Buffer.from(encrypted.iv, "base64"),
    signature_auth_tag: Buffer.from(encrypted.authTag, "base64"),
    signature_key_version: encrypted.keyVersion,
    certificate_thumbprint: cert.thumbprint,
    certificate_subject: cert.subject,
    certificate_inn: cert.inn,
    certificate_ogrn: cert.ogrn,
    certificate_valid_from: cert.validFrom,
    certificate_valid_to: cert.validTo,
    certificate_algorithm: cert.algorithm,
    error_code: null,
    error_message: null,
    expires_at: new Date(Date.now() + 60_000),
  };
}

function certificate(): SignerCertificateInfo {
  return {
    thumbprint: "A".repeat(40),
    subject: "CN=Synthetic Mac agent",
    inn: "050000000000",
    ogrn: "123456789012345",
    validFrom: new Date(Date.now() - 60_000).toISOString(),
    validTo: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    algorithm: "GOST R 34.10-2012-256",
  };
}

function rows<Row extends QueryResultRow>(values: unknown[]): DatabaseQueryResult<Row> {
  return { rows: values as Row[], rowCount: values.length };
}

function lower(value: Record<string, string>) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.toLowerCase(), item]));
}

function code(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}
