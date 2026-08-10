#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";

const connectionString = process.env.GETOMERCH_DATABASE_URL?.trim();
if (!connectionString) throw new Error("GETOMERCH_DATABASE_URL is required");

const pool = new Pool({
  connectionString,
  max: 4,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 40_000,
  ssl: useSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
});

main().catch((error) => {
  console.error("Stage 10 PostgreSQL checks failed", error);
  process.exitCode = 1;
}).finally(() => pool.end());

async function main() {
  const database = (await pool.query<{ name: string }>(
    "SELECT current_database() AS name",
  )).rows[0]?.name;
  if (!database || !/^getomerch_stage10_[a-z0-9_]+$/.test(database)) {
    throw new Error(`Refusing Stage 10 DB tests against database: ${database ?? "unknown"}`);
  }

  const fixture = (await pool.query<{
    assignment_id: string;
    warehouse_id: string;
    trade_item_id: string;
    marking_code_id: string;
    marking_unit_id: string;
  }>(
    `SELECT assignment.id AS assignment_id, unit.warehouse_id,
      profile.trade_item_id, code.id AS marking_code_id,
      unit.id AS marking_unit_id
     FROM public.merch_marking_assignments AS assignment
     JOIN public.merch_marking_units AS unit ON unit.id = assignment.marking_unit_id
     JOIN public.merch_marking_code_bindings AS binding
       ON binding.id = assignment.code_binding_id
     JOIN public.merch_marking_codes AS code ON code.id = binding.marking_code_id
     JOIN public.merch_marking_product_profiles AS profile
       ON profile.id = assignment.product_profile_id
     WHERE assignment.status = 'active'
       AND unit.unit_state = 'marking_pending'
       AND binding.status = 'active'
       AND binding.label_state = 'applied'
       AND code.pool_state = 'bound'
     ORDER BY assignment.created_at DESC, assignment.id DESC
     LIMIT 1`,
  )).rows[0];
  assert.ok(fixture, "Stage 6 fixture did not leave an applied assignment");

  await pool.query(
    "UPDATE public.merch_marking_trade_items SET product_group = 'lp' WHERE id = $1::uuid",
    [fixture.trade_item_id],
  );
  await pool.query(
    `INSERT INTO public.merch_marking_locations (
      name, warehouse_id, crpt_location_id, address_snapshot,
      status, verified_at
    ) VALUES (
      'Stage 10 production location', $1::uuid, 'STAGE10-LOCATION',
      'Synthetic test address', 'verified', clock_timestamp()
    )`,
    [fixture.warehouse_id],
  );

  const revisionOne = await prepare(fixture.assignment_id, false);
  assert.equal(revisionOne.document_status, "draft");
  assert.equal(Number(revisionOne.document_revision), 1);
  await buildSignAndSubmit(revisionOne.document_id, "STAGE10-DOC-REJECTED");
  assert.equal(await poll(revisionOne.document_id, "IN_PROGRESS"), "processing");
  assert.equal(await poll(
    revisionOne.document_id,
    "CHECKED_NOT_OK",
    "INTRO_ERROR",
    "Synthetic validation rejection",
  ), "rejected");

  const revisionTwo = await prepare(fixture.assignment_id, true);
  assert.equal(revisionTwo.document_status, "draft");
  assert.equal(Number(revisionTwo.document_revision), 2);
  assert.equal(revisionTwo.reused, false);
  const first = (await pool.query<{ status: string; link_state: string }>(
    `SELECT document.status, link.link_state
     FROM public.merch_marking_documents AS document
     JOIN public.merch_marking_document_codes AS link ON link.document_id = document.id
     WHERE document.id = $1::uuid`,
    [revisionOne.document_id],
  )).rows[0];
  assert.deepEqual(first, { status: "superseded", link_state: "superseded" });

  await buildSignAndSubmit(revisionTwo.document_id, "STAGE10-DOC-ACCEPTED");
  assert.equal(await poll(revisionTwo.document_id, "CHECKED_OK"), "accepted");
  assert.equal(await poll(revisionTwo.document_id, "CHECKED_OK"), "accepted");
  await confirmCirculation(revisionTwo.document_id);
  await confirmCirculation(revisionTwo.document_id);

  const accepted = (await pool.query<{
    status: string;
    circulation_state: string;
    crpt_state: string;
    unit_state: string;
    event_count: string;
  }>(
    `SELECT document.status, confirmation.circulation_state,
      code.crpt_state, unit.unit_state,
      (SELECT count(*)::text FROM public.merch_marking_events AS event
       WHERE event.document_id = document.id
         AND event.event_type = 'crpt_introduction_confirmed') AS event_count
     FROM public.merch_marking_documents AS document
     JOIN public.merch_marking_document_confirmations AS confirmation
       ON confirmation.document_id = document.id
     JOIN public.merch_marking_document_codes AS link ON link.document_id = document.id
     JOIN public.merch_marking_codes AS code ON code.id = link.marking_code_id
     JOIN public.merch_marking_units AS unit ON unit.id = link.marking_unit_id
     WHERE document.id = $1::uuid`,
    [revisionTwo.document_id],
  )).rows[0];
  assert.deepEqual(accepted, {
    status: "accepted",
    circulation_state: "confirmed",
    crpt_state: "in_circulation",
    unit_state: "reserved",
    event_count: "1",
  });

  const safe = await asApp<Record<string, unknown>>(
    `SELECT document.*, code.crpt_state
     FROM getomerch_marking.document_safe AS document
     JOIN getomerch_marking.document_code_safe AS code
       ON code.document_id = document.id
     WHERE document.id = $1::uuid`,
    [revisionTwo.document_id],
  );
  assert.equal(safe.rowCount, 1);
  for (const forbidden of [
    "payload_ciphertext", "signature_ciphertext", "code_ciphertext",
  ]) {
    assert.equal(forbidden in safe.rows[0], false);
  }
  await assert.rejects(
    pool.query(
      "UPDATE public.merch_marking_documents SET updated_at = clock_timestamp() WHERE id = $1::uuid",
      [revisionTwo.document_id],
    ),
    (error) => pgCode(error) === "MZA11",
  );
  await assert.rejects(
    asApp("SELECT id FROM public.merch_marking_documents LIMIT 1"),
    (error) => pgCode(error) === "42501",
  );

  console.log("Stage 10 PostgreSQL revision, terminal-state and circulation checks passed");
}

async function prepare(assignmentId: string, forceCorrection: boolean) {
  return (await asApp<{
    document_id: string;
    document_status: string;
    document_revision: number;
    reused: boolean;
  }>(
    `SELECT document_id, document_status, document_revision, reused
     FROM getomerch_marking.prepare_introduction_document($1::uuid,$2,$3::uuid,$4)`,
    [assignmentId, "stage10-db-test", randomUUID(), forceCorrection],
  )).rows[0];
}

async function buildSignAndSubmit(documentId: string, externalDocumentId: string) {
  await asApp(
    `SELECT getomerch_marking.store_introduction_payload(
      $1::uuid,$2,$3::bytea,$4::bytea,$5::bytea,1,$6
    )`,
    [documentId, randomBytes(32).toString("hex"), randomBytes(128),
      randomBytes(12), randomBytes(16), "stage10-db-test"],
  );
  await asApp(
    `SELECT getomerch_marking.store_introduction_signature(
      $1::uuid,$2,$3::bytea,$4::bytea,$5::bytea,1,$6,$7
    )`,
    [documentId, randomBytes(32).toString("hex"), randomBytes(128),
      randomBytes(12), randomBytes(16), "A".repeat(40), "stage10-db-test"],
  );
  const started = (await asApp<{ status: string }>(
    "SELECT getomerch_marking.record_introduction_submit_started($1::uuid,$2) AS status",
    [documentId, "stage10-db-test"],
  )).rows[0].status;
  assert.equal(started, "submitting");
  const status = (await asApp<{ status: string }>(
    `SELECT getomerch_marking.record_introduction_submitted(
      $1::uuid,$2,$3::jsonb,$4
    ) AS status`,
    [documentId, externalDocumentId, JSON.stringify({ acceptedForProcessing: true }),
      "stage10-db-test"],
  )).rows[0].status;
  assert.equal(status, "processing");
}

async function poll(
  documentId: string,
  status: string,
  errorCode: string | null = null,
  errorMessage: string | null = null,
) {
  return (await asApp<{ status: string }>(
    `SELECT getomerch_marking.record_introduction_poll(
      $1::uuid,$2,$3::jsonb,$4,$5
    ) AS status`,
    [documentId, status, JSON.stringify({ status }), errorCode, errorMessage],
  )).rows[0].status;
}

async function confirmCirculation(documentId: string) {
  await asApp(
    "SELECT getomerch_marking.confirm_introduction_circulation($1::uuid,$2,$3)",
    [documentId, "IN_CIRCULATION", "stage10-db-test"],
  );
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

function pgCode(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (typeof current === "object" && "code" in current) {
      return String((current as { code?: unknown }).code);
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return "";
}

function useSsl(value: string) {
  return !value.includes("localhost") && !value.includes("127.0.0.1")
    && !value.includes("%2Fvar%2Frun%2Fpostgresql");
}
