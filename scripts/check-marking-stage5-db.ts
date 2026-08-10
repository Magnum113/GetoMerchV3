#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { MarkingKeyring } from "@/lib/marking/security/keyring";

const connectionString = process.env.GETOMERCH_DATABASE_URL?.trim();
if (!connectionString) throw new Error("GETOMERCH_DATABASE_URL is required");

const pool = new Pool({
  connectionString,
  max: 6,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 20_000,
  ssl: useSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
});

const PILOT_GTIN = "04628837736075";
const keyring = new MarkingKeyring({
  currentEncryptionKeyVersion: 2,
  encryptionKeys: {
    "1": randomBytes(32).toString("base64"),
    "2": randomBytes(32).toString("base64"),
  },
  currentHmacKeyVersion: 2,
  hmacKeys: {
    "1": randomBytes(32).toString("base64"),
    "2": randomBytes(32).toString("base64"),
  },
});

main().catch((error) => {
  console.error("Stage 5 PostgreSQL checks failed", error);
  process.exitCode = 1;
}).finally(() => pool.end());

async function main() {
  const database = (await pool.query<{ name: string }>(
    "select current_database() as name",
  )).rows[0]?.name;
  if (!database || !/^getomerch_stage5_[a-z0-9_]+$/.test(database)) {
    throw new Error(`Refusing Stage 5 DB tests against database: ${database ?? "unknown"}`);
  }

  const fixture = await createReadyProduct();
  const codeOne = syntheticKm(PILOT_GTIN, "STAGE50000001", "A");
  const otherGtin = makeGtin("0462883773612");
  const mismatch = syntheticKm(otherGtin, "STAGE50000002", "B");
  const firstRows = [
    encryptedRow(codeOne, 1, PILOT_GTIN),
    diagnosticRow(codeOne, 2, PILOT_GTIN, "duplicate_file"),
    diagnosticRow(mismatch, 3, otherGtin, "gtin_mismatch"),
  ];
  const firstBatch = await createPreview(firstRows, "stage5-first.txt");
  const firstPreview = await batchState(firstBatch);
  assert.equal(firstPreview.rows_total, 3);
  assert.equal(firstPreview.rows_valid, 1);
  assert.equal(firstPreview.rows_duplicate, 1);
  assert.equal(firstPreview.rows_rejected, 1);

  const firstApply = await applyBatch(firstBatch);
  assert.equal(Number(firstApply.applied), 1);
  const imported = await pool.query<{
    id: string;
    fingerprint: string;
    revision: string;
  }>(
    `
      SELECT id, fingerprint, revision
      FROM public.merch_marking_codes
      WHERE import_batch_id = $1::uuid
    `,
    [firstBatch],
  );
  assert.equal(imported.rowCount, 1);
  const codeId = imported.rows[0].id;
  const aliases = await pool.query<{ count: string }>(
    `
      SELECT count(*)::text AS count
      FROM public.merch_marking_code_hmacs
      WHERE marking_code_id = $1::uuid
    `,
    [codeId],
  );
  assert.equal(Number(aliases.rows[0].count), 2);
  await assertStagingScrubbed(firstBatch);

  await assert.rejects(
    asApp("SELECT code_ciphertext FROM public.merch_marking_codes LIMIT 1"),
    (error) => pgCode(error) === "42501",
  );
  const safeCode = await asApp<Record<string, unknown>>(
    "SELECT * FROM getomerch_marking.code_pool_safe WHERE id = $1::uuid",
    [codeId],
  );
  assert.equal(safeCode.rowCount, 1);
  for (const forbidden of [
    "code_ciphertext",
    "code_nonce",
    "code_auth_tag",
    "code_hmac",
    "serial",
  ]) {
    assert.equal(forbidden in safeCode.rows[0], false);
  }

  const duplicateBatch = await createPreview(
    [encryptedRow(codeOne, 1, PILOT_GTIN)],
    "stage5-existing-duplicate.txt",
  );
  const duplicateRows = await pool.query<{ validation_status: string }>(
    `
      SELECT validation_status
      FROM public.merch_marking_import_rows
      WHERE batch_id = $1::uuid
    `,
    [duplicateBatch],
  );
  assert.equal(duplicateRows.rows[0].validation_status, "duplicate_pool");

  const raceCode = syntheticKm(PILOT_GTIN, "STAGE50000003", "C");
  const raceBatchA = await createPreview(
    [encryptedRow(raceCode, 1, PILOT_GTIN)],
    "stage5-race-a.txt",
  );
  const raceBatchB = await createPreview(
    [encryptedRow(raceCode, 1, PILOT_GTIN)],
    "stage5-race-b.txt",
  );
  const raceResults = await Promise.all([
    applyBatch(raceBatchA),
    applyBatch(raceBatchB),
  ]);
  assert.equal(
    raceResults.reduce((sum, result) => sum + Number(result.applied), 0),
    1,
  );
  assert.equal(
    raceResults.reduce((sum, result) => sum + Number(result.raceDuplicate), 0),
    1,
  );

  const rollbackCode = syntheticKm(PILOT_GTIN, "STAGE50000004", "D");
  const rollbackBatch = await createPreview(
    [encryptedRow(rollbackCode, 1, PILOT_GTIN)],
    "stage5-rollback.txt",
  );
  const rollbackClient = await pool.connect();
  try {
    await rollbackClient.query("BEGIN");
    await rollbackClient.query("SET LOCAL ROLE getomerch_app");
    await rollbackClient.query(
      "SELECT getomerch_marking.apply_code_import($1::uuid, $2)",
      [rollbackBatch, "stage5-db-test"],
    );
    await rollbackClient.query("ROLLBACK");
  } finally {
    rollbackClient.release();
  }
  assert.equal((await batchState(rollbackBatch)).status, "preview");
  assert.equal(
    Number((await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.merch_marking_codes WHERE import_batch_id = $1::uuid",
      [rollbackBatch],
    )).rows[0].count),
    0,
  );

  const quarantined = await asApp<{
    pool_state: string;
    revision: string;
  }>(
    `
      SELECT pool_state, revision
      FROM getomerch_marking.quarantine_code($1::uuid, 1, $2, $3)
    `,
    [codeId, "Stage 5 quarantine test", "stage5-db-test"],
  );
  assert.equal(quarantined.rows[0].pool_state, "quarantined");
  await assert.rejects(
    asApp(
      `
        SELECT *
        FROM getomerch_marking.release_quarantined_code(
          $1::uuid, $2::bigint, $3, false, $4
        )
      `,
      [codeId, Number(quarantined.rows[0].revision), "unsafe release", "stage5-db-test"],
    ),
    (error) => pgCode(error) === "MZ514",
  );
  const released = await asApp<{ pool_state: string; revision: string }>(
    `
      SELECT pool_state, revision
      FROM getomerch_marking.release_quarantined_code(
        $1::uuid, $2::bigint, $3, true, $4
      )
    `,
    [
      codeId,
      Number(quarantined.rows[0].revision),
      "Printed copies destroyed",
      "stage5-db-test",
    ],
  );
  assert.equal(released.rows[0].pool_state, "available");

  const expiringCode = syntheticKm(PILOT_GTIN, "STAGE50000005", "E");
  const expiringBatch = await createPreview(
    [encryptedRow(expiringCode, 1, PILOT_GTIN)],
    "stage5-expiring.txt",
  );
  await pool.query(
    `
      UPDATE public.merch_marking_import_batches
      SET
        created_at = clock_timestamp() - interval '25 hours',
        expires_at = clock_timestamp() - interval '1 hour'
      WHERE id = $1::uuid
    `,
    [expiringBatch],
  );
  const scrubbed = await asApp<{ count: number }>(
    "SELECT getomerch_marking.scrub_expired_code_imports(100) AS count",
  );
  assert.ok(Number(scrubbed.rows[0].count) >= 1);
  assert.equal((await batchState(expiringBatch)).status, "expired");
  await assertStagingScrubbed(expiringBatch);

  const importedEvents = await pool.query<{ count: string }>(
    `
      SELECT count(*)::text AS count
      FROM public.merch_marking_events
      WHERE marking_code_id = $1::uuid
        AND event_type IN (
          'marking_code_imported',
          'marking_code_quarantined',
          'marking_code_released'
        )
    `,
    [codeId],
  );
  assert.equal(Number(importedEvents.rows[0].count), 3);
  const serializedEvents = JSON.stringify((
    await pool.query(
      "SELECT details_redacted FROM public.merch_marking_events WHERE marking_code_id = $1::uuid",
      [codeId],
    )
  ).rows);
  assert.equal(serializedEvents.includes(codeOne.toString("ascii")), false);

  for (const value of [codeOne, mismatch, raceCode, rollbackCode, expiringCode]) {
    value.fill(0);
  }
  assert.equal(fixture.gtin, PILOT_GTIN);
  console.log("Stage 5 PostgreSQL pool, duplicate-race and staging checks passed");
}

async function createReadyProduct() {
  const suffix = randomUUID().slice(0, 8);
  const refs = await pool.query<{
    category_id: string;
    fabric_id: string;
    color_id: string;
    size_id: string;
    design_id: string;
    decoration_id: string;
  }>(
    `
      WITH category AS (
        INSERT INTO public.merch_product_categories (name, slug)
        VALUES ($1, $2)
        RETURNING id
      ),
      fabric AS (
        INSERT INTO public.merch_fabric_types (name, slug)
        VALUES ($3, $4)
        RETURNING id
      ),
      color AS (
        INSERT INTO public.merch_colors (name)
        VALUES ('Белый')
        ON CONFLICT (name) DO UPDATE SET name = excluded.name
        RETURNING id
      ),
      size AS (
        INSERT INTO public.merch_sizes (name)
        VALUES ('S')
        ON CONFLICT (name) DO UPDATE SET name = excluded.name
        RETURNING id
      ),
      design AS (
        INSERT INTO public.merch_designs (name, type)
        VALUES ($5, 'print')
        RETURNING id
      ),
      decoration AS (
        INSERT INTO public.merch_decoration_types (name, slug, made_at)
        VALUES ($6, $7, 'own')
        RETURNING id
      )
      SELECT
        category.id AS category_id,
        fabric.id AS fabric_id,
        color.id AS color_id,
        size.id AS size_id,
        design.id AS design_id,
        decoration.id AS decoration_id
      FROM category, fabric, color, size, design, decoration
    `,
    [
      `Stage5 T-Shirt ${suffix}`,
      `stage5-tshirt-${suffix}`,
      `Stage5 Cotton ${suffix}`,
      `stage5-cotton-${suffix}`,
      `Stage5 Design ${suffix}`,
      `Stage5 Print ${suffix}`,
      `stage5-print-${suffix}`,
    ],
  );
  const product = (
    await pool.query<{ id: string }>(
      `
        INSERT INTO public.merch_products (
          category_id,
          fabric_id,
          color_id,
          size_id,
          design_id,
          decoration_type_id,
          sku,
          ozon_sku
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 5500000001)
        RETURNING id
      `,
      [
        refs.rows[0].category_id,
        refs.rows[0].fabric_id,
        refs.rows[0].color_id,
        refs.rows[0].size_id,
        refs.rows[0].design_id,
        refs.rows[0].decoration_id,
        `STAGE5-POOL-${suffix}-S`,
      ],
    )
  ).rows[0];
  const tradeItem = (
    await pool.query<{ id: string }>(
      `
        INSERT INTO public.merch_marking_trade_items (
          gtin,
          product_group,
          tnved_code,
          national_catalog_card_id,
          national_catalog_status,
          verification_status,
          verification_source,
          source_snapshot_hash,
          verified_at,
          verified_by,
          declared_product_type,
          declared_fabric,
          declared_color,
          declared_size_int
        )
        VALUES (
          $1,
          'clothes',
          '6109100000',
          'STAGE5-CARD',
          'published',
          'verified',
          'stage5_test',
          repeat('a', 64),
          clock_timestamp(),
          'stage5-db-test',
          'Футболка',
          'Хлопок',
          'Белый',
          'S'
        )
        RETURNING id
      `,
      [PILOT_GTIN],
    )
  ).rows[0];
  const profile = (
    await pool.query<{ id: string }>(
      `
        INSERT INTO public.merch_marking_product_profiles (
          product_id,
          trade_item_id,
          requires_marking,
          production_mode,
          fulfillment_marking_mode,
          verification_status,
          marking_requirement,
          marking_requirement_source,
          marking_requirement_observed_at,
          operational_status
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          true,
          'own_production',
          'jit_after_order',
          'draft',
          'required',
          'stage5_test',
          clock_timestamp(),
          'draft'
        )
        RETURNING id
      `,
      [product.id, tradeItem.id],
    )
  ).rows[0];
  await pool.query(
    `
      INSERT INTO public.merch_marking_evidence (
        product_profile_id,
        evidence_type,
        source,
        observed_at,
        payload_hash,
        verification_status,
        verified_by,
        verified_at
      )
      VALUES (
        $1::uuid,
        'product_profile_mapping',
        'stage5_test',
        clock_timestamp(),
        repeat('b', 64),
        'verified',
        'stage5-db-test',
        clock_timestamp()
      )
    `,
    [profile.id],
  );
  await pool.query(
    `
      UPDATE public.merch_marking_product_profiles
      SET
        verification_status = 'verified',
        verification_source = 'stage5_test',
        source_snapshot_hash = repeat('c', 64),
        verified_at = clock_timestamp(),
        verified_by = 'stage5-db-test',
        operational_status = 'enabled',
        operational_changed_at = clock_timestamp(),
        operational_changed_by = 'stage5-db-test',
        revision = revision + 1,
        updated_at = clock_timestamp()
      WHERE id = $1::uuid
    `,
    [profile.id],
  );
  return { productId: product.id, tradeItemId: tradeItem.id, gtin: PILOT_GTIN };
}

async function createPreview(rows: unknown[], filename: string) {
  const result = await asApp<{ batch_id: string }>(
    `
      SELECT getomerch_marking.create_code_import_preview(
        'stage5_db_test',
        $1,
        'text/plain',
        $2,
        100,
        $3,
        'own_suz_emission',
        $4::jsonb,
        'stage5-db-test'
      ) AS batch_id
    `,
    [filename, randomBytes(32).toString("hex"), PILOT_GTIN, JSON.stringify(rows)],
  );
  return result.rows[0].batch_id;
}

async function applyBatch(batchId: string) {
  const result = await asApp<{ summary: Record<string, unknown> }>(
    "SELECT getomerch_marking.apply_code_import($1::uuid, $2) AS summary",
    [batchId, "stage5-db-test"],
  );
  return result.rows[0].summary;
}

async function batchState(batchId: string) {
  return (
    await pool.query<{
      status: string;
      rows_total: number;
      rows_valid: number;
      rows_duplicate: number;
      rows_rejected: number;
    }>(
      `
        SELECT status, rows_total, rows_valid, rows_duplicate, rows_rejected
        FROM public.merch_marking_import_batches
        WHERE id = $1::uuid
      `,
      [batchId],
    )
  ).rows[0];
}

async function assertStagingScrubbed(batchId: string) {
  const unsafe = await pool.query<{ count: string }>(
    `
      SELECT count(*)::text AS count
      FROM public.merch_marking_import_rows
      WHERE batch_id = $1::uuid
        AND (
          code_ciphertext IS NOT NULL
          OR code_nonce IS NOT NULL
          OR code_auth_tag IS NOT NULL
          OR code_hmac IS NOT NULL
          OR dedup_hmacs <> '[]'::jsonb
        )
    `,
    [batchId],
  );
  assert.equal(Number(unsafe.rows[0].count), 0);
}

function encryptedRow(code: Buffer, rowNumber: number, gtin: string) {
  const encrypted = keyring.encryptBytes(code);
  const fingerprints = keyring.fingerprintsBytes(code);
  const primary = fingerprints[0];
  return {
    rowNumber,
    status: "valid",
    gtin,
    serial: serialFrom(code),
    fingerprint: primary.digest.slice(0, 12),
    errorCodes: [],
    encryptionKeyVersion: encrypted.keyVersion,
    hmacKeyVersion: primary.keyVersion,
    primaryHmac: primary.digest,
    hmacs: fingerprints.map((item) => ({
      keyVersion: item.keyVersion,
      digest: item.digest,
    })),
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.iv,
    authTag: encrypted.authTag,
  };
}

function diagnosticRow(
  code: Buffer,
  rowNumber: number,
  gtin: string,
  status: "duplicate_file" | "gtin_mismatch",
) {
  const primary = keyring.fingerprintsBytes(code)[0];
  return {
    rowNumber,
    status,
    gtin,
    serial: serialFrom(code),
    fingerprint: primary.digest.slice(0, 12),
    errorCodes: [status],
  };
}

async function asApp<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE getomerch_app");
    const result = await client.query<Row>(text, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function syntheticKm(gtin: string, serial: string, suffix: string) {
  return Buffer.concat([
    Buffer.from(`01${gtin}21${serial}`, "ascii"),
    Buffer.from([0x1d]),
    Buffer.from(`91${suffix}BCD`, "ascii"),
    Buffer.from([0x1d]),
    Buffer.from(`92SIGNATURE-${suffix}-0123456789`, "ascii"),
  ]);
}

function serialFrom(code: Buffer) {
  const start = 18;
  return code.subarray(start, code.indexOf(0x1d, start)).toString("ascii");
}

function makeGtin(first13: string) {
  let sum = 0;
  for (let index = 0; index < first13.length; index += 1) {
    sum += Number(first13[index]) * (index % 2 === 0 ? 3 : 1);
  }
  return `${first13}${(10 - (sum % 10)) % 10}`;
}

function pgCode(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (typeof current === "object" && "code" in current) {
      return String((current as { code?: unknown }).code);
    }
    current = current instanceof Error ? current.cause : null;
  }
  return "";
}

function useSsl(value: string) {
  try {
    return !["", "localhost", "127.0.0.1", "::1"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}
