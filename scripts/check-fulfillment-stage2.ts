#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildOzonSourceItemKey,
  projectOzonMarkingSignals,
  projectOzonOrderItems,
} from "@/lib/fulfillment/ozon-domain";
import { safeErrorForLog } from "@/lib/marking/security/redaction";

run().catch((error) => {
  console.error("Stage 2 fulfillment checks failed.", safeErrorForLog(error));
  process.exitCode = 1;
});

async function run() {
  testSourceKeys();
  testMarkingProjection();
  testItemProjection();
  await testImplementationContracts();
  console.log("Stage 2 fulfillment checks passed.");
}

function testSourceKeys() {
  const first = buildOzonSourceItemKey("D1-TSH-PRT-WHT-S", "900000001");
  const repeated = buildOzonSourceItemKey("D1-TSH-PRT-WHT-S", "900000001");
  const differentProduct = buildOzonSourceItemKey(
    "D1-TSH-PRT-WHT-S",
    "900000002",
  );
  const unicode = buildOzonSourceItemKey("ФУТБОЛКА-S", null);

  assert.equal(first, repeated);
  assert.notEqual(first, differentProduct);
  assert.match(first, /^ozon:v1:[0-9a-f]+:[0-9a-f]+$/);
  assert.match(unicode, /^ozon:v1:[0-9a-f]+:$/);
}

function testMarkingProjection() {
  assert.deepEqual(
    projectOzonMarkingSignals({
      ozonProductId: "1001",
      mandatoryProductEntries: undefined,
      productExemplars: undefined,
    }),
    { markingRequirement: "unknown", exemplarFlowAvailable: null },
  );
  assert.deepEqual(
    projectOzonMarkingSignals({
      ozonProductId: "1001",
      mandatoryProductEntries: [],
      productExemplars: [],
    }),
    { markingRequirement: "not_required", exemplarFlowAvailable: null },
  );
  assert.deepEqual(
    projectOzonMarkingSignals({
      ozonProductId: "1001",
      mandatoryProductEntries: [1001],
      productExemplars: [
        {
          product_id: 1001,
          is_mandatory_mark_needed: true,
          is_mandatory_mark_possible: true,
        },
      ],
    }),
    { markingRequirement: "required", exemplarFlowAvailable: true },
  );
  assert.deepEqual(
    projectOzonMarkingSignals({
      ozonProductId: "1001",
      mandatoryProductEntries: [],
      possibleProductEntries: [1001],
      productExemplars: [],
    }),
    { markingRequirement: "required", exemplarFlowAvailable: true },
  );
  assert.deepEqual(
    projectOzonMarkingSignals({
      ozonProductId: "1001",
      mandatoryProductEntries: [],
      possibleProductEntries: [],
      productExemplars: [
        {
          product_id: 1001,
          is_mandatory_mark_needed: true,
          is_mandatory_mark_possible: true,
        },
      ],
    }),
    { markingRequirement: "unknown", exemplarFlowAvailable: true },
  );
}

function testItemProjection() {
  const productByOffer = new Map([["D1-TSH-PRT-WHT-S", "00000000-0000-4000-8000-000000000001"]]);
  const fbs = projectOzonOrderItems({
    source: "fbs",
    products: [
      {
        offer_id: "D1-TSH-PRT-WHT-S",
        sku: 1001,
        quantity: 2,
        price: "1000",
      },
      {
        offer_id: "D1-TSH-PRT-WHT-S",
        sku: 1001,
        quantity: 1,
        price: "1000",
      },
    ],
    mandatoryProductEntries: [1001],
    possibleProductEntries: [1001],
    productExemplars: [
      {
        product_id: 1001,
        is_mandatory_mark_needed: true,
        is_mandatory_mark_possible: true,
      },
    ],
    productByOffer,
  });
  assert.equal(fbs.length, 1);
  assert.equal(fbs[0].quantity, 3);
  assert.equal(fbs[0].markingRequirement, "required");
  assert.equal(fbs[0].exemplarFlowAvailable, true);
  assert.equal(
    fbs[0].productId,
    "00000000-0000-4000-8000-000000000001",
  );
  const enriched = projectOzonOrderItems({
    source: "fbs",
    products: [{
      offer_id: "D1-TSH-PRT-WHT-S",
      sku: 1001,
      product_id: 5001,
      quantity: 1,
    }],
    mandatoryProductEntries: [5001],
    possibleProductEntries: [5001],
    productExemplars: [],
    productByOffer,
  });
  assert.equal(enriched[0].sourceItemKey, fbs[0].sourceItemKey);
  assert.equal(enriched[0].ozonProductId, "5001");

  const fbo = projectOzonOrderItems({
    source: "fbo",
    products: [{
      offer_id: "D1-TSH-PRT-WHT-S",
      sku: 1001,
      quantity: 1,
    }],
    mandatoryProductEntries: [1001],
    possibleProductEntries: [1001],
    productExemplars: [{
      product_id: 1001,
      is_mandatory_mark_needed: true,
      is_mandatory_mark_possible: true,
    }],
    productByOffer,
  });
  assert.equal(fbo[0].markingRequirement, "unknown");
  assert.equal(fbo[0].exemplarFlowAvailable, null);
}

async function testImplementationContracts() {
  const root = process.cwd();
  const migration = await readFile(
    path.join(root, "db/migrations/0006_generic_fulfillment.sql"),
    "utf8",
  );
  const mutation = await readFile(
    path.join(root, "src/lib/db/mutations/sync-import.ts"),
    "utf8",
  );
  const worker = await readFile(
    path.join(root, "src/lib/jobs/worker.ts"),
    "utf8",
  );
  const ozonMutation = await readFile(
    path.join(root, "src/lib/db/mutations/ozon.ts"),
    "utf8",
  );
  const financeRepository = await readFile(
    path.join(root, "src/lib/db/repositories/finance.ts"),
    "utf8",
  );

  assert.match(
    migration,
    /source IS DISTINCT FROM 'fbo' OR fulfillment_order_id IS NULL/,
  );
  assert.match(migration, /source_channel = 'ozon_fbs'/);
  assert.match(migration, /UNIQUE \(fulfillment_order_id, source_item_key\)/);
  assert.match(
    migration,
    /FOREIGN KEY \(fulfillment_item_id, fulfillment_order_id\)/,
  );
  assert.match(
    migration,
    /GRANT SELECT, INSERT\s+ON public\.merch_fulfillment_events/,
  );
  assert.doesNotMatch(
    migration,
    /GRANT[^;]*DELETE[^;]*merch_fulfillment_events/s,
  );
  assert.doesNotMatch(
    mutation,
    /DELETE FROM merch_ozon_order_items/i,
  );
  assert.match(mutation, /ON CONFLICT \(order_id, source_item_key\)/);
  assert.match(mutation, /input\.source === "fbs"/);
  assert.match(ozonMutation, /item\.source_active = true/);
  assert.match(financeRepository, /WHERE source_active = true/);
  assert.match(worker, /claimNextJob\(workerId, \[\.\.\.CORE_JOB_TYPES\]\)/);
}
