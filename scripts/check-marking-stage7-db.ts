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
  console.error("Stage 7 PostgreSQL checks failed", error);
  process.exitCode = 1;
}).finally(() => pool.end());

async function main() {
  const database = (await pool.query<{ name: string }>(
    "select current_database() as name",
  )).rows[0]?.name;
  if (!database || !/^getomerch_stage(?:7|8)_[a-z0-9_]+$/.test(database)) {
    throw new Error(`Refusing Stage 7 DB tests against database: ${database ?? "unknown"}`);
  }

  const target = (
    await pool.query<{
      assignment_id: string;
      code_binding_id: string;
      fingerprint: string;
      warehouse_id: string;
      blank_id: string;
      finished_id: string;
      design_id: string;
    }>(
      `
        SELECT
          assignment.id AS assignment_id,
          assignment.code_binding_id,
          code.fingerprint,
          unit.warehouse_id,
          blank.id AS blank_id,
          unit.product_id_snapshot AS finished_id,
          finished.design_id
        FROM public.merch_marking_assignments AS assignment
        JOIN public.merch_marking_units AS unit
          ON unit.id = assignment.marking_unit_id
        JOIN public.merch_products AS finished
          ON finished.id = unit.product_id_snapshot
        JOIN public.merch_products AS blank
          ON blank.is_blank
         AND blank.category_id = finished.category_id
         AND blank.fabric_id = finished.fabric_id
         AND blank.color_id = finished.color_id
         AND blank.size_id = finished.size_id
        JOIN public.merch_marking_code_bindings AS binding
          ON binding.id = assignment.code_binding_id
        JOIN public.merch_marking_codes AS code
          ON code.id = binding.marking_code_id
        WHERE assignment.status = 'active'
          AND assignment.revision = 1
          AND binding.label_state = 'not_rendered'
          AND binding.status = 'planned'
          AND code.pool_state = 'reserved'
        ORDER BY assignment.created_at, assignment.id
        LIMIT 1
      `,
    )
  ).rows[0];
  assert.ok(target, "Stage 6 fixture did not provide a label candidate");

  const inventoryBefore = await inventory(target);
  const material = await asApp<{
    assignment_id: string;
    code_binding_id: string;
    code_ciphertext: Buffer;
    code_nonce: Buffer;
    code_auth_tag: Buffer;
    code_fingerprint: string;
  }>(
    `
      SELECT
        assignment_id,
        code_binding_id,
        code_ciphertext,
        code_nonce,
        code_auth_tag,
        code_fingerprint
      FROM getomerch_marking.get_jit_label_material($1::uuid, 1, $2)
    `,
    [target.assignment_id, "stage7-db-test"],
  );
  assert.equal(material.rows[0].assignment_id, target.assignment_id);
  assert.equal(material.rows[0].code_binding_id, target.code_binding_id);
  assert.equal(material.rows[0].code_fingerprint, target.fingerprint);
  assert.ok(Buffer.isBuffer(material.rows[0].code_ciphertext));
  assert.equal(material.rows[0].code_nonce.length, 12);
  assert.equal(material.rows[0].code_auth_tag.length, 16);

  const attempts = await Promise.allSettled([
    recordRender(target, 1),
    recordRender(target, 1),
  ]);
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = attempts.find((item) => item.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.equal(pgCode(rejected.reason), "MZ702");

  let state = await labelState(target.assignment_id);
  assert.equal(state.assignment_revision, "2");
  assert.equal(state.label_state, "label_rendered");
  assert.equal(state.render_count, 1);
  assert.ok(state.label_exposed_at);
  assert.deepEqual(await inventory(target), inventoryBefore);

  const reprint = await recordRender(target, 2);
  assert.equal(reprint.rows[0].assignment_revision, "3");
  assert.equal(reprint.rows[0].render_count, 2);
  assert.equal(reprint.rows[0].is_reprint, true);
  state = await labelState(target.assignment_id);
  assert.equal(state.label_state, "label_rendered");
  assert.equal(state.render_count, 2);
  assert.equal(state.print_confirmed_count, 0);
  assert.deepEqual(await inventory(target), inventoryBefore);

  const events = await pool.query<{
    event_type: string;
    details: string;
  }>(
    `
      SELECT event_type, details_redacted::text AS details
      FROM public.merch_marking_events
      WHERE assignment_id = $1::uuid
        AND event_type IN ('marking_label_generated', 'marking_label_reprinted')
      ORDER BY occurred_at, id
    `,
    [target.assignment_id],
  );
  assert.deepEqual(
    events.rows.map((row) => row.event_type),
    ["marking_label_generated", "marking_label_reprinted"],
  );
  assert.ok(events.rows.every((row) => (
    !/cipher|nonce|auth|serial|signature/i.test(row.details)
  )));

  await asApp(
    `
      SELECT assignment_status
      FROM getomerch_marking.cancel_jit_assignment($1::uuid, 3, $2, $3)
    `,
    [target.assignment_id, "Stage 7 cancellation after label", "stage7-db-test"],
  );
  state = await labelState(target.assignment_id);
  assert.equal(state.assignment_status, "quarantined");
  assert.equal(state.pool_state, "quarantined");
  await assert.rejects(
    asApp(
      "SELECT assignment_id FROM getomerch_marking.get_jit_label_material($1::uuid, 4, $2)",
      [target.assignment_id, "stage7-db-test"],
    ),
    (error) => pgCode(error) === "MZ703",
  );

  const applied = (
    await pool.query<{
      assignment_id: string;
      code_binding_id: string;
      fingerprint: string;
      revision: string;
    }>(
      `
        SELECT
          assignment.id AS assignment_id,
          assignment.code_binding_id,
          code.fingerprint,
          assignment.revision
        FROM public.merch_marking_assignments AS assignment
        JOIN public.merch_marking_code_bindings AS binding
          ON binding.id = assignment.code_binding_id
        JOIN public.merch_marking_codes AS code
          ON code.id = binding.marking_code_id
        WHERE assignment.status = 'active'
          AND binding.label_state = 'applied'
          AND binding.status = 'active'
          AND code.pool_state = 'bound'
        ORDER BY assignment.updated_at DESC
        LIMIT 1
      `,
    )
  ).rows[0];
  assert.ok(applied, "Stage 6 fixture did not provide an applied assignment");
  const appliedMaterial = await asApp(
    `
      SELECT assignment_id
      FROM getomerch_marking.get_jit_label_material($1::uuid, $2::bigint, $3)
    `,
    [applied.assignment_id, applied.revision, "stage7-db-test"],
  );
  assert.equal(appliedMaterial.rowCount, 1);
  const appliedReprint = await recordRender({
    assignment_id: applied.assignment_id,
    code_binding_id: applied.code_binding_id,
    fingerprint: applied.fingerprint,
  }, Number(applied.revision));
  assert.equal(appliedReprint.rows[0].label_state, "applied");
  assert.equal(appliedReprint.rows[0].is_reprint, true);

  await assert.rejects(
    asApp("SELECT id FROM public.merch_marking_code_bindings LIMIT 1"),
    (error) => pgCode(error) === "42501",
  );
  const safe = await asApp<Record<string, unknown>>(
    "SELECT * FROM getomerch_marking.assignment_action_safe LIMIT 1",
  );
  for (const forbidden of [
    "code_ciphertext",
    "code_nonce",
    "code_auth_tag",
    "code_hmac",
    "serial",
  ]) {
    assert.equal(forbidden in safe.rows[0], false);
  }

  console.log(
    "Stage 7 PostgreSQL render, reprint, quarantine, applied-reprint and ACL checks passed",
  );
}

function recordRender(
  target: {
    assignment_id: string;
    code_binding_id: string;
    fingerprint: string;
  },
  revision: number,
) {
  return asApp<{
    assignment_revision: string;
    label_state: string;
    render_count: number;
    is_reprint: boolean;
  }>(
    `
      SELECT assignment_revision, label_state, render_count, is_reprint
      FROM getomerch_marking.record_jit_label_render(
        $1::uuid,
        $2::bigint,
        $3::uuid,
        $4,
        'getomerch-58x40-v1',
        'stage7-db-test'
      )
    `,
    [
      target.assignment_id,
      revision,
      target.code_binding_id,
      target.fingerprint,
    ],
  );
}

async function labelState(assignmentId: string) {
  return (
    await pool.query<{
      assignment_status: string;
      assignment_revision: string;
      label_state: string;
      render_count: number;
      print_confirmed_count: number;
      label_exposed_at: Date | null;
      pool_state: string;
    }>(
      `
        SELECT
          assignment.status AS assignment_status,
          assignment.revision::text AS assignment_revision,
          binding.label_state,
          binding.render_count,
          binding.print_confirmed_count,
          code.label_exposed_at,
          code.pool_state
        FROM public.merch_marking_assignments AS assignment
        JOIN public.merch_marking_code_bindings AS binding
          ON binding.id = assignment.code_binding_id
        JOIN public.merch_marking_codes AS code
          ON code.id = binding.marking_code_id
        WHERE assignment.id = $1::uuid
      `,
      [assignmentId],
    )
  ).rows[0];
}

async function inventory(target: {
  warehouse_id: string;
  blank_id: string;
  finished_id: string;
  design_id: string;
}) {
  const rows = await pool.query<{ product_id: string; quantity: number }>(
    `
      SELECT product_id, quantity
      FROM public.merch_inventory
      WHERE warehouse_id = $1::uuid
        AND product_id = ANY($2::uuid[])
      ORDER BY product_id
    `,
    [target.warehouse_id, [target.blank_id, target.finished_id]],
  );
  const print = (
    await pool.query<{ quantity: number }>(
      `
        SELECT quantity
        FROM public.merch_print_inventory
        WHERE warehouse_id = $1::uuid
          AND design_id = $2::uuid
      `,
      [target.warehouse_id, target.design_id],
    )
  ).rows[0]?.quantity;
  return {
    products: rows.rows,
    print,
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
