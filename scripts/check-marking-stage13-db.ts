#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import { parseAndEncryptMarkingCodes } from "@/lib/marking/domain/code-pool";
import { MarkingKeyring } from "@/lib/marking/security/keyring";

const connectionString = process.env.GETOMERCH_DATABASE_URL?.trim();
if (!connectionString) throw new Error("GETOMERCH_DATABASE_URL is required");
const pool = new Pool({
  connectionString,
  max: 4,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  ssl: useSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
});
const GTIN = "04628837736075";
const keyring = new MarkingKeyring({
  currentEncryptionKeyVersion: 1,
  encryptionKeys: { "1": randomBytes(32).toString("base64") },
  currentHmacKeyVersion: 1,
  hmacKeys: { "1": randomBytes(32).toString("base64") },
});

main().catch((error) => {
  console.error("Stage 13 PostgreSQL checks failed", error);
  process.exitCode = 1;
}).finally(() => pool.end());

async function main() {
  const database = (await pool.query<{ name: string }>(
    "SELECT current_database() AS name",
  )).rows[0]?.name;
  if (!database || !/^getomerch_stage13_[a-z0-9_]+$/.test(database)) {
    throw new Error(`Refusing Stage 13 DB tests against database: ${database ?? "unknown"}`);
  }
  const fixture = await createReadyProduct();
  const forecast = await asApp<ForecastRow>(
    `SELECT trade_item_id, gtin, available, pending_utilisation,
       active_demand, recommended_quantity, pool_policy_revision
     FROM getomerch_marking.suz_pool_forecast_safe
     WHERE trade_item_id = $1::uuid`,
    [fixture.tradeItemId],
  );
  assert.equal(forecast.rowCount, 1);
  assert.equal(Number(forecast.rows[0].available), 0);

  const policy = await asApp<{ policy_revision: string }>(
    `SELECT policy_revision FROM getomerch_marking.update_suz_pool_policy(
       $1::uuid,1,true,1,5,24,30,100,'stage13-db-test'
     )`,
    [fixture.tradeItemId],
  );
  assert.equal(Number(policy.rows[0].policy_revision), 2);
  await assert.rejects(
    asApp(`SELECT * FROM getomerch_marking.update_suz_pool_policy(
      $1::uuid,1,true,1,5,24,30,100,'stage13-db-test')`, [fixture.tradeItemId]),
    (error) => pgCode(error) === "MZD01",
  );

  const created = await createDraft(fixture.tradeItemId, "stage13:first-draft", 1);
  assert.equal(created.reused, false);
  const duplicateOpen = await createDraft(fixture.tradeItemId, "stage13:second-draft", 1);
  assert.equal(duplicateOpen.reused, true);
  assert.equal(duplicateOpen.order_id, created.order_id);

  const approved = await asApp<{ order_revision: string; order_status: string }>(
    `SELECT order_revision, order_status
     FROM getomerch_marking.approve_suz_order($1::uuid,$2,'stage13-db-test')`,
    [created.order_id, Number(created.order_revision)],
  );
  assert.equal(approved.rows[0].order_status, "approved");
  await asApp(
    `SELECT getomerch_marking.record_suz_submit_started(
       $1::uuid,$2,$3,$4,'stage13-db-test')`,
    [created.order_id, "a".repeat(64), "b".repeat(64), "C".repeat(40)],
  );
  const omsId = randomUUID();
  const externalOrderId = randomUUID();
  await asApp(
    `SELECT getomerch_marking.record_suz_submitted(
       $1::uuid,$2::uuid,$3::uuid,1000,$4::jsonb)`,
    [created.order_id, omsId, externalOrderId, JSON.stringify({ expectedCompletionTimeMs: 1000 })],
  );
  await asApp(
    `SELECT getomerch_marking.record_suz_order_status(
       $1::uuid,'READY','ACTIVE',1,$2::jsonb)`,
    [created.order_id, JSON.stringify({ orderStatus: "READY", bufferStatus: "ACTIVE", availableCodes: 1 })],
  );

  const parsed = parseAndEncryptMarkingCodes({
    codes: [syntheticKm(GTIN, "STAGE13-00001")],
    expectedGtin: GTIN,
    keyring,
  });
  const blockId = randomUUID();
  const client = await pool.connect();
  let batchId = "";
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE getomerch_app");
    batchId = (await client.query<{ batch_id: string }>(
      `SELECT getomerch_marking.create_code_import_preview(
         'suz_api',NULL,'application/json',$1,$2,$3,'own_suz_emission',$4::jsonb,
         'stage13-db-test') AS batch_id`,
      [parsed.fileSha256, parsed.fileSizeBytes, GTIN, JSON.stringify(parsed.rows)],
    )).rows[0].batch_id;
    const summary = (await client.query<{ summary: Record<string, unknown> }>(
      `SELECT getomerch_marking.apply_code_import($1::uuid,'stage13-db-test') AS summary`,
      [batchId],
    )).rows[0].summary;
    assert.equal(Number(summary.applied), 1);
    const attached = (await client.query<{ order_status: string }>(
      `SELECT order_status FROM getomerch_marking.attach_suz_code_block(
         $1::uuid,$2::uuid,$3::uuid,1,1,0,0,'stage13-db-test')`,
      [created.order_item_id, batchId, blockId],
    )).rows[0];
    assert.equal(attached.order_status, "awaiting_utilisation");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const pending = await pool.query<{ pool_state: string; code_order_item_id: string }>(
    `SELECT pool_state, code_order_item_id
     FROM public.merch_marking_codes WHERE import_batch_id = $1::uuid`,
    [batchId],
  );
  assert.equal(pending.rows[0].pool_state, "pending_utilisation");
  assert.equal(pending.rows[0].code_order_item_id, created.order_item_id);
  const preReceiptForecast = await asApp<{ available: number; pending_utilisation: number }>(
    `SELECT available, pending_utilisation
     FROM getomerch_marking.suz_pool_forecast_safe WHERE trade_item_id = $1::uuid`,
    [fixture.tradeItemId],
  );
  assert.equal(Number(preReceiptForecast.rows[0].available), 0);
  assert.equal(Number(preReceiptForecast.rows[0].pending_utilisation), 1);

  const completed = await asApp<{ order_status: string; released_quantity: number }>(
    `SELECT order_status, released_quantity
     FROM getomerch_marking.confirm_suz_utilisation(
       $1::uuid,$2::uuid,'SUCCESS',0,1,1,$3::jsonb)`,
    [created.order_id, randomUUID(), JSON.stringify({ workflow: "REPORT_UTILIZE", state: "SUCCESS", code: 0, processed: 1, total: 1 })],
  );
  assert.equal(completed.rows[0].order_status, "completed");
  assert.equal(Number(completed.rows[0].released_quantity), 1);
  assert.equal((await pool.query<{ pool_state: string }>(
    `SELECT pool_state FROM public.merch_marking_codes WHERE import_batch_id = $1::uuid`,
    [batchId],
  )).rows[0].pool_state, "available");

  const next = await createDraft(fixture.tradeItemId, "stage13:after-complete", 1);
  assert.equal(next.reused, false);
  const cancelled = await asApp<{ order_status: string }>(
    `SELECT order_status FROM getomerch_marking.cancel_suz_order(
       $1::uuid,$2,'Stage 13 cancellation','stage13-db-test')`,
    [next.order_id, Number(next.order_revision)],
  );
  assert.equal(cancelled.rows[0].order_status, "cancelled");

  await pool.query(
    "UPDATE public.merch_marking_trade_items SET product_group = 'shoes' WHERE id = $1::uuid",
    [fixture.tradeItemId],
  );
  assert.equal((await asApp(
    "SELECT trade_item_id FROM getomerch_marking.suz_pool_forecast_safe WHERE trade_item_id = $1::uuid",
    [fixture.tradeItemId],
  )).rowCount, 0);
  await assert.rejects(
    createDraft(fixture.tradeItemId, "stage13:wrong-product-group", 1),
    (error) => pgCode(error) === "MZD03",
  );

  await assert.rejects(
    asApp("SELECT id FROM public.merch_marking_code_orders LIMIT 1"),
    (error) => pgCode(error) === "42501",
  );
  const safeOrder = await asApp<Record<string, unknown>>(
    `SELECT order_id, gtin, status, requested_quantity, available_quantity
     FROM getomerch_marking.suz_code_order_safe WHERE order_id = $1::uuid`,
    [created.order_id],
  );
  assert.equal(safeOrder.rowCount, 1);
  assert.equal(JSON.stringify(safeOrder.rows).includes("ciphertext"), false);
  console.log("Stage 13 PostgreSQL forecast, order, secure ingestion and utilisation checks passed");
}

async function createDraft(tradeItemId: string, key: string, quantity: number) {
  return (await asApp<{
    order_id: string;
    order_item_id: string;
    order_revision: string;
    reused: boolean;
  }>(
    `SELECT order_id, order_item_id, order_revision, reused
     FROM getomerch_marking.create_suz_order_draft(
       $1::uuid,$2,'sandbox','manual',$3,$4::jsonb,'stage13-db-test')`,
    [tradeItemId, quantity, key, JSON.stringify({ source: "stage13-db-test" })],
  )).rows[0];
}

async function createReadyProduct() {
  const suffix = randomUUID().slice(0, 8);
  const declaredColor = `Stage13 color ${suffix}`;
  const declaredSize = `Stage13 size ${suffix}`;
  const refs = (await pool.query<{
    category_id: string; fabric_id: string; color_id: string;
    size_id: string; design_id: string; decoration_id: string;
  }>(
    `WITH category AS (
       INSERT INTO public.merch_product_categories (name,slug) VALUES ($1,$2) RETURNING id
     ), fabric AS (
       INSERT INTO public.merch_fabric_types (name,slug) VALUES ($3,$4) RETURNING id
     ), color AS (
       INSERT INTO public.merch_colors (name) VALUES ($5) RETURNING id
     ), size AS (
       INSERT INTO public.merch_sizes (name) VALUES ($6) RETURNING id
     ), design AS (
       INSERT INTO public.merch_designs (name,type) VALUES ($7,'print') RETURNING id
     ), decoration AS (
       INSERT INTO public.merch_decoration_types (name,slug,made_at)
       VALUES ($8,$9,'own') RETURNING id
     )
     SELECT category.id category_id,fabric.id fabric_id,color.id color_id,
       size.id size_id,design.id design_id,decoration.id decoration_id
     FROM category,fabric,color,size,design,decoration`,
    [`Stage13 category ${suffix}`, `stage13-category-${suffix}`,
      `Stage13 fabric ${suffix}`, `stage13-fabric-${suffix}`,
      declaredColor, declaredSize,
      `Stage13 design ${suffix}`, `Stage13 decoration ${suffix}`,
      `stage13-decoration-${suffix}`],
  )).rows[0];
  const product = (await pool.query<{ id: string }>(
    `INSERT INTO public.merch_products (
       category_id,fabric_id,color_id,size_id,design_id,decoration_type_id,sku,ozon_sku
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,6500000001) RETURNING id`,
    [refs.category_id, refs.fabric_id, refs.color_id, refs.size_id,
      refs.design_id, refs.decoration_id, `STAGE13-${suffix}-S`],
  )).rows[0];
  const trade = (await pool.query<{ id: string }>(
    `INSERT INTO public.merch_marking_trade_items (
       gtin,product_group,tnved_code,national_catalog_card_id,
       national_catalog_status,verification_status,verification_source,
       source_snapshot_hash,verified_at,verified_by,declared_product_type,
       declared_fabric,declared_color,declared_size_int
     ) VALUES ($1,'clothes','6109100000','STAGE13-CARD','published','verified',
       'stage13_test',repeat('a',64),clock_timestamp(),'stage13-db-test',
       'Футболка','Хлопок',$2,$3) RETURNING id`,
    [GTIN, declaredColor, declaredSize],
  )).rows[0];
  const profile = (await pool.query<{ id: string }>(
    `INSERT INTO public.merch_marking_product_profiles (
       product_id,trade_item_id,requires_marking,production_mode,
       fulfillment_marking_mode,verification_status,verification_source,
       source_snapshot_hash,verified_at,verified_by,marking_requirement,
       marking_requirement_source,marking_requirement_observed_at,
       operational_status,operational_changed_at,operational_changed_by
     ) VALUES ($1,$2,true,'own_production','jit_after_order','draft',
       NULL,NULL,NULL,NULL,
       'required','stage13_test',clock_timestamp(),'draft',NULL,NULL) RETURNING id`,
    [product.id, trade.id],
  )).rows[0];
  await pool.query(
    `INSERT INTO public.merch_marking_evidence (
       product_profile_id,evidence_type,source,observed_at,payload_hash,
       verification_status,verified_by,verified_at
     ) VALUES ($1,'product_profile_mapping','stage13_test',clock_timestamp(),
       repeat('c',64),'verified','stage13-db-test',clock_timestamp())`,
    [profile.id],
  );
  await pool.query(
    `UPDATE public.merch_marking_product_profiles
     SET verification_status = 'verified', verification_source = 'stage13_test',
       source_snapshot_hash = repeat('b',64), verified_at = clock_timestamp(),
       verified_by = 'stage13-db-test', operational_status = 'enabled',
       operational_changed_at = clock_timestamp(),
       operational_changed_by = 'stage13-db-test', revision = revision + 1,
       updated_at = clock_timestamp()
     WHERE id = $1::uuid`,
    [profile.id],
  );
  return { tradeItemId: trade.id };
}

async function asApp<Row extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE getomerch_app");
    const result = await client.query<Row>(sql, [...params]);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function syntheticKm(gtin: string, serial: string) {
  return Buffer.concat([
    Buffer.from(`01${gtin}21${serial}`, "ascii"), Buffer.from([0x1d]),
    Buffer.from("91ABCD", "ascii"), Buffer.from([0x1d]),
    Buffer.from(`92${"S".repeat(44)}`, "ascii"),
  ]).toString("utf8");
}

function pgCode(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (typeof current === "object" && "code" in current) {
      const code = String((current as { code?: unknown }).code ?? "");
      if (code) return code;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return "";
}

function useSsl(value: string) {
  return !value.includes("localhost")
    && !value.includes("127.0.0.1")
    && !value.includes("host=/var/run/postgresql");
}

type ForecastRow = {
  trade_item_id: string;
  gtin: string;
  available: number;
  pending_utilisation: number;
  active_demand: number;
  recommended_quantity: number;
  pool_policy_revision: string;
};
