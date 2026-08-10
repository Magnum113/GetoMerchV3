#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import {
  CrptTokenManager,
  CrptTrueApiClient,
} from "@/lib/marking/adapters/crpt/client";
import {
  normalizeCrptCodeState,
  parseCrptCodeInfo,
  parseCrptDocumentStatus,
} from "@/lib/marking/adapters/crpt/contracts";
import { parseMarkingRuntimeConfig } from "@/lib/marking/config";
import {
  processSignerRequest,
  SignerReplayGuard,
} from "@/lib/marking/signer";
import {
  createSignerRequest,
  verifySignerRequest,
  verifySignerResponse,
  type SignerCertificateInfo,
  type SignerRequest,
} from "@/lib/marking/signer/protocol";
import type { MarkingSignatureProvider } from "@/lib/marking/signer/provider";

main().catch((error) => {
  console.error("Stage 9 marking checks failed", error);
  process.exitCode = 1;
});

async function main() {
  testConfiguration();
  await testSignerProtocol();
  await testSingleFlightAuthentication();
  await testExpiredTokenRetry();
  testContracts();
  console.log("Stage 9 signer, CRPT auth and read-only contract checks passed");
}

function testConfiguration() {
  const defaults = parseMarkingRuntimeConfig({});
  assert.equal(defaults.crptReadEnabled, false);
  assert.throws(() => parseMarkingRuntimeConfig({
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_CRPT_READ_ENABLED: "true",
  }));
  const configured = parseMarkingRuntimeConfig(stageNineEnvironment());
  assert.equal(configured.crptReadEnabled, true);
  assert.equal(configured.crptWriteEnabled, false);
  assert.equal(configured.crptContour, "sandbox");
}

async function testSignerProtocol() {
  const secret = randomBytes(32);
  const payload = Buffer.from("synthetic-crpt-challenge", "utf8");
  const clients = new Map([["marking-worker", secret]]);
  const replay = new SignerReplayGuard();
  const provider: MarkingSignatureProvider = {
    certificate: certificate(),
    async sign(input, purpose) {
      assert.equal(purpose, "crpt_auth_attached_cades_bes");
      assert.deepEqual(Buffer.from(input), payload);
      return Buffer.alloc(128, 0x5a);
    },
  };
  try {
    const request = createSignerRequest({
      requestId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      caller: "marking-worker",
      purpose: "crpt_auth_attached_cades_bes",
      payload,
      secret,
    });
    const first = await processSignerRequest({ value: request, clients, provider, replay });
    assert.equal(first.ok, true);
    assert.equal(JSON.stringify(first).includes(payload.toString("utf8")), false);
    if (first.ok) {
      const tamperedCertificate = {
        ...first,
        certificate: { ...first.certificate, inn: "7700000000" },
      };
      assert.throws(
        () => verifySignerResponse(tamperedCertificate, {
          requestId: request.requestId,
          purpose: request.purpose,
          payloadSha256: request.payloadSha256,
        }, secret),
        (error: unknown) => errorCode(error) === "signer_response_auth_failed",
      );
    }
    const duplicate = await processSignerRequest({ value: request, clients, provider, replay });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.ok ? "" : duplicate.errorCode, "signer_replay_detected");

    const unknownPurpose = { ...request, purpose: "document_write" };
    assert.throws(
      () => verifySignerRequest(unknownPurpose, secret),
      (error: unknown) => errorCode(error) === "signer_purpose_denied",
    );

    const digestMismatch: SignerRequest = {
      ...request,
      requestId: crypto.randomUUID(),
      payloadSha256: "0".repeat(64),
      auth: "",
    };
    digestMismatch.auth = requestMac(digestMismatch, secret);
    assert.throws(
      () => verifySignerRequest(digestMismatch, secret),
      (error: unknown) => errorCode(error) === "signer_digest_mismatch",
    );
  } finally {
    secret.fill(0);
    payload.fill(0);
  }
}

async function testSingleFlightAuthentication() {
  let challengeCalls = 0;
  let signInCalls = 0;
  let signerCalls = 0;
  const tokenManager = new CrptTokenManager({
    contour: "sandbox",
    signer: {
      async sign() {
        signerCalls += 1;
        return { signatureBase64: Buffer.alloc(96, 1).toString("base64"), certificate: certificate() };
      },
    },
    fetch: (async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/auth/key")) {
        challengeCalls += 1;
        return json({ uuid: crypto.randomUUID(), data: Buffer.from("challenge").toString("base64") });
      }
      signInCalls += 1;
      return json({ uuidToken: "u".repeat(64), expireDate: new Date(Date.now() + 60 * 60_000).toISOString() });
    }) as typeof fetch,
  });
  const tokens = await Promise.all(Array.from({ length: 20 }, () => tokenManager.getToken()));
  assert.equal(new Set(tokens.map((token) => token.value)).size, 1);
  assert.equal(challengeCalls, 1);
  assert.equal(signInCalls, 1);
  assert.equal(signerCalls, 1);
}

async function testExpiredTokenRetry() {
  let authentication = 0;
  let statusCalls = 0;
  const tokenManager = new CrptTokenManager({
    contour: "sandbox",
    signer: {
      async sign() {
        return { signatureBase64: Buffer.alloc(96, 2).toString("base64"), certificate: certificate() };
      },
    },
    fetch: (async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith("/auth/key")) {
        return json({ uuid: crypto.randomUUID(), data: Buffer.from("challenge").toString("base64") });
      }
      authentication += 1;
      return json({ uuidToken: `token-${authentication}`.padEnd(16, "x"), expireDate: new Date(Date.now() + 60 * 60_000).toISOString() });
    }) as typeof fetch,
  });
  const client = new CrptTrueApiClient({
    contour: "sandbox",
    tokenManager,
    fetch: (async () => {
      statusCalls += 1;
      if (statusCalls === 1) return json({ error_message: "expired" }, 401);
      return json({ id: "DOC-1", status: "CHECKED_OK", type: "LP_INTRODUCE_GOODS" });
    }) as typeof fetch,
  });
  const result = await client.getDocumentStatus("DOC-1");
  assert.equal(result.status, "CHECKED_OK");
  assert.equal(authentication, 2);
  assert.equal(statusCalls, 2);
}

function testContracts() {
  const code = parseCrptCodeInfo([{
    cisInfo: {
      gtin: "04628837736075",
      productGroup: "lp",
      status: "IN_CIRCULATION",
      ownerInn: "050000000000",
    },
  }]);
  assert.equal(code.gtin, "04628837736075");
  assert.equal(normalizeCrptCodeState(code.status), "in_circulation");
  assert.equal(normalizeCrptCodeState("RETIRED"), "withdrawn");
  assert.equal(normalizeCrptCodeState("NEW_FUTURE_STATUS"), "unknown");
  assert.equal(parseCrptDocumentStatus({ status: "CHECKED_OK" }, "DOC-1").status, "CHECKED_OK");
}

function stageNineEnvironment() {
  return {
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_SIGNER_ENABLED: "true",
    GETOMERCH_MARKING_CRPT_READ_ENABLED: "true",
    GETOMERCH_MARKING_ALLOWED_GTINS: "04628837736075",
    GETOMERCH_MARKING_ALLOWED_ADMIN_IDS: "owner",
    GETOMERCH_MARKING_KEYRING_FILE: "/run/credentials/marking-keyring",
    GETOMERCH_MARKING_SIGNER_CLIENT_SECRET_FILE: "/run/credentials/signer-client",
    GETOMERCH_MARKING_SIGNER_CLIENTS_FILE: "/run/credentials/signer-clients",
    GETOMERCH_MARKING_SIGNER_CERTIFICATE_FILE: "/run/credentials/signer-certificate",
    GETOMERCH_MARKING_SIGNER_PROVIDER_COMMAND: "/opt/cprocsp/bin/amd64/cryptcp",
  };
}

function certificate(): SignerCertificateInfo {
  return {
    thumbprint: "A".repeat(40),
    subject: "CN=Synthetic Stage 9",
    inn: "050000000000",
    ogrn: "123456789012345",
    validFrom: new Date(Date.now() - 60_000).toISOString(),
    validTo: new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString(),
    algorithm: "GOST R 34.10-2012-256",
  };
}

function requestMac(request: SignerRequest, secret: Uint8Array) {
  return createHmac("sha256", secret).update([
    request.version,
    request.requestId,
    request.issuedAt,
    request.caller,
    request.purpose,
    request.payloadSha256,
    request.payloadBase64,
  ].join("\n")).digest("hex");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}
