#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CrptTokenManager } from "@/lib/marking/adapters/crpt/client";
import { SuzApiClient, SuzApiError } from "@/lib/marking/adapters/suz/client";
import {
  buildSuzLpOrder,
  parseSuzCodeBlocks,
  parseSuzOrderStatus,
  parseSuzUtilisationReceipt,
} from "@/lib/marking/adapters/suz/contracts";
import { parseMarkingRuntimeConfig } from "@/lib/marking/config";
import { createSignerRequest, verifySignerRequest, type SignerCertificateInfo } from "@/lib/marking/signer/protocol";

const GTIN = "04628837736075";
const OMS_ID = "cdf12109-10d3-41e6-8b6f-0050569977a1";
const OMS_CONNECTION = "91d396f6-1d2c-40d9-98c7-05f64c402e5d";
const ORDER_ID = "b024ae09-ef7c-449e-b461-05d8eb116c79";
const BLOCK_ID = "a024ae09-ef7c-449e-b461-05d8eb116c90";

main().catch((error) => {
  console.error("Stage 13 SUZ checks failed", error);
  process.exitCode = 1;
});

async function main() {
  testConfiguration();
  testOrderContract();
  testSignerPurpose();
  testResponseContracts();
  await testDynamicClientTokenAndCreate();
  await testCodeIssueAmbiguity();
  await testStaticSafety();
  console.log("Stage 13 SUZ contract, signer, recovery and safety checks passed");
}

function testConfiguration() {
  assert.equal(parseMarkingRuntimeConfig({}).suzWriteEnabled, false);
  assert.throws(() => parseMarkingRuntimeConfig({
    ...stageThirteenEnvironment(),
    GETOMERCH_MARKING_IMPORT_ENABLED: "false",
  }));
  const config = parseMarkingRuntimeConfig(stageThirteenEnvironment());
  assert.equal(config.suzWriteEnabled, true);
  assert.equal(config.suzOmsId, OMS_ID);
  assert.equal(config.suzOmsConnection, OMS_CONNECTION);
}

function testOrderContract() {
  const built = buildSuzLpOrder({ gtin: GTIN, quantity: 25 });
  try {
    assert.deepEqual(built.payload, {
      productGroup: "lp",
      products: [{
        gtin: GTIN,
        quantity: 25,
        serialNumberType: "OPERATOR",
        templateId: 10,
        cisType: "UNIT",
      }],
      attributes: {
        releaseMethodType: "PRODUCTION",
        createMethodType: "SELF_MADE",
      },
    });
    assert.equal(built.requestHash.length, 64);
    assert.equal(JSON.stringify(built.payload).includes("code"), false);
  } finally {
    built.bytes.fill(0);
  }
}

function testSignerPurpose() {
  const secret = Buffer.alloc(32, 0x33);
  const payload = Buffer.from("synthetic-suz-order", "utf8");
  try {
    const request = createSignerRequest({
      requestId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      caller: "marking-worker",
      purpose: "crpt_suz_order_detached_cades_bes",
      payload,
      secret,
    });
    const verified = verifySignerRequest(request, secret);
    assert.equal(verified.request.purpose, "crpt_suz_order_detached_cades_bes");
    verified.payload.fill(0);
  } finally {
    secret.fill(0);
    payload.fill(0);
  }
}

function testResponseContracts() {
  const status = parseSuzOrderStatus({
    orderId: ORDER_ID,
    productGroup: "lp",
    orderStatus: "READY",
    buffers: [{
      gtin: GTIN,
      bufferStatus: "ACTIVE",
      availableCodes: 25,
      templateId: 10,
    }],
  }, GTIN);
  assert.equal(status.availableCodes, 25);
  const blocks = parseSuzCodeBlocks({
    orderId: ORDER_ID,
    omsId: OMS_ID,
    gtin: GTIN,
    blocks: [{ blockId: BLOCK_ID, blockDateTime: 1573986891, quantity: 25 }],
  }, ORDER_ID, GTIN);
  assert.deepEqual(blocks.blocks, [{ blockId: BLOCK_ID, quantity: 25 }]);
  const receipt = parseSuzUtilisationReceipt({
    totalCount: 1,
    results: [{
      resultDocId: "7657ca8e-45e0-4c4f-a0b7-889412df4d44",
      workflow: "REPORT_UTILIZE",
      state: "SUCCESS",
      code: 0,
      operations: [{
        operationType: "RNMS_GIS_PROCESSED",
        details: { gtin: GTIN, processed: 25, total: 25 },
      }],
    }],
  }, GTIN);
  assert.equal(receipt?.processed, 25);
  assert.throws(() => parseSuzUtilisationReceipt({
    totalCount: 1,
    results: [{
      resultDocId: "7657ca8e-45e0-4c4f-a0b7-889412df4d44",
      workflow: "REPORT_UTILIZE",
      state: "SUCCESS",
      code: 0,
      operations: [{ operationType: "RNMS_GIS_PROCESSED",
        details: { gtin: "04628837736068", processed: 25, total: 25 } }],
    }],
  }, GTIN));
}

async function testDynamicClientTokenAndCreate() {
  let signInUrl = "";
  let signInBody: Record<string, unknown> = {};
  const tokens = tokenManager(async (url, init) => {
    if (String(url).endsWith("/auth/key")) {
      return json({ uuid: crypto.randomUUID(), data: Buffer.from("challenge").toString("base64") });
    }
    signInUrl = String(url);
    signInBody = JSON.parse(String(init?.body));
    return json({ uuidToken: "t".repeat(64), expireDate: new Date(Date.now() + 3_600_000).toISOString() });
  });
  let capturedHeaders: Headers | null = null;
  let capturedBody = "";
  const client = new SuzApiClient({
    contour: "sandbox",
    omsId: OMS_ID,
    tokenManager: tokens,
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      capturedBody = Buffer.from(init?.body as Uint8Array).toString("utf8");
      return json({ omsId: OMS_ID, orderId: ORDER_ID, expectedCompletionTime: 1000 });
    }) as typeof fetch,
  });
  const built = buildSuzLpOrder({ gtin: GTIN, quantity: 2 });
  try {
    const created = await client.createOrder(built.bytes, Buffer.alloc(96, 2).toString("base64"));
    assert.equal(created.orderId, ORDER_ID);
    assert.match(signInUrl, new RegExp(`/auth/simpleSignIn/${OMS_CONNECTION}$`));
    assert.equal("unitedToken" in signInBody, false);
    assert.equal(capturedHeaders!.get("clientToken"), "t".repeat(64));
    assert.equal(capturedHeaders!.get("X-Signature"), Buffer.alloc(96, 2).toString("base64"));
    assert.deepEqual(JSON.parse(capturedBody), built.payload);
  } finally {
    built.bytes.fill(0);
  }
}

async function testCodeIssueAmbiguity() {
  const tokens = tokenManager(async (url, init) => String(url).endsWith("/auth/key")
    ? json({ uuid: crypto.randomUUID(), data: Buffer.from("challenge").toString("base64") })
    : json({ uuidToken: "x".repeat(64), expireDate: new Date(Date.now() + 3_600_000).toISOString() }));
  const ambiguous = new SuzApiClient({
    contour: "sandbox",
    omsId: OMS_ID,
    tokenManager: tokens,
    fetch: (async () => { throw new Error("network disconnected"); }) as typeof fetch,
  });
  await assert.rejects(
    ambiguous.getCodes(ORDER_ID, GTIN, 1),
    (error: unknown) => error instanceof SuzApiError
      && error.outcomeUnknown && !error.retryable,
  );
  const recovery = new SuzApiClient({
    contour: "sandbox",
    omsId: OMS_ID,
    tokenManager: tokens,
    fetch: (async (url: string | URL | Request) => String(url).includes("/codes/blocks")
      ? json({ orderId: ORDER_ID, omsId: OMS_ID, gtin: GTIN,
        blocks: [{ blockId: BLOCK_ID, blockDateTime: 1, quantity: 1 }] })
      : json({ omsId: OMS_ID, blockId: BLOCK_ID,
        codes: [syntheticKm(GTIN, "STAGE13-00001")] })) as typeof fetch,
  });
  const blocks = await recovery.listCodeBlocks(ORDER_ID, GTIN);
  assert.equal(blocks.blocks[0].blockId, BLOCK_ID);
  const codes = await recovery.getCodesByBlock(BLOCK_ID, 1);
  assert.equal(codes.codes.length, 1);
  codes.codes.fill("");
}

async function testStaticSafety() {
  const files = await Promise.all([
    "src/lib/marking/services/suz-order-execution.ts",
    "src/lib/marking/repositories/suz-orders.ts",
    "src/app/api/admin/marking/suz/route.ts",
    "src/components/marking/suz-orders-panel.tsx",
    "db/migrations/0018_marking_suz_orders.sql",
    "src/lib/marking/services/suz-order-service.ts",
  ].map((path) => readFile(path, "utf8")));
  const joined = files.join("\n");
  assert.match(joined, /pending_utilisation/);
  assert.match(joined, /REPORT_UTILIZE/);
  assert.match(joined, /requireMarkingMutationContext/);
  assert.match(files[0], /material\.orderStatus === "manual_review"/);
  assert.match(joined, /marking\.suz-order\.approve/);
  assert.match(files[4], /trade_item\.product_group = 'clothes'/);
  assert.match(files[4], /trade_record\.product_group <> 'clothes'/);
  assert.doesNotMatch(joined, /console\.(log|error)\([^\n]*(codes|signatureBase64|clientToken)/);
  assert.doesNotMatch(files[1], /SELECT \*/i);
}

function stageThirteenEnvironment() {
  return {
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_IMPORT_ENABLED: "true",
    GETOMERCH_MARKING_SIGNER_ENABLED: "true",
    GETOMERCH_MARKING_SIGNER_TRANSPORT: "remote",
    GETOMERCH_MARKING_SUZ_WRITE_ENABLED: "true",
    GETOMERCH_MARKING_ALLOWED_GTINS: GTIN,
    GETOMERCH_MARKING_ALLOWED_ADMIN_IDS: "owner",
    GETOMERCH_MARKING_KEYRING_FILE: "/run/credentials/marking-keyring",
    GETOMERCH_MARKING_SUZ_OMS_ID: OMS_ID,
    GETOMERCH_MARKING_SUZ_OMS_CONNECTION: OMS_CONNECTION,
  };
}

function tokenManager(fetcher: typeof fetch) {
  return new CrptTokenManager({
    contour: "sandbox",
    omsConnection: OMS_CONNECTION,
    signer: { async sign() { return { signatureBase64: Buffer.alloc(96, 1).toString("base64"), certificate: certificate() }; } },
    fetch: fetcher,
  });
}

function certificate(): SignerCertificateInfo {
  return {
    thumbprint: "A".repeat(40), subject: "CN=Stage 13", inn: "050000000000",
    ogrn: "123456789012345", validFrom: new Date(Date.now() - 60_000).toISOString(),
    validTo: new Date(Date.now() + 86_400_000).toISOString(), algorithm: "GOST R 34.10-2012-256",
  };
}

function syntheticKm(gtin: string, serial: string) {
  return Buffer.concat([
    Buffer.from(`01${gtin}21${serial}`, "ascii"), Buffer.from([0x1d]),
    Buffer.from("91ABCD", "ascii"), Buffer.from([0x1d]),
    Buffer.from(`92${"S".repeat(44)}`, "ascii"),
  ]).toString("utf8");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
