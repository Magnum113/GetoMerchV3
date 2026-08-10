#!/usr/bin/env node

import assert from "node:assert/strict";
import { Pool, type QueryResultRow } from "pg";

const connectionString = process.env.GETOMERCH_DATABASE_URL?.trim();
if (!connectionString) throw new Error("GETOMERCH_DATABASE_URL is required");
const pool = new Pool({
  connectionString,
  max: 8,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 40_000,
  ssl: useSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
});

main().catch((error) => {
  console.error("Stage 8 PostgreSQL checks failed", error);
  process.exitCode = 1;
}).finally(() => pool.end());

async function main() {
  const database = (await pool.query<{ name: string }>(
    "select current_database() as name",
  )).rows[0]?.name;
  if (!database || !/^getomerch_stage8_[a-z0-9_]+$/.test(database)) {
    throw new Error(`Refusing Stage 8 DB tests against database: ${database ?? "unknown"}`);
  }
  const fixture = (
    await pool.query<{
      order_id: string;
      item_id: string;
      quantity: number;
    }>(`
      SELECT item.fulfillment_order_id AS order_id, item.id AS item_id,
        max(assignment.unit_ordinal)::integer AS quantity
      FROM public.merch_fulfillment_order_items AS item
      JOIN public.merch_marking_assignments AS assignment
        ON assignment.fulfillment_item_id = item.id
      WHERE item.source_active AND item.marking_requirement = 'required'
      GROUP BY item.id
      HAVING count(*) >= 2
        AND count(*) = count(DISTINCT assignment.unit_ordinal)
      ORDER BY count(*) DESC
      LIMIT 1
    `)
  ).rows[0];
  assert.ok(fixture, "Stage 6 fixture did not provide a complete multi-unit posting");
  await pool.query("BEGIN");
  try {
    await pool.query(`
      UPDATE public.merch_fulfillment_order_items
      SET quantity = $2, external_product_id = '900000001', exemplar_flow_available = true,
          source_active = true, updated_at = clock_timestamp()
      WHERE id = $1::uuid
    `, [fixture.item_id, fixture.quantity]);
    await pool.query(`
      UPDATE public.merch_marking_assignments
      SET status = 'active', released_at = NULL, release_reason = NULL,
          completed_at = NULL, revision = revision + 1,
          updated_at = clock_timestamp()
      WHERE fulfillment_item_id = $1::uuid
    `, [fixture.item_id]);
    await pool.query(`
      UPDATE public.merch_marking_units AS unit
      SET unit_state = 'ready', updated_at = clock_timestamp()
      FROM public.merch_marking_assignments AS assignment
      WHERE assignment.fulfillment_item_id = $1::uuid
        AND unit.id = assignment.marking_unit_id
    `, [fixture.item_id]);
    await pool.query(`
      UPDATE public.merch_marking_code_bindings AS binding
      SET status = 'active', label_state = 'applied',
          template_version = 'getomerch-58x40-v1',
          render_count = greatest(render_count, 1),
          first_rendered_at = coalesce(first_rendered_at, clock_timestamp()),
          last_rendered_at = clock_timestamp(),
          applied_at = coalesce(applied_at, clock_timestamp()),
          removed_at = NULL, removal_reason = NULL,
          updated_at = clock_timestamp()
      FROM public.merch_marking_assignments AS assignment
      WHERE assignment.fulfillment_item_id = $1::uuid
        AND binding.id = assignment.code_binding_id
    `, [fixture.item_id]);
    await pool.query(`
      UPDATE public.merch_marking_codes AS code
      SET pool_state = 'bound', crpt_state = 'introduced',
          blocked_reason = NULL, quarantined_at = NULL, quarantined_by = NULL,
          updated_at = clock_timestamp()
      FROM public.merch_marking_code_bindings AS binding
      JOIN public.merch_marking_assignments AS assignment
        ON assignment.code_binding_id = binding.id
      WHERE assignment.fulfillment_item_id = $1::uuid
        AND code.id = binding.marking_code_id
    `, [fixture.item_id]);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }

  const first = await prepare(fixture.order_id, false);
  assert.equal(first.request_revision, 1);
  assert.equal(first.reused, false);
  const repeated = await prepare(fixture.order_id, false);
  assert.equal(repeated.batch_id, first.batch_id);
  assert.equal(repeated.reused, true);
  const units = await safeUnits(first.batch_id);
  assert.equal(units.length, fixture.quantity);
  const mapping = units.map((unit, index) => ({
    assignment_id: unit.assignment_id,
    exemplar_id: 1001 + index,
  }));
  await asApp(
    "SELECT getomerch_marking.record_ozon_exemplar_mapping($1,$2::jsonb,2,$3::jsonb,$4)",
    [first.batch_id, JSON.stringify(mapping), JSON.stringify({ operation: "create_or_get" }), "stage8-db-test"],
  );
  const validateMaterial = await material(first.batch_id, "validate");
  assert.equal(validateMaterial.length, fixture.quantity);
  assert.ok(Buffer.isBuffer(validateMaterial[0].code_ciphertext));
  await recordValidation(first.batch_id, units, true);
  const action = await asApp<{ can_submit_ozon: boolean; ozon_state: string }>(`
    SELECT can_submit_ozon, ozon_state
    FROM getomerch_marking.assignment_action_safe
    WHERE fulfillment_order_id = $1::uuid
  `, [fixture.order_id]);
  assert.equal(action.rows.every((row) => row.can_submit_ozon), true);
  assert.equal(action.rows.every((row) => row.ozon_state === "validated"), true);
  assert.equal((await material(first.batch_id, "set")).length, fixture.quantity);
  await asApp(
    "SELECT getomerch_marking.record_ozon_set_queued_for_poll($1,$2,$3::jsonb)",
    [first.batch_id, "a".repeat(64), JSON.stringify({ httpAccepted: true })],
  );
  await assert.rejects(
    asApp(
      "SELECT getomerch_marking.record_ozon_poll($1,'ship_available','[]'::jsonb,$2::jsonb)",
      [first.batch_id, JSON.stringify({ remoteStatus: "ship_available" })],
    ),
    (error) => pgCode(error) === "MZ852",
  );
  const accepted = await asApp<{ status: string }>(`
    SELECT getomerch_marking.record_ozon_poll(
      $1, 'ship_available', $2::jsonb, $3::jsonb
    ) AS status
  `, [
    first.batch_id,
    JSON.stringify(mapping.map((item) => ({
      exemplar_id: item.exemplar_id,
      error_codes: [],
      error_message: null,
    }))),
    JSON.stringify({ remoteStatus: "ship_available" }),
  ]);
  assert.equal(accepted.rows[0].status, "accepted");
  assert.equal((await prepare(fixture.order_id, false)).batch_id, first.batch_id);

  const correction = await prepare(fixture.order_id, true);
  assert.equal(correction.request_revision, 2);
  assert.equal(correction.reused, false);
  const correctionUnits = await safeUnits(correction.batch_id);
  const correctionMapping = correctionUnits.map((unit, index) => ({
    assignment_id: unit.assignment_id,
    exemplar_id: 2001 + index,
  }));
  await asApp(
    "SELECT getomerch_marking.record_ozon_exemplar_mapping($1,$2::jsonb,0,$3::jsonb,$4)",
    [correction.batch_id, JSON.stringify(correctionMapping), JSON.stringify({ operation: "create_or_get" }), "stage8-db-test"],
  );
  await material(correction.batch_id, "validate");
  await recordValidation(correction.batch_id, correctionUnits, true);
  await material(correction.batch_id, "set");
  await asApp(
    "SELECT getomerch_marking.record_ozon_set_queued_for_poll($1,$2,$3::jsonb)",
    [correction.batch_id, "b".repeat(64), JSON.stringify({ httpAccepted: true })],
  );
  const rejectedResults = correctionMapping.map((item, index) => ({
    exemplar_id: item.exemplar_id,
    error_codes: index === 0 ? ["SYNTHETIC_REJECTION"] : [],
    error_message: index === 0 ? "synthetic rejection" : null,
  }));
  const partial = await asApp<{ status: string }>(`
    SELECT getomerch_marking.record_ozon_poll(
      $1, 'ship_not_available', $2::jsonb, $3::jsonb
    ) AS status
  `, [
    correction.batch_id,
    JSON.stringify(rejectedResults),
    JSON.stringify({ remoteStatus: "ship_not_available" }),
  ]);
  assert.equal(partial.rows[0].status, "partially_rejected");

  await assert.rejects(
    asApp("SELECT id FROM public.merch_marking_ozon_submissions LIMIT 1"),
    (error) => pgCode(error) === "42501",
  );
  const safe = await asApp<Record<string, unknown>>(
    "SELECT * FROM getomerch_marking.ozon_submission_safe LIMIT 1",
  );
  for (const forbidden of ["code_ciphertext", "code_nonce", "code_auth_tag", "mark"]) {
    assert.equal(forbidden in safe.rows[0], false);
  }
  console.log("Stage 8 PostgreSQL idempotency, quantity, partial rejection and ACL checks passed");
}

async function prepare(orderId: string, correction: boolean) {
  return (await asApp<{
    batch_id: string;
    request_revision: number;
    batch_status: string;
    reused: boolean;
  }>(
    "SELECT * FROM getomerch_marking.prepare_ozon_submission_batch($1,$2,$3)",
    [orderId, "stage8-db-test", correction],
  )).rows[0];
}

async function safeUnits(batchId: string) {
  return (await asApp<{ assignment_id: string; exemplar_id: string | null }>(`
    SELECT assignment_id, exemplar_id
    FROM getomerch_marking.ozon_submission_safe
    WHERE batch_id = $1::uuid
    ORDER BY unit_ordinal, assignment_id
  `, [batchId])).rows;
}

async function material(batchId: string, operation: "validate" | "set") {
  return (await asApp<{ code_ciphertext: Buffer }>(`
    SELECT code_ciphertext
    FROM getomerch_marking.get_ozon_submission_material($1,$2,$3)
  `, [batchId, operation, "stage8-db-test"])).rows;
}

async function recordValidation(
  batchId: string,
  units: Array<{ assignment_id: string }>,
  valid: boolean,
) {
  const results = units.map((unit) => ({
    assignment_id: unit.assignment_id,
    valid,
    error_codes: valid ? [] : ["SYNTHETIC_VALIDATION_ERROR"],
    error_message: valid ? null : "synthetic validation error",
  }));
  await asApp(
    "SELECT getomerch_marking.record_ozon_validation($1,$2::jsonb,$3::jsonb)",
    [batchId, JSON.stringify(results), JSON.stringify({ operation: "validate" })],
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
  return !value.includes("localhost") && !value.includes("127.0.0.1");
}
