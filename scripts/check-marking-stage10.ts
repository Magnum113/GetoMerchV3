#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CrptTokenManager, CrptTrueApiClient } from "@/lib/marking/adapters/crpt/client";
import { parseCrptDocumentStatus } from "@/lib/marking/adapters/crpt/contracts";
import { parseMarkingRuntimeConfig } from "@/lib/marking/config";
import { buildLpIntroduceGoodsPayload, canonicalJson } from "@/lib/marking/domain/crpt-introduction";
import { createSignerRequest, verifySignerRequest, type SignerCertificateInfo } from "@/lib/marking/signer/protocol";

main().catch((error) => {
  console.error("Stage 10 CRPT introduction checks failed", error);
  process.exitCode = 1;
});

async function main() {
  testConfiguration();
  testCanonicalPayload();
  testDetachedSignerPurpose();
  await testTrueApiContracts();
  await testStaticSafety();
  console.log("Stage 10 payload, signer, True API and no-duplicate safety checks passed");
}

function testConfiguration() {
  assert.equal(parseMarkingRuntimeConfig({}).crptIntroductionEnabled, false);
  assert.throws(() => parseMarkingRuntimeConfig({
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_CRPT_INTRODUCTION_ENABLED: "true",
  }));
  const config = parseMarkingRuntimeConfig(stageTenEnvironment());
  assert.equal(config.crptIntroductionEnabled, true);
  assert.equal(config.crptContour, "sandbox");
}

function testCanonicalPayload() {
  const code = syntheticKm("04628837736075", "STAGE10-00001");
  try {
    const first = buildLpIntroduceGoodsPayload({
      inn: "050000000000",
      gtin: "04628837736075",
      tnvedCode: "6109100000",
      productionDate: "2026-08-04",
      markingCode: code,
    });
    const second = buildLpIntroduceGoodsPayload({
      inn: "050000000000",
      gtin: "04628837736075",
      tnvedCode: "6109100000",
      productionDate: "2026-08-04",
      markingCode: code,
    });
    assert.deepEqual(first.bytes, second.bytes);
    assert.equal(first.document.products[0].uit_code, "010462883773607521STAGE10-00001");
    assert.equal(JSON.stringify(first.document).includes("SIGNATURE"), false);
    assert.equal(JSON.stringify(first.document).includes("certificate_document_data"), false);
    assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
    first.bytes.fill(0);
    second.bytes.fill(0);
  } finally {
    code.fill(0);
  }
}

function testDetachedSignerPurpose() {
  const secret = Buffer.alloc(32, 0x42);
  const payload = Buffer.from("synthetic-introduction", "utf8");
  try {
    const request = createSignerRequest({
      requestId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      caller: "marking-worker",
      purpose: "crpt_document_detached_cades_bes",
      payload,
      secret,
    });
    const verified = verifySignerRequest(request, secret);
    assert.equal(verified.request.purpose, "crpt_document_detached_cades_bes");
    assert.deepEqual(verified.payload, payload);
    verified.payload.fill(0);
  } finally {
    secret.fill(0);
    payload.fill(0);
  }
}

async function testTrueApiContracts() {
  const certificate: SignerCertificateInfo = {
    thumbprint: "A".repeat(40), subject: "CN=Stage 10", inn: "050000000000",
    ogrn: "123456789012345", validFrom: new Date(Date.now() - 60_000).toISOString(),
    validTo: new Date(Date.now() + 86_400_000).toISOString(), algorithm: "GOST R 34.10-2012-256",
  };
  const tokens = new CrptTokenManager({
    contour: "sandbox",
    signer: { async sign() { return { signatureBase64: Buffer.alloc(96, 1).toString("base64"), certificate }; } },
    fetch: (async (url: string | URL | Request) => String(url).endsWith("/auth/key")
      ? json({ uuid: crypto.randomUUID(), data: Buffer.from("challenge").toString("base64") })
      : json({ uuidToken: "t".repeat(64), expireDate: new Date(Date.now() + 3_600_000).toISOString() })) as typeof fetch,
  });
  let captured: { url: string; body: Record<string, unknown> } | null = null;
  const createFixture = JSON.parse(await readFile(
    "tests/fixtures/marking/crpt/true-api-document-create.success.json", "utf8",
  ));
  const client = new CrptTrueApiClient({
    contour: "sandbox", tokenManager: tokens,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) };
      return json(createFixture);
    }) as typeof fetch,
  });
  const payload = Buffer.from('{"synthetic":true}', "utf8");
  const result = await client.createManualDocument({
    documentType: "LP_INTRODUCE_GOODS",
    productDocument: payload,
    detachedSignatureBase64: Buffer.alloc(96, 2).toString("base64"),
  });
  assert.equal(result.externalDocumentId, createFixture.id);
  assert.match(captured!.url, /\/api\/v3\/true-api\/lk\/documents\/create\?pg=lp$/);
  assert.equal(captured!.body.type, "LP_INTRODUCE_GOODS");
  assert.equal(captured!.body.document_format, "MANUAL");
  assert.equal(captured!.body.product_document, payload.toString("base64"));
  const accepted = JSON.parse(await readFile(
    "tests/fixtures/marking/crpt/true-api-document-info.accepted.json", "utf8",
  ));
  assert.equal(parseCrptDocumentStatus(accepted, createFixture.id).status, "CHECKED_OK");
  const rejected = JSON.parse(await readFile(
    "tests/fixtures/marking/crpt/true-api-document-info.rejected.json", "utf8",
  ));
  const rejectedStatus = parseCrptDocumentStatus(rejected, createFixture.id);
  assert.equal(rejectedStatus.status, "PARSE_ERROR");
  assert.equal(rejectedStatus.errorCode, "INTRO_ERROR");
  assert.equal(rejectedStatus.errorMessage, "SANITIZED_VALIDATION_ERROR");
  payload.fill(0);
}

async function testStaticSafety() {
  const execution = await readFile("src/lib/marking/services/crpt-introduction-execution.ts", "utf8");
  const migration = await readFile("db/migrations/0015_marking_crpt_introduction.sql", "utf8");
  const materialOfferSourceMigration = await readFile(
    "db/migrations/0020_marking_crpt_material_offer_source.sql",
    "utf8",
  );
  const repository = await readFile("src/lib/marking/repositories/documents.ts", "utf8");
  const workerBootstrap = await readFile("ops/getomerch-marking-postgres-bootstrap", "utf8");
  assert.doesNotMatch(execution, /\/utilisation|REPORT_UTILIZE/);
  assert.match(execution, /submit_ambiguous/);
  assert.match(execution, /crpt_submit_outcome_unknown/);
  assert.match(execution, /material\.status === "submitting"/);
  assert.match(execution, /inCanaryScope/);
  assert.match(execution, /recordIntroductionCirculationReview/);
  assert.match(execution, /requires_manual_review/);
  assert.match(migration, /terminal marking document is immutable/);
  assert.match(migration, /ambiguous submission must be reconciled before correction/);
  assert.match(migration, /circulation_state/);
  assert.match(migration, /payload_ciphertext/);
  assert.match(materialOfferSourceMigration, /item\.offer_id/);
  assert.match(
    materialOfferSourceMigration,
    /JOIN public\.merch_fulfillment_order_items AS item/,
  );
  assert.doesNotMatch(materialOfferSourceMigration, /assignment\.offer_id/);
  assert.match(workerBootstrap, /GRANT SELECT ON getomerch_marking\.document_safe,[\s\S]*?TO \$ROLE/);
  for (const routine of [
    "prepare_introduction_document",
    "get_introduction_document_material",
    "store_introduction_payload",
    "store_introduction_signature",
    "record_introduction_submitted",
    "record_introduction_submit_started",
    "record_introduction_poll",
    "record_introduction_manual_review",
    "record_introduction_circulation_review",
    "confirm_introduction_circulation",
  ]) {
    assert.match(workerBootstrap, new RegExp(
      `GRANT EXECUTE ON FUNCTION getomerch_marking\\.${routine}\\(`,
    ));
  }
  assert.doesNotMatch(repository, /SELECT \*/i);
  const safeList = repository.slice(
    repository.indexOf("export async function listMarkingDocuments"),
    repository.indexOf("type MaterialRow"),
  );
  assert.doesNotMatch(safeList, /code_ciphertext|payload_ciphertext|signature_ciphertext/);
}

function stageTenEnvironment() {
  return {
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_SIGNER_ENABLED: "true",
    GETOMERCH_MARKING_CRPT_READ_ENABLED: "true",
    GETOMERCH_MARKING_CRPT_WRITE_ENABLED: "true",
    GETOMERCH_MARKING_CRPT_INTRODUCTION_ENABLED: "true",
    GETOMERCH_MARKING_JUST_IN_TIME_ENABLED: "true",
    GETOMERCH_MARKING_ALLOWED_GTINS: "04628837736075",
    GETOMERCH_MARKING_ALLOWED_OFFERS: "SYNTHETIC-OFFER-S",
    GETOMERCH_MARKING_ALLOWED_ADMIN_IDS: "owner",
    GETOMERCH_MARKING_KEYRING_FILE: "/run/credentials/marking-keyring",
    GETOMERCH_MARKING_SIGNER_CLIENT_SECRET_FILE: "/run/credentials/signer-client",
    GETOMERCH_MARKING_SIGNER_CLIENTS_FILE: "/run/credentials/signer-clients",
    GETOMERCH_MARKING_SIGNER_CERTIFICATE_FILE: "/run/credentials/signer-certificate",
    GETOMERCH_MARKING_SIGNER_PROVIDER_COMMAND: "/opt/cprocsp/bin/amd64/cryptcp",
    GETOMERCH_MARKING_CRPT_INN: "050000000000",
  };
}

function syntheticKm(gtin: string, serial: string) {
  return Buffer.concat([Buffer.from(`]d201${gtin}21${serial}`, "ascii"), Buffer.from([0x1d]),
    Buffer.from("91ABCD", "ascii"), Buffer.from([0x1d]), Buffer.from(`92${"S".repeat(44)}`, "ascii")]);
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
