#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CrptTokenManager, CrptTrueApiClient } from "@/lib/marking/adapters/crpt/client";
import { parseMarkingRuntimeConfig } from "@/lib/marking/config";
import {
  buildLkReceiptDistancePayload,
  CRPT_WITHDRAWAL_CONTRACT_VERSION,
  CrptWithdrawalPayloadError,
} from "@/lib/marking/domain/crpt-withdrawal";
import type { SignerCertificateInfo } from "@/lib/marking/signer/protocol";

main().catch((error) => {
  console.error("Stage 11 shipping and withdrawal checks failed", error);
  process.exitCode = 1;
});

async function main() {
  testConfiguration();
  testDistancePayload();
  await testTrueApiDocumentType();
  await testStaticSafety();
  console.log("Stage 11 gate, LK_RECEIPT/DISTANCE and safety checks passed");
}

function testConfiguration() {
  assert.equal(parseMarkingRuntimeConfig({}).withdrawalEnabled, false);
  assert.throws(() => parseMarkingRuntimeConfig({
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_WITHDRAWAL_ENABLED: "true",
  }));
  const config = parseMarkingRuntimeConfig(stageElevenEnvironment());
  assert.equal(config.withdrawalEnabled, true);
  assert.equal(config.shippingGateMode, "enforce");
}

function testDistancePayload() {
  const firstCode = syntheticKm("04628837736075", "STAGE11-00002");
  const secondCode = syntheticKm("04628837736075", "STAGE11-00001");
  try {
    const input = {
      inn: "050000000000",
      actionDate: "2026-08-09",
      postingNumber: "SYNTHETIC-FBS-POSTING-11",
      kpp: "050001001",
      fiasId: "11111111-1111-4111-8111-111111111111",
      products: [
        { gtin: "04628837736075", productCostMinor: 670_000, markingCode: firstCode },
        { gtin: "04628837736075", productCostMinor: 670_000, markingCode: secondCode },
      ],
    };
    const first = buildLkReceiptDistancePayload(input);
    const second = buildLkReceiptDistancePayload(input);
    assert.deepEqual(first.bytes, second.bytes);
    assert.equal(CRPT_WITHDRAWAL_CONTRACT_VERSION, "true-api-lk-receipt-v649.0-2026-04-15");
    assert.deepEqual(Object.keys(first.document), [
      "action", "action_date", "document_date", "document_number",
      "document_type", "fias_id", "inn", "kpp",
      "primary_document_custom_name", "products",
    ]);
    assert.equal(first.document.action, "DISTANCE");
    assert.equal(first.document.document_type, "OTHER");
    assert.equal(first.document.products[0].product_cost, 670_000);
    assert.ok(first.document.products[0].cis < first.document.products[1].cis);
    assert.equal(JSON.stringify(first.document).includes("SIGNATURE"), false);
    first.bytes.fill(0);
    second.bytes.fill(0);
    assert.throws(() => buildLkReceiptDistancePayload({
      ...input,
      products: [input.products[0], input.products[0]],
    }), CrptWithdrawalPayloadError);
    assert.throws(() => buildLkReceiptDistancePayload({
      ...input,
      products: [{ ...input.products[0], productCostMinor: 0 }],
    }), CrptWithdrawalPayloadError);
  } finally {
    firstCode.fill(0);
    secondCode.fill(0);
  }
}

async function testTrueApiDocumentType() {
  const certificate: SignerCertificateInfo = {
    thumbprint: "A".repeat(40),
    subject: "CN=Stage 11",
    inn: "050000000000",
    ogrn: "123456789012345",
    validFrom: new Date(Date.now() - 60_000).toISOString(),
    validTo: new Date(Date.now() + 86_400_000).toISOString(),
    algorithm: "GOST R 34.10-2012-256",
  };
  const tokens = new CrptTokenManager({
    contour: "sandbox",
    signer: {
      async sign() {
        return {
          signatureBase64: Buffer.alloc(96, 1).toString("base64"),
          certificate,
        };
      },
    },
    fetch: (async (url: string | URL | Request) => String(url).endsWith("/auth/key")
      ? json({ uuid: crypto.randomUUID(), data: Buffer.from("challenge").toString("base64") })
      : json({
        uuidToken: "t".repeat(64),
        expireDate: new Date(Date.now() + 3_600_000).toISOString(),
      })) as typeof fetch,
  });
  const requests: Array<Record<string, unknown>> = [];
  const client = new CrptTrueApiClient({
    contour: "sandbox",
    tokenManager: tokens,
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ id: "11111111-1111-4111-8111-111111111111" });
    }) as typeof fetch,
  });
  const payload = Buffer.from('{"action":"DISTANCE"}', "utf8");
  try {
    await client.createManualDocument({
      documentType: "LK_RECEIPT",
      productDocument: payload,
      detachedSignatureBase64: Buffer.alloc(96, 2).toString("base64"),
    });
    assert.equal(requests[0]?.type, "LK_RECEIPT");
    assert.equal(requests[0]?.document_format, "MANUAL");
  } finally {
    payload.fill(0);
  }
}

async function testStaticSafety() {
  const migration = await readFile(
    "db/migrations/0016_marking_shipping_withdrawal.sql",
    "utf8",
  );
  const execution = await readFile(
    "src/lib/marking/services/crpt-withdrawal-execution.ts",
    "utf8",
  );
  const mutation = await readFile("src/lib/db/mutations/ozon.ts", "utf8");
  const worker = await readFile("src/lib/marking/worker.ts", "utf8");
  const queue = await readFile("src/lib/jobs/queue.ts", "utf8");
  const repository = await readFile(
    "src/lib/marking/repositories/withdrawals.ts",
    "utf8",
  );
  assert.match(migration, /operator-handover-v1/);
  assert.match(migration, /awaiting_packaging[\s\S]*awaiting_deliver/);
  assert.match(migration, /successfulHandoff', false/);
  assert.match(migration, /evaluation\.evaluated_by = p_actor_id/);
  assert.match(migration, /evaluation\.request_id = p_request_id/);
  const handoverFunction = migration.indexOf(
    "CREATE OR REPLACE FUNCTION getomerch_marking.record_shipping_handover",
  );
  const physicalCustodyUpdate = migration.indexOf("SET unit_state = 'shipped'", handoverFunction);
  const observeBlockerBranch = migration.indexOf("IF NOT gate_record.allowed THEN", handoverFunction);
  assert.ok(physicalCustodyUpdate > handoverFunction);
  assert.ok(observeBlockerBranch > physicalCustodyUpdate);
  assert.doesNotMatch(
    migration.slice(migration.indexOf("reconcile_jit_order_trigger")),
    /delivering|delivered|driver_pickup|sent_by_seller/,
  );
  assert.match(mutation, /marking_shipping_blocked[\s\S]*after_inventory/);
  assert.match(mutation, /recordShippingHandover[\s\S]*marking_withdrawal_submit/);
  assert.match(execution, /documentType: "LK_RECEIPT"/);
  assert.match(execution, /crpt_submit_outcome_unknown/);
  assert.match(execution, /inCanaryScope/);
  assert.equal([...execution.matchAll(/\{ scope: "marking" \}/g)].length, 1);
  assert.match(worker, /reconcileTerminalWithdrawalFailure/);
  assert.match(queue, /marking_withdrawal_cancel_forbidden/);
  assert.match(queue, /marking_crpt_document_poll[\s\S]*withdrawal_remote_sale/);
  assert.doesNotMatch(repository, /SELECT \*/i);
  assert.doesNotMatch(execution, /console\.(?:log|error).*markingCode/);
}

function stageElevenEnvironment() {
  return {
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_SIGNER_ENABLED: "true",
    GETOMERCH_MARKING_OZON_WRITE_ENABLED: "true",
    GETOMERCH_MARKING_CRPT_READ_ENABLED: "true",
    GETOMERCH_MARKING_CRPT_WRITE_ENABLED: "true",
    GETOMERCH_MARKING_CRPT_INTRODUCTION_ENABLED: "true",
    GETOMERCH_MARKING_WITHDRAWAL_ENABLED: "true",
    GETOMERCH_MARKING_JUST_IN_TIME_ENABLED: "true",
    GETOMERCH_MARKING_SHIPPING_GATE_MODE: "enforce",
    GETOMERCH_MARKING_ALLOWED_GTINS: "04628837736075",
    GETOMERCH_MARKING_ALLOWED_OFFERS: "SYNTHETIC-OFFER-S",
    GETOMERCH_MARKING_ALLOWED_ADMIN_IDS: "owner",
    GETOMERCH_MARKING_KEYRING_FILE: "/run/credentials/marking-keyring",
    GETOMERCH_MARKING_SIGNER_CLIENT_SECRET_FILE: "/run/credentials/signer-client",
    GETOMERCH_MARKING_SIGNER_CLIENTS_FILE: "/run/credentials/signer-clients",
    GETOMERCH_MARKING_SIGNER_CERTIFICATE_FILE: "/run/credentials/signer-certificate",
    GETOMERCH_MARKING_SIGNER_PROVIDER_COMMAND: "/opt/cprocsp/bin/amd64/cryptcp",
    GETOMERCH_MARKING_CRPT_INN: "050000000000",
    OZON_CLIENT_ID: "synthetic-client",
    OZON_API_KEY: "synthetic-api-key",
  };
}

function syntheticKm(gtin: string, serial: string) {
  return Buffer.concat([
    Buffer.from(`]d201${gtin}21${serial}`, "ascii"),
    Buffer.from([0x1d]),
    Buffer.from("91ABCD", "ascii"),
    Buffer.from([0x1d]),
    Buffer.from(`92${"S".repeat(44)}`, "ascii"),
  ]);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
