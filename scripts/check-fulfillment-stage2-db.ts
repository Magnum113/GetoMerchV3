#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  closeServerDatabasePool,
  queryServerDatabase,
} from "@/lib/db/pool";
import {
  syncOzonOrderSnapshot,
  type OzonOrderSnapshot,
} from "@/lib/db/mutations/sync-import";
import { backfillOzonFulfillmentBatch } from "@/lib/fulfillment/backfill";
import { buildOzonSourceItemKey } from "@/lib/fulfillment/ozon-domain";
import { safeErrorForLog } from "@/lib/marking/security/redaction";

run()
  .catch((error) => {
    console.error("Stage 2 database checks failed.", {
      ...safeErrorForLog(error),
      databaseCause: databaseCause(error),
    });
    process.exitCode = 1;
  })
  .finally(() => closeServerDatabasePool());

async function run() {
  const identity = (
    await queryServerDatabase<{ database_name: string }>(
      "select current_database() as database_name",
    )
  ).rows[0];
  assert.match(
    identity.database_name,
    /^getomerch_stage2_[a-z0-9_]+$/,
    "Refusing to run Stage 2 destructive checks outside an isolated database",
  );

  const beforeInventory = await tableCounts();
  const first = snapshot({
    postingNumber: "STAGE2-FBS-1",
    status: "awaiting_packaging",
    quantity: 2,
    markingRequirement: "required",
    exemplarFlowAvailable: true,
    syncedAt: "2026-07-26T18:00:00.000Z",
  });
  const firstResult = await sync(first, "first");
  assert.ok(firstResult.fulfillmentOrderId);
  assert.equal(firstResult.fulfillmentItemCount, 1);

  const initial = await fbsState("STAGE2-FBS-1");
  assert.equal(initial.fulfillment_order_count, 1);
  assert.equal(initial.fulfillment_item_count, 1);
  assert.equal(initial.quantity_total, 2);
  assert.equal(initial.event_count, 2);
  assert.equal(initial.marking_requirement, "required");
  const initialOzonItemId = initial.ozon_item_id;
  const initialFulfillmentItemId = initial.fulfillment_item_id;
  const initialFulfillmentOrderId = initial.fulfillment_order_id;

  await sync(
    { ...first, syncedAt: "2026-07-26T18:01:00.000Z" },
    "repeat",
  );
  const repeated = await fbsState("STAGE2-FBS-1");
  assert.equal(repeated.fulfillment_order_id, initialFulfillmentOrderId);
  assert.equal(repeated.ozon_item_id, initialOzonItemId);
  assert.equal(repeated.fulfillment_item_id, initialFulfillmentItemId);
  assert.equal(repeated.event_count, 2);

  await sync(
    {
      ...first,
      status: "awaiting_deliver",
      syncedAt: "2026-07-26T18:02:00.000Z",
    },
    "status",
  );
  const statusChanged = await fbsState("STAGE2-FBS-1");
  assert.equal(statusChanged.source_status, "awaiting_deliver");
  assert.equal(statusChanged.fulfillment_order_id, initialFulfillmentOrderId);
  assert.equal(statusChanged.event_count, 3);

  await sync(
    {
      ...first,
      status: "awaiting_deliver",
      syncedAt: "2026-07-26T18:03:00.000Z",
      items: [{ ...first.items[0], quantity: 3 }],
    },
    "quantity",
  );
  const quantityChanged = await fbsState("STAGE2-FBS-1");
  assert.equal(quantityChanged.quantity_total, 3);
  assert.equal(quantityChanged.ozon_item_id, initialOzonItemId);
  assert.equal(quantityChanged.fulfillment_item_id, initialFulfillmentItemId);
  assert.equal(quantityChanged.event_count, 5);

  await sync(
    snapshot({
      postingNumber: "STAGE2-FBS-1-SPLIT",
      status: "awaiting_packaging",
      quantity: 1,
      markingRequirement: "unknown",
      exemplarFlowAvailable: null,
      syncedAt: "2026-07-26T18:04:00.000Z",
    }),
    "split",
  );
  const split = await fbsState("STAGE2-FBS-1-SPLIT");
  assert.notEqual(split.fulfillment_order_id, initialFulfillmentOrderId);
  assert.notEqual(split.fulfillment_item_id, initialFulfillmentItemId);

  const changing = snapshot({
    postingNumber: "STAGE2-FBS-CHANGING",
    status: "awaiting_packaging",
    quantity: 1,
    markingRequirement: "required",
    exemplarFlowAvailable: true,
    syncedAt: "2026-07-26T18:04:30.000Z",
  });
  changing.items.push({
    ...changing.items[0],
    sourceItemKey: buildOzonSourceItemKey("STAGE2-TSH-TEST-M", "900000003"),
    offerId: "STAGE2-TSH-TEST-M",
    ozonSku: "900000003",
    ozonProductId: "900000003",
  });
  await sync(changing, "changing-two-items");
  await sync(
    {
      ...changing,
      syncedAt: "2026-07-26T18:04:45.000Z",
      items: [changing.items[0]],
    },
    "changing-one-item",
  );
  const changingActivity = await sourceItemActivity("STAGE2-FBS-CHANGING");
  assert.deepEqual(changingActivity, {
    ozon_total: 2,
    ozon_active: 1,
    fulfillment_total: 2,
    fulfillment_active: 1,
  });

  await sync(
    {
      ...snapshot({
        postingNumber: "STAGE2-FBO-1",
        status: "delivered",
        quantity: 1,
        markingRequirement: "unknown",
        exemplarFlowAvailable: null,
        syncedAt: "2026-07-26T18:05:00.000Z",
      }),
      source: "fbo",
    },
    "fbo",
  );
  const fbo = (
    await queryServerDatabase<{
      fulfillment_order_id: string | null;
      linked_items: string;
    }>(
      `
        SELECT
          orders.fulfillment_order_id,
          count(items.fulfillment_item_id)
            FILTER (WHERE items.fulfillment_item_id IS NOT NULL)::text
            AS linked_items
        FROM merch_ozon_orders orders
        JOIN merch_ozon_order_items items ON items.order_id = orders.id
        WHERE orders.posting_number = 'STAGE2-FBO-1'
        GROUP BY orders.id
      `,
    )
  ).rows[0];
  assert.equal(fbo.fulfillment_order_id, null);
  assert.equal(Number(fbo.linked_items), 0);

  await sync(
    {
      ...first,
      status: "cancelled",
      syncedAt: "2026-07-26T18:06:00.000Z",
    },
    "cancelled",
  );
  const cancelled = await fbsState("STAGE2-FBS-1");
  assert.equal(cancelled.source_status, "cancelled");
  assert.equal(cancelled.fulfillment_order_id, initialFulfillmentOrderId);

  await insertBackfillFixture();
  const backfill = await backfillOzonFulfillmentBatch({
    limit: 1,
    activeOnly: true,
  });
  assert.equal(backfill.processedOrders, 1);
  assert.equal(backfill.processedItems, 1);
  assert.equal(backfill.remainingOrders, 0);
  const backfilled = await fbsState("STAGE2-FBS-BACKFILL");
  assert.ok(backfilled.fulfillment_order_id);

  const afterInventory = await tableCounts();
  assert.deepEqual(afterInventory, beforeInventory);
  console.log("Stage 2 database checks passed.");
}

function snapshot(input: {
  postingNumber: string;
  status: string;
  quantity: number;
  markingRequirement: "unknown" | "required" | "not_required";
  exemplarFlowAvailable: boolean | null;
  syncedAt: string;
}): OzonOrderSnapshot {
  const offerId = "STAGE2-TSH-TEST-S";
  const ozonProductId = "900000001";
  return {
    postingNumber: input.postingNumber,
    orderId: 900000001,
    orderNumber: `ORDER-${input.postingNumber}`,
    status: input.status,
    substatus: null,
    ozonCreatedAt: "2026-07-26T17:00:00.000Z",
    inProcessAt: "2026-07-26T17:01:00.000Z",
    shipmentDate: "2026-07-27T10:00:00.000Z",
    deliveryMethod: "FBS",
    warehouseName: "Synthetic warehouse",
    customerName: null,
    totalPrice: 1000 * input.quantity,
    source: "fbs",
    syncedAt: input.syncedAt,
    replaceItems: true,
    items: [{
      sourceItemKey: buildOzonSourceItemKey(offerId, ozonProductId),
      offerId,
      ozonSku: ozonProductId,
      ozonProductId,
      name: "Synthetic product",
      quantity: input.quantity,
      price: 1000,
      productId: null,
      markingRequirement: input.markingRequirement,
      exemplarFlowAvailable: input.exemplarFlowAvailable,
    }],
  };
}

async function sync(value: OzonOrderSnapshot, suffix: string) {
  return syncOzonOrderSnapshot(
    {
      actor: "stage2-test",
      sessionId: "stage2-test",
      requestId: randomUUID(),
      idempotencyKey: `stage2:${suffix}:${randomUUID()}`,
    },
    value,
  );
}

async function fbsState(postingNumber: string) {
  return (
    await queryServerDatabase<{
      fulfillment_order_id: string;
      fulfillment_order_count: number;
      fulfillment_item_count: number;
      quantity_total: number;
      event_count: number;
      source_status: string;
      marking_requirement: string;
      ozon_item_id: string;
      fulfillment_item_id: string;
    }>(
      `
        SELECT
          fulfillment_order.id AS fulfillment_order_id,
          count(DISTINCT fulfillment_order.id)::int
            AS fulfillment_order_count,
          count(DISTINCT fulfillment_item.id)::int
            AS fulfillment_item_count,
          sum(DISTINCT fulfillment_item.quantity)::int AS quantity_total,
          count(DISTINCT events.id)::int AS event_count,
          fulfillment_order.source_status,
          min(fulfillment_item.marking_requirement) AS marking_requirement,
          min(ozon_item.id::text) AS ozon_item_id,
          min(fulfillment_item.id::text) AS fulfillment_item_id
        FROM merch_ozon_orders ozon_order
        JOIN merch_fulfillment_orders fulfillment_order
          ON fulfillment_order.id = ozon_order.fulfillment_order_id
        JOIN merch_ozon_order_items ozon_item
          ON ozon_item.order_id = ozon_order.id
        JOIN merch_fulfillment_order_items fulfillment_item
          ON fulfillment_item.id = ozon_item.fulfillment_item_id
        LEFT JOIN merch_fulfillment_events events
          ON events.fulfillment_order_id = fulfillment_order.id
        WHERE ozon_order.posting_number = $1
        GROUP BY fulfillment_order.id
      `,
      [postingNumber],
    )
  ).rows[0];
}

async function insertBackfillFixture() {
  const sourceItemKey = buildOzonSourceItemKey("STAGE2-BACKFILL-S", "900000002");
  await queryServerDatabase(
    `
      WITH inserted_order AS (
        INSERT INTO merch_ozon_orders (
          posting_number,
          order_id,
          order_number,
          status,
          source,
          synced_at
        )
        VALUES (
          'STAGE2-FBS-BACKFILL',
          900000002,
          'ORDER-STAGE2-FBS-BACKFILL',
          'awaiting_packaging',
          'fbs',
          '2026-07-26T18:07:00.000Z'::timestamptz
        )
        RETURNING id
      )
      INSERT INTO merch_ozon_order_items (
        order_id,
        source_item_key,
        offer_id,
        ozon_sku,
        ozon_product_id,
        name,
        quantity,
        marking_requirement,
        source_active
      )
      SELECT
        id,
        $1,
        'STAGE2-BACKFILL-S',
        '900000002',
        '900000002',
        'Synthetic backfill product',
        2,
        'unknown',
        true
      FROM inserted_order
    `,
    [sourceItemKey],
  );
}

async function sourceItemActivity(postingNumber: string) {
  return (
    await queryServerDatabase<{
      ozon_total: number;
      ozon_active: number;
      fulfillment_total: number;
      fulfillment_active: number;
    }>(
      `
        SELECT
          count(DISTINCT ozon_item.id)::int AS ozon_total,
          count(DISTINCT ozon_item.id)
            FILTER (WHERE ozon_item.source_active)::int AS ozon_active,
          count(DISTINCT fulfillment_item.id)::int AS fulfillment_total,
          count(DISTINCT fulfillment_item.id)
            FILTER (WHERE fulfillment_item.source_active)::int
            AS fulfillment_active
        FROM merch_ozon_orders ozon_order
        JOIN merch_ozon_order_items ozon_item
          ON ozon_item.order_id = ozon_order.id
        LEFT JOIN merch_fulfillment_order_items fulfillment_item
          ON fulfillment_item.id = ozon_item.fulfillment_item_id
        WHERE ozon_order.posting_number = $1
      `,
      [postingNumber],
    )
  ).rows[0];
}

async function tableCounts() {
  return (
    await queryServerDatabase<{
      inventory_count: number;
      inventory_quantity: number;
      transaction_count: number;
    }>(
      `
        SELECT
          (SELECT count(*)::int FROM merch_inventory) AS inventory_count,
          (SELECT coalesce(sum(quantity), 0)::int FROM merch_inventory)
            AS inventory_quantity,
          (SELECT count(*)::int FROM merch_transactions) AS transaction_count
      `,
    )
  ).rows[0];
}

function databaseCause(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current === "object") {
      const record = current as {
        cause?: unknown;
        code?: unknown;
        constraint?: unknown;
        table?: unknown;
        message?: unknown;
      };
      if (record.code || record.constraint || record.table) {
        return {
          name: current instanceof Error ? current.name : "DatabaseError",
          code: typeof record.code === "string" ? record.code : undefined,
          constraint:
            typeof record.constraint === "string" ? record.constraint : undefined,
          table: typeof record.table === "string" ? record.table : undefined,
          message: typeof record.message === "string" ? record.message : undefined,
        };
      }
      current = record.cause;
      continue;
    }
    break;
  }
  return null;
}
