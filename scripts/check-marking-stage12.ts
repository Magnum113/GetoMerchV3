#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CrptTokenManager, CrptTrueApiClient } from "@/lib/marking/adapters/crpt/client";
import {
  OZON_FBS_RETURNS_CONTRACT_VERSION,
  parseOzonFbsReturnsPage,
} from "@/lib/marking/adapters/ozon/returns";
import { parseMarkingRuntimeConfig } from "@/lib/marking/config";
import {
  buildLpRemoteSaleReturnPayload,
  CRPT_RETURN_CONTRACT_VERSION,
} from "@/lib/marking/domain/crpt-return";
import type { SignerCertificateInfo } from "@/lib/marking/signer/protocol";

main().catch((error) => {
  console.error("Stage 12 return checks failed", error);
  process.exitCode = 1;
});

async function main() {
  testConfiguration();
  testReturnPayload();
  testOzonReturnContract();
  await testTrueApiReturnType();
  await testStaticSafety();
  console.log("Stage 12 Ozon returns, LP_RETURN and custody safety checks passed");
}

function testConfiguration() {
  const disabled = parseMarkingRuntimeConfig({});
  assert.equal(disabled.returnsEnabled, false);
  assert.equal(disabled.ozonReturnsSyncEnabled, false);
  assert.throws(() => parseMarkingRuntimeConfig({
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_RETURNS_ENABLED: "true",
  }));
  const config = parseMarkingRuntimeConfig(stageTwelveEnvironment());
  assert.equal(config.returnsEnabled, true);
  assert.equal(config.ozonReturnsSyncEnabled, true);
}

function testReturnPayload() {
  const km = syntheticKm("04628837736075", "STAGE12-00001");
  try {
    const paid = buildLpRemoteSaleReturnPayload({
      inn: "050000000000",
      actionDate: "2026-08-10",
      returnReference: "RETURN-12-PAID",
      paid: true,
      gtin: "04628837736075",
      markingCode: km,
    });
    const unpaid = buildLpRemoteSaleReturnPayload({
      inn: "050000000000",
      actionDate: "2026-08-10",
      returnReference: "RETURN-12-UNPAID",
      paid: false,
      gtin: "04628837736075",
      markingCode: km,
    });
    assert.equal(CRPT_RETURN_CONTRACT_VERSION, "true-api-lp-return-v649.0-2026-04-15");
    assert.equal(paid.document.return_type, "REMOTE_SALE_RETURN");
    assert.equal(paid.document.primary_document_type, "OTHER");
    assert.equal(unpaid.document.paid, false);
    assert.equal("primary_document_type" in unpaid.document, false);
    assert.equal(paid.document.products_list.length, 1);
    assert.equal(JSON.stringify(paid.document).includes("91ABCD"), false);
    paid.bytes.fill(0);
    unpaid.bytes.fill(0);
  } finally {
    km.fill(0);
  }
}

function testOzonReturnContract() {
  const page = parseOzonFbsReturnsPage({
    returns: [{
      id: 12001,
      posting_number: "POSTING-12",
      product_offer_id: "SYNTHETIC-OFFER-S",
      sku: 900000012,
      quantity: 1,
      status: "moving",
      return_reason_name: "Покупатель не забрал заказ",
      moving_to_place_name: "Ozon warehouse",
    }],
    last_id: "12001",
    has_next: false,
  });
  assert.equal(OZON_FBS_RETURNS_CONTRACT_VERSION,
    "ozon-seller-v3-returns-company-fbs-2026-08-10");
  assert.equal(page.items[0].returnKind, "unknown");
  assert.equal("destination" in page.items[0], false);
  assert.match(page.items[0].snapshotHash, /^[0-9a-f]{64}$/);
  const returned = parseOzonFbsReturnsPage({
    result: { returns: [{
      id: "RETURNED-12",
      posting_number: "POSTING-12",
      product_offer_id: "SYNTHETIC-OFFER-S",
      quantity: 1,
      status: "returned_to_seller",
      return_reason_name: "Покупатель не забрал заказ",
      returned_to_seller_moment: "2026-08-10T12:00:00Z",
    }], has_next: false },
  });
  assert.equal(returned.items[0].returnKind, "not_picked_up_to_seller");
}

async function testTrueApiReturnType() {
  const certificate: SignerCertificateInfo = {
    thumbprint: "A".repeat(40),
    subject: "CN=Stage 12",
    inn: "050000000000",
    ogrn: "123456789012345",
    validFrom: new Date(Date.now() - 60_000).toISOString(),
    validTo: new Date(Date.now() + 86_400_000).toISOString(),
    algorithm: "GOST R 34.10-2012-256",
  };
  const tokens = new CrptTokenManager({
    contour: "sandbox",
    signer: { async sign() { return {
      signatureBase64: Buffer.alloc(96, 1).toString("base64"), certificate,
    }; } },
    fetch: (async (url: string | URL | Request) => String(url).endsWith("/auth/key")
      ? json({ uuid: crypto.randomUUID(), data: Buffer.from("challenge").toString("base64") })
      : json({ uuidToken: "t".repeat(64),
        expireDate: new Date(Date.now() + 3_600_000).toISOString() })) as typeof fetch,
  });
  const requests: Array<Record<string, unknown>> = [];
  const client = new CrptTrueApiClient({
    contour: "sandbox",
    tokenManager: tokens,
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ id: "12121212-1212-4121-8121-121212121212" });
    }) as typeof fetch,
  });
  const payload = Buffer.from('{"return_type":"REMOTE_SALE_RETURN"}', "utf8");
  try {
    await client.createManualDocument({
      documentType: "LP_RETURN",
      productDocument: payload,
      detachedSignatureBase64: Buffer.alloc(96, 2).toString("base64"),
    });
    assert.equal(requests[0]?.type, "LP_RETURN");
    assert.equal(requests[0]?.document_format, "MANUAL");
  } finally {
    payload.fill(0);
  }
}

async function testStaticSafety() {
  const [migration, adapter, execution, service, worker, route, http, page] = await Promise.all([
    readFile("db/migrations/0017_marking_returns_fbo.sql", "utf8"),
    readFile("src/lib/marking/adapters/ozon/returns.ts", "utf8"),
    readFile("src/lib/marking/services/crpt-return-execution.ts", "utf8"),
    readFile("src/lib/marking/services/return-service.ts", "utf8"),
    readFile("src/lib/marking/worker.ts", "utf8"),
    readFile("src/app/api/admin/marking/returns/route.ts", "utf8"),
    readFile("src/lib/marking/http.ts", "utf8"),
    readFile("src/app/marking/page.tsx", "utf8"),
  ]);
  assert.match(migration, /custody_state = 'ozon_fbo'/);
  assert.match(migration, /stockReceived', false/);
  assert.match(migration, /fresh_crpt_state_in_circulation/);
  assert.match(migration, /inventory_transaction_id IS NULL/);
  assert.match(adapter, /return "unknown"/);
  assert.doesNotMatch(adapter, /destination:/);
  assert.match(execution, /documentType: "LP_RETURN"/);
  assert.match(execution, /crpt_submit_outcome_unknown/);
  assert.equal([...execution.matchAll(/\{ scope: "marking" \}/g)].length, 1);
  assert.match(service, /lockSellerReceiptContext[\s\S]*applyInventoryDeltas/);
  assert.match(worker, /marking_return_to_circulation_submit/);
  assert.match(route, /requireMarkingMutationContext/);
  assert.match(http, /MZC16:[\s\S]*признак оплаты/);
  assert.match(page, /Изменить направление/);
  assert.doesNotMatch(execution, /console\.(?:log|error).*markingCode/);
}

function stageTwelveEnvironment() {
  return {
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_SIGNER_ENABLED: "true",
    GETOMERCH_MARKING_OZON_WRITE_ENABLED: "true",
    GETOMERCH_MARKING_CRPT_READ_ENABLED: "true",
    GETOMERCH_MARKING_CRPT_WRITE_ENABLED: "true",
    GETOMERCH_MARKING_CRPT_INTRODUCTION_ENABLED: "true",
    GETOMERCH_MARKING_WITHDRAWAL_ENABLED: "true",
    GETOMERCH_MARKING_RETURNS_ENABLED: "true",
    GETOMERCH_MARKING_OZON_RETURNS_SYNC_ENABLED: "true",
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
