#!/usr/bin/env node

import { backfillOzonFulfillmentBatch } from "@/lib/fulfillment/backfill";
import { safeErrorForLog } from "@/lib/marking/security/redaction";

run().catch((error) => {
  console.error("[fulfillment-backfill] failed", safeErrorForLog(error));
  process.exitCode = 1;
});

async function run() {
  const limit = readInteger(
    "GETOMERCH_FULFILLMENT_BACKFILL_LIMIT",
    100,
    1,
    500,
  );
  const maxBatches = readInteger(
    "GETOMERCH_FULFILLMENT_BACKFILL_MAX_BATCHES",
    1,
    1,
    100,
  );
  const activeOnly = readBoolean(
    "GETOMERCH_FULFILLMENT_BACKFILL_ACTIVE_ONLY",
    true,
  );
  let totals = {
    processedOrders: 0,
    processedItems: 0,
    quantityTotal: 0,
    remainingOrders: 0,
    batches: 0,
    activeOnly,
  };

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await backfillOzonFulfillmentBatch({ limit, activeOnly });
    totals = {
      processedOrders: totals.processedOrders + result.processedOrders,
      processedItems: totals.processedItems + result.processedItems,
      quantityTotal: totals.quantityTotal + result.quantityTotal,
      remainingOrders: result.remainingOrders,
      batches: batch + 1,
      activeOnly,
    };
    if (result.processedOrders === 0 || result.remainingOrders === 0) break;
  }

  console.log("[fulfillment-backfill] completed", totals);
}

function readInteger(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readBoolean(name: string, fallback: boolean) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}
