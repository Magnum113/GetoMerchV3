#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";

const connectionString = process.env.GETOMERCH_DATABASE_URL?.trim();
if (!connectionString) throw new Error("GETOMERCH_DATABASE_URL is required");
const pool = new Pool({
  connectionString,
  max: 6,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 40_000,
  ssl: useSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
});

main().catch((error) => {
  console.error("Stage 11 PostgreSQL checks failed", error);
  process.exitCode = 1;
}).finally(() => pool.end());

async function main() {
  const database = (await pool.query<{ name: string }>(
    "SELECT current_database() AS name",
  )).rows[0]?.name;
  if (!database || !/^getomerch_stage(?:11|12)_[a-z0-9_]+$/.test(database)) {
    throw new Error(`Refusing Stage 11 DB tests against database: ${database ?? "unknown"}`);
  }

  const fixture = (await pool.query<{
    assignment_id: string;
    fulfillment_order_id: string;
    fulfillment_item_id: string;
    marking_unit_id: string;
    marking_code_id: string;
    warehouse_id: string;
    product_id: string;
    offer_id: string;
    posting_number: string;
  }>(
    `SELECT assignment.id AS assignment_id,
      item.fulfillment_order_id, item.id AS fulfillment_item_id,
      assignment.marking_unit_id, binding.marking_code_id,
      unit.warehouse_id, item.product_id, item.offer_id,
      fulfillment_order.external_posting_number AS posting_number
     FROM public.merch_marking_assignments AS assignment
     JOIN public.merch_fulfillment_order_items AS item
       ON item.id = assignment.fulfillment_item_id
     JOIN public.merch_fulfillment_orders AS fulfillment_order
       ON fulfillment_order.id = item.fulfillment_order_id
     JOIN public.merch_marking_units AS unit ON unit.id = assignment.marking_unit_id
     JOIN public.merch_marking_code_bindings AS binding
       ON binding.id = assignment.code_binding_id
     WHERE assignment.status = 'active'
       AND item.source_active AND item.marking_requirement = 'required'
       AND binding.status = 'active' AND binding.label_state = 'applied'
     ORDER BY assignment.updated_at DESC, assignment.id DESC
     LIMIT 1`,
  )).rows[0];
  assert.ok(fixture, "Stage 6 fixture did not leave an applied assignment");

  await pool.query("BEGIN");
  try {
    await pool.query(
      `UPDATE public.merch_fulfillment_order_items SET quantity = 1,
        external_product_id = '900000011', exemplar_flow_available = true,
        source_active = true, updated_at = clock_timestamp()
       WHERE id = $1::uuid`,
      [fixture.fulfillment_item_id],
    );
    await pool.query(
      `UPDATE public.merch_marking_units SET unit_state = 'reserved',
        custody_state = 'getomerch', updated_at = clock_timestamp()
       WHERE id = $1::uuid`,
      [fixture.marking_unit_id],
    );
    await pool.query(
      `UPDATE public.merch_marking_codes SET crpt_state = 'in_circulation',
        crpt_status_raw = 'IN_CIRCULATION', crpt_checked_at = clock_timestamp(),
        updated_at = clock_timestamp() WHERE id = $1::uuid`,
      [fixture.marking_code_id],
    );
    await pool.query(
      `INSERT INTO public.merch_marking_locations (
        name, warehouse_id, kpp, fias_id, crpt_location_id,
        address_snapshot, status, verified_at
      ) VALUES (
        'Stage 11 location', $1::uuid, '050001001', $2,
        'STAGE11-LOCATION', 'Synthetic address', 'verified', clock_timestamp()
      )`,
      [fixture.warehouse_id, randomUUID()],
    );
    const ozonOrderId = (await pool.query<{ id: string }>(
      `INSERT INTO public.merch_ozon_orders (
        posting_number, status, source, fulfillment_order_id, total_price
      ) VALUES ($1, 'awaiting_deliver', 'fbs', $2::uuid, 6700)
      RETURNING id`,
      [fixture.posting_number, fixture.fulfillment_order_id],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO public.merch_ozon_order_items (
        order_id, offer_id, name, quantity, price, product_id,
        source_item_key, ozon_product_id, marking_requirement,
        exemplar_flow_available, source_active, fulfillment_item_id
      ) VALUES (
        $1::uuid, $2, 'Stage 11 shirt', 1, 6700, $3::uuid,
        $4, '900000011', 'required', true, true, $5::uuid
      )`,
      [ozonOrderId, fixture.offer_id, fixture.product_id,
        `stage11:${randomUUID()}`, fixture.fulfillment_item_id],
    );
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }

  const blocked = await gate(fixture.fulfillment_order_id, "observe");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.blockers.includes("ozon_exemplar_not_accepted"));

  const batchId = (await pool.query<{ id: string }>(
    `INSERT INTO public.merch_marking_ozon_submission_batches (
      fulfillment_order_id, posting_number, posting_snapshot_hash,
      request_revision, status, request_hash, accepted_at, created_by
    ) VALUES (
      $1::uuid, $2, repeat('a',64), 1, 'accepted', repeat('b',64),
      clock_timestamp(), 'stage11-db-test'
    ) RETURNING id`,
    [fixture.fulfillment_order_id, fixture.posting_number],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO public.merch_marking_ozon_submissions (
      batch_id, assignment_id, assignment_revision, ozon_product_id,
      exemplar_id, status
    ) SELECT $1::uuid, assignment.id, assignment.revision,
      900000011, 11001, 'accepted'
    FROM public.merch_marking_assignments AS assignment
    WHERE assignment.id = $2::uuid`,
    [batchId, fixture.assignment_id],
  );

  const readyRequestId = randomUUID();
  const ready = await gate(fixture.fulfillment_order_id, "enforce", readyRequestId);
  assert.equal(ready.allowed, true);
  assert.deepEqual(ready.blockers, []);
  await pool.query(
    `UPDATE public.merch_ozon_orders SET shipped_at = clock_timestamp()
     WHERE fulfillment_order_id = $1::uuid`,
    [fixture.fulfillment_order_id],
  );
  await assert.rejects(
    asApp(
      `SELECT handover_id
       FROM getomerch_marking.record_shipping_handover(
         $1::uuid,$2::uuid,$3,$4::uuid,$5
       )`,
      [fixture.fulfillment_order_id, ready.evaluation_id, "stage11-db-test",
        randomUUID(), `stage11-wrong-request:${randomUUID()}`],
    ),
    (error) => pgCode(error) === "MZB21",
  );
  const handover = await asApp<{
    handover_id: string;
    document_id: string;
    document_status: string;
    gate_allowed: boolean;
    reused: boolean;
  }>(
    `SELECT handover_id, document_id, document_status, gate_allowed, reused
     FROM getomerch_marking.record_shipping_handover(
       $1::uuid,$2::uuid,$3,$4::uuid,$5
    )`,
    [fixture.fulfillment_order_id, ready.evaluation_id, "stage11-db-test",
      readyRequestId, `stage11-handover:${randomUUID()}`],
  ).then((result) => result.rows[0]);
  assert.equal(handover.gate_allowed, true);
  assert.equal(handover.document_status, "draft");
  const repeated = await asApp<{ handover_id: string; document_id: string; reused: boolean }>(
    `SELECT handover_id, document_id, reused
     FROM getomerch_marking.record_shipping_handover(
       $1::uuid,$2::uuid,$3,$4::uuid,$5
     )`,
    [fixture.fulfillment_order_id, ready.evaluation_id, "stage11-db-test",
      randomUUID(), `stage11-repeat:${randomUUID()}`],
  ).then((result) => result.rows[0]);
  assert.equal(repeated.handover_id, handover.handover_id);
  assert.equal(repeated.document_id, handover.document_id);
  assert.equal(repeated.reused, true);

  const material = await asApp<{
    product_cost_minor: string;
    kpp: string;
    fias_id: string;
    code_ciphertext: Buffer;
  }>(
    `SELECT product_cost_minor, kpp, fias_id, code_ciphertext
     FROM getomerch_marking.get_withdrawal_document_material($1::uuid,$2)`,
    [handover.document_id, "stage11-db-test"],
  );
  assert.equal(material.rows.length, 1);
  assert.equal(material.rows[0].product_cost_minor, "670000");
  assert.equal(material.rows[0].kpp, "050001001");
  assert.ok(Buffer.isBuffer(material.rows[0].code_ciphertext));

  await asApp(
    `SELECT getomerch_marking.store_introduction_payload(
      $1::uuid,$2,$3::bytea,$4::bytea,$5::bytea,1,$6
    )`,
    [handover.document_id, randomBytes(32).toString("hex"), randomBytes(128),
      randomBytes(12), randomBytes(16), "stage11-db-test"],
  );
  await asApp(
    `SELECT getomerch_marking.store_introduction_signature(
      $1::uuid,$2,$3::bytea,$4::bytea,$5::bytea,1,$6,$7
    )`,
    [handover.document_id, randomBytes(32).toString("hex"), randomBytes(128),
      randomBytes(12), randomBytes(16), "B".repeat(40), "stage11-db-test"],
  );
  await asApp(
    "SELECT getomerch_marking.record_introduction_submit_started($1::uuid,$2)",
    [handover.document_id, "stage11-db-test"],
  );
  await asApp(
    `SELECT getomerch_marking.record_introduction_submitted(
      $1::uuid,$2,$3::jsonb,$4
    )`,
    [handover.document_id, "STAGE11-WITHDRAWAL-ACCEPTED",
      JSON.stringify({ acceptedForProcessing: true }), "stage11-db-test"],
  );
  const processing = await asApp<{ status: string }>(
    `SELECT getomerch_marking.record_withdrawal_poll(
      $1::uuid,'IN_PROGRESS',$2::jsonb,NULL,NULL,$3
    ) AS status`,
    [handover.document_id, JSON.stringify({ status: "IN_PROGRESS" }), "stage11-db-test"],
  );
  assert.equal(processing.rows[0].status, "processing");
  const rejected = await asApp<{ status: string }>(
    `SELECT getomerch_marking.record_withdrawal_poll(
      $1::uuid,'CHECKED_NOT_OK',$2::jsonb,'SYNTHETIC_REJECT',$3,$4
    ) AS status`,
    [handover.document_id, JSON.stringify({ status: "CHECKED_NOT_OK" }),
      "Synthetic validation error", "stage11-db-test"],
  );
  assert.equal(rejected.rows[0].status, "rejected");
  const correction = await asApp<{
    document_id: string;
    document_status: string;
    document_revision: number;
    reused: boolean;
  }>(
    `SELECT document_id, document_status, document_revision, reused
     FROM getomerch_marking.prepare_withdrawal_document($1::uuid,$2,$3::uuid,true)`,
    [handover.handover_id, "stage11-db-test", randomUUID()],
  ).then((result) => result.rows[0]);
  assert.equal(correction.document_status, "draft");
  assert.equal(correction.document_revision, 2);
  assert.equal(correction.reused, false);
  await asApp(
    `SELECT getomerch_marking.store_introduction_payload(
      $1::uuid,$2,$3::bytea,$4::bytea,$5::bytea,1,$6
    )`,
    [correction.document_id, randomBytes(32).toString("hex"), randomBytes(128),
      randomBytes(12), randomBytes(16), "stage11-db-test"],
  );
  await asApp(
    `SELECT getomerch_marking.store_introduction_signature(
      $1::uuid,$2,$3::bytea,$4::bytea,$5::bytea,1,$6,$7
    )`,
    [correction.document_id, randomBytes(32).toString("hex"), randomBytes(128),
      randomBytes(12), randomBytes(16), "C".repeat(40), "stage11-db-test"],
  );
  await asApp(
    "SELECT getomerch_marking.record_introduction_submit_started($1::uuid,$2)",
    [correction.document_id, "stage11-db-test"],
  );
  await asApp(
    `SELECT getomerch_marking.record_introduction_submitted(
      $1::uuid,$2,$3::jsonb,$4
    )`,
    [correction.document_id, "STAGE11-WITHDRAWAL-CORRECTION",
      JSON.stringify({ acceptedForProcessing: true }), "stage11-db-test"],
  );
  const accepted = await asApp<{ status: string }>(
    `SELECT getomerch_marking.record_withdrawal_poll(
      $1::uuid,'CHECKED_OK',$2::jsonb,NULL,NULL,$3
    ) AS status`,
    [correction.document_id, JSON.stringify({ status: "CHECKED_OK" }), "stage11-db-test"],
  );
  assert.equal(accepted.rows[0].status, "accepted");

  const final = (await pool.query<{
    assignment_status: string;
    unit_state: string;
    custody_state: string;
    crpt_state: string;
    withdrawal_state: string;
    process_status: string;
  }>(
    `SELECT assignment.status AS assignment_status,
      unit.unit_state, unit.custody_state, code.crpt_state,
      confirmation.withdrawal_state, process.status AS process_status
     FROM public.merch_marking_documents AS document
     JOIN public.merch_marking_document_codes AS link ON link.document_id = document.id
     JOIN public.merch_marking_assignments AS assignment ON assignment.id = link.assignment_id
     JOIN public.merch_marking_units AS unit ON unit.id = link.marking_unit_id
     JOIN public.merch_marking_codes AS code ON code.id = link.marking_code_id
     JOIN public.merch_marking_withdrawal_confirmations AS confirmation
       ON confirmation.document_id = document.id
     JOIN public.merch_marking_processes AS process ON process.id = document.process_id
     WHERE document.id = $1::uuid`,
    [correction.document_id],
  )).rows[0];
  assert.deepEqual(final, {
    assignment_status: "completed",
    unit_state: "shipped",
    custody_state: "ozon",
    crpt_state: "withdrawn",
    withdrawal_state: "confirmed",
    process_status: "completed",
  });
  await assert.rejects(
    asApp("SELECT id FROM public.merch_marking_handovers LIMIT 1"),
    (error) => pgCode(error) === "42501",
  );
  const safe = await asApp<Record<string, unknown>>(
    "SELECT * FROM getomerch_marking.shipping_handover_safe WHERE id = $1::uuid",
    [handover.handover_id],
  );
  for (const forbidden of ["code_ciphertext", "payload_ciphertext", "signature_ciphertext"]) {
    assert.equal(forbidden in safe.rows[0], false);
  }
  const revisions = await pool.query<{ revision: number; status: string }>(
    `SELECT revision, status FROM public.merch_marking_documents
     WHERE handover_id = $1::uuid ORDER BY revision`,
    [handover.handover_id],
  );
  assert.deepEqual(revisions.rows, [
    { revision: 1, status: "superseded" },
    { revision: 2, status: "accepted" },
  ]);
  console.log("Stage 11 gate, handover, idempotency, rejection and correction checks passed");
}

async function gate(
  orderId: string,
  mode: "observe" | "enforce",
  requestId = randomUUID(),
) {
  return asApp<{
    evaluation_id: string;
    allowed: boolean;
    blockers: string[];
  }>(
    `SELECT evaluation_id, allowed, blockers
     FROM getomerch_marking.evaluate_shipping_gate($1::uuid,$2,$3,$4::uuid)`,
    [orderId, mode, "stage11-db-test", requestId],
  ).then((result) => result.rows[0]);
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
  const hostname = new URL(value).hostname;
  return hostname !== "" && hostname !== "localhost" && hostname !== "127.0.0.1";
}
