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
  console.error("Stage 12 PostgreSQL checks failed", error);
  process.exitCode = 1;
}).finally(() => pool.end());

async function main() {
  const database = (await pool.query<{ name: string }>(
    "SELECT current_database() AS name",
  )).rows[0]?.name;
  if (!database || !/^getomerch_stage12_[a-z0-9_]+$/.test(database)) {
    throw new Error(`Refusing Stage 12 DB tests against database: ${database ?? "unknown"}`);
  }

  const fixture = (await pool.query<Fixture>(
    `SELECT document.id AS withdrawal_document_id,
      document.fulfillment_order_id, document.handover_id,
      handover.posting_number, handover_unit.assignment_id,
      handover_unit.marking_unit_id, handover_unit.marking_code_id,
      unit.product_id_snapshot AS product_id,
      location.warehouse_id, item.offer_id,
      item.external_product_id AS ozon_sku
     FROM public.merch_marking_documents AS document
     JOIN public.merch_marking_withdrawal_confirmations AS confirmation
       ON confirmation.document_id = document.id
     JOIN public.merch_marking_handovers AS handover
       ON handover.id = document.handover_id
     JOIN public.merch_marking_handover_units AS handover_unit
       ON handover_unit.handover_id = handover.id
     JOIN public.merch_marking_assignments AS assignment
       ON assignment.id = handover_unit.assignment_id
     JOIN public.merch_fulfillment_order_items AS item
       ON item.id = assignment.fulfillment_item_id
     JOIN public.merch_marking_units AS unit
       ON unit.id = handover_unit.marking_unit_id
     JOIN public.merch_marking_locations AS location
       ON location.id = document.location_id
     WHERE document.document_type = 'withdrawal_remote_sale'
       AND document.status = 'accepted'
       AND confirmation.withdrawal_state = 'confirmed'
       AND assignment.status = 'completed'
     ORDER BY document.accepted_at DESC, document.id DESC
     LIMIT 1`,
  )).rows[0];
  assert.ok(fixture, "Stage 11 checks did not leave an accepted withdrawal fixture");

  await ensureInventoryRow(fixture.product_id, fixture.warehouse_id);
  const initialStock = await inventoryQuantity(fixture.product_id, fixture.warehouse_id);

  const sellerCase = await upsertReturn(fixture, {
    returnId: `STAGE12-SELLER-${randomUUID()}`,
    itemId: "1",
    quantity: 1,
    returnKind: "not_picked_up_to_seller",
    hash: "a".repeat(64),
  });
  assert.equal(sellerCase.identity_linked, true);
  assert.equal(sellerCase.process_status, "detected");

  const repeated = await upsertReturn(fixture, {
    returnId: sellerCase.source_return_id,
    itemId: "1",
    quantity: 1,
    returnKind: "not_picked_up_to_seller",
    hash: "a".repeat(64),
  });
  assert.equal(repeated.return_case_id, sellerCase.return_case_id);
  assert.equal(repeated.case_version, sellerCase.case_version);

  await assert.rejects(
    prepareReturn(sellerCase.return_case_id),
    (error) => pgCode(error) === "MZC21",
  );

  const sellerDirection = await confirmDirection(
    sellerCase.return_case_id,
    Number(sellerCase.case_version),
    "to_seller",
    false,
  );
  assert.equal(sellerDirection.process_status, "direction_confirmed");
  const sellerDocument = await prepareReturn(sellerCase.return_case_id);
  assert.equal(sellerDocument.document_status, "draft");
  assert.equal(sellerDocument.no_op, false);
  await acceptReturnDocument(sellerDocument.document_id);

  let sellerReady = await returnState(sellerCase.return_case_id);
  assert.equal(sellerReady.process_status, "awaiting_physical_receipt");
  assert.equal(sellerReady.crpt_state, "in_circulation");
  assert.equal(sellerReady.custody_state, "ozon");
  assert.equal(
    await inventoryQuantity(fixture.product_id, fixture.warehouse_id),
    initialStock,
    "CRPT acceptance must not receive physical stock",
  );
  await assert.rejects(
    confirmDirection(
      sellerCase.return_case_id,
      Number(sellerReady.version),
      "to_seller",
      true,
    ),
    (error) => pgCode(error) === "MZC16",
  );
  const redirectedToFbo = await confirmDirection(
    sellerCase.return_case_id,
    Number(sellerReady.version),
    "to_ozon_fbo",
    false,
  );
  assert.equal(redirectedToFbo.process_status, "awaiting_fbo_evidence");
  const redirectedBack = await confirmDirection(
    sellerCase.return_case_id,
    Number(redirectedToFbo.case_version),
    "to_seller",
    false,
  );
  assert.equal(redirectedBack.process_status, "awaiting_physical_receipt");
  sellerReady = await returnState(sellerCase.return_case_id);

  const sellerReceipt = await receiveIntact(
    sellerCase.return_case_id,
    Number(sellerReady.version),
    fixture.product_id,
    fixture.warehouse_id,
  );
  assert.equal(sellerReceipt.process_status, "completed");
  assert.equal(sellerReceipt.stock_received, true);
  assert.equal(
    await inventoryQuantity(fixture.product_id, fixture.warehouse_id),
    initialStock + 1,
  );
  const sellerFinal = await returnState(sellerCase.return_case_id);
  assert.equal(sellerFinal.unit_state, "returned");
  assert.equal(sellerFinal.custody_state, "getomerch");
  await assert.rejects(
    asApp(
      `SELECT * FROM getomerch_marking.record_seller_return_receipt(
        $1::uuid,$2::bigint,'intact',$3::uuid,$4::uuid,$5,$6::uuid
      )`,
      [sellerCase.return_case_id, sellerFinal.version, fixture.warehouse_id,
        sellerReceipt.inventory_transaction_id, "stage12-db-test", randomUUID()],
    ),
    (error) => pgCode(error) === "MZC31",
  );
  assert.equal(
    await inventoryQuantity(fixture.product_id, fixture.warehouse_id),
    initialStock + 1,
    "repeated receipt must not increment stock",
  );

  await pool.query(
    `UPDATE public.merch_marking_codes SET crpt_state = 'withdrawn',
       crpt_status_raw = 'WITHDRAWN', updated_at = clock_timestamp()
     WHERE id = $1::uuid`,
    [fixture.marking_code_id],
  );
  await pool.query(
    `UPDATE public.merch_marking_units SET unit_state = 'shipped',
       custody_state = 'ozon', warehouse_id = $2::uuid,
       version = version + 1, updated_at = clock_timestamp()
     WHERE id = $1::uuid`,
    [fixture.marking_unit_id, fixture.warehouse_id],
  );
  const stockBeforeFbo = await inventoryQuantity(fixture.product_id, fixture.warehouse_id);
  const fboCase = await upsertReturn(fixture, {
    returnId: `STAGE12-FBO-${randomUUID()}`,
    itemId: "1",
    quantity: 1,
    returnKind: "to_ozon_fbo",
    hash: "b".repeat(64),
  });
  const fboDirection = await confirmDirection(
    fboCase.return_case_id,
    Number(fboCase.case_version),
    "to_ozon_fbo",
    false,
  );
  assert.equal(fboDirection.destination, "to_ozon_fbo");
  const fboDocument = await prepareReturn(fboCase.return_case_id);
  await acceptReturnDocument(fboDocument.document_id);
  const fboReady = await returnState(fboCase.return_case_id);
  assert.equal(fboReady.process_status, "awaiting_fbo_evidence");
  const fboConfirmed = await asApp<{
    process_status: string;
    case_version: string;
  }>(
    `SELECT process_status, case_version
     FROM getomerch_marking.confirm_return_fbo_transfer(
       $1::uuid,$2::bigint,$3,$4,$5,$6::uuid
     )`,
    [fboCase.return_case_id, fboReady.version, "FBO-INTAKE-STAGE12",
      "EDO-STAGE12", "stage12-db-test", randomUUID()],
  ).then((result) => result.rows[0]);
  assert.equal(fboConfirmed.process_status, "completed");
  const fboFinal = await returnState(fboCase.return_case_id);
  assert.equal(fboFinal.custody_state, "ozon_fbo");
  assert.equal(fboFinal.unit_warehouse_id, null);
  assert.equal(
    await inventoryQuantity(fixture.product_id, fixture.warehouse_id),
    stockBeforeFbo,
    "FBS to FBO must not change GetoMerch inventory",
  );
  await assert.rejects(
    asApp(
      `SELECT * FROM getomerch_marking.confirm_return_fbo_transfer(
        $1::uuid,$2::bigint,$3,$4,$5,$6::uuid
      )`,
      [fboCase.return_case_id, fboFinal.version, "FBO-INTAKE-STAGE12",
        "EDO-STAGE12", "stage12-db-test", randomUUID()],
    ),
    (error) => pgCode(error) === "MZC41",
  );

  const ambiguous = await upsertReturn(fixture, {
    returnId: `STAGE12-AMBIGUOUS-${randomUUID()}`,
    itemId: "1",
    quantity: 2,
    returnKind: "unknown",
    hash: "c".repeat(64),
  });
  assert.equal(ambiguous.identity_linked, false);
  assert.equal(ambiguous.process_status, "manual_review");

  await assert.rejects(
    asApp("SELECT id FROM public.merch_marking_return_cases LIMIT 1"),
    (error) => pgCode(error) === "42501",
  );
  const safe = await asApp<Record<string, unknown>>(
    "SELECT * FROM getomerch_marking.return_case_safe WHERE id = $1::uuid",
    [sellerCase.return_case_id],
  );
  for (const forbidden of ["code_ciphertext", "payload_ciphertext", "signature_ciphertext"]) {
    assert.equal(forbidden in safe.rows[0], false);
  }
  console.log("Stage 12 seller return, FBS-to-FBO and idempotency checks passed");
}

async function upsertReturn(
  fixture: Fixture,
  input: {
    returnId: string;
    itemId: string;
    quantity: number;
    returnKind: string;
    hash: string;
  },
) {
  const row = (await asApp<ReturnUpsertRow>(
    `SELECT result.*, $1::text AS source_return_id
     FROM getomerch_marking.upsert_ozon_return_case(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,clock_timestamp(),$12
     ) AS result`,
    [input.returnId, input.itemId, fixture.posting_number, fixture.offer_id,
      fixture.ozon_sku, input.quantity, input.returnKind, "moving",
      input.hash, "stage12-db-contract", JSON.stringify({ status: "moving" }),
      "stage12-db-test"],
  )).rows[0];
  return row;
}

async function confirmDirection(
  returnCaseId: string,
  expectedVersion: number,
  destination: "to_seller" | "to_ozon_fbo",
  paid: boolean,
) {
  return (await asApp<{
    case_version: string;
    process_status: string;
    destination: string;
  }>(
    `SELECT case_version, process_status, destination
     FROM getomerch_marking.confirm_return_direction(
       $1::uuid,$2::bigint,$3,$4,$5,$6::uuid
     )`,
    [returnCaseId, expectedVersion, destination, paid,
      "stage12-db-test", randomUUID()],
  )).rows[0];
}

async function prepareReturn(returnCaseId: string) {
  return (await asApp<{
    document_id: string;
    document_status: string;
    document_revision: number;
    reused: boolean;
    no_op: boolean;
  }>(
    `SELECT document_id, document_status, document_revision, reused, no_op
     FROM getomerch_marking.prepare_return_document($1::uuid,$2,$3::uuid,false)`,
    [returnCaseId, "stage12-db-test", randomUUID()],
  )).rows[0];
}

async function acceptReturnDocument(documentId: string) {
  await asApp(
    `SELECT getomerch_marking.store_introduction_payload(
      $1::uuid,$2,$3::bytea,$4::bytea,$5::bytea,1,$6
    )`,
    [documentId, randomBytes(32).toString("hex"), randomBytes(128),
      randomBytes(12), randomBytes(16), "stage12-db-test"],
  );
  await asApp(
    `SELECT getomerch_marking.store_introduction_signature(
      $1::uuid,$2,$3::bytea,$4::bytea,$5::bytea,1,$6,$7
    )`,
    [documentId, randomBytes(32).toString("hex"), randomBytes(128),
      randomBytes(12), randomBytes(16), "D".repeat(40), "stage12-db-test"],
  );
  await asApp(
    "SELECT getomerch_marking.record_introduction_submit_started($1::uuid,$2)",
    [documentId, "stage12-db-test"],
  );
  await asApp(
    `SELECT getomerch_marking.record_introduction_submitted(
      $1::uuid,$2,$3::jsonb,$4
    )`,
    [documentId, `STAGE12-${randomUUID()}`,
      JSON.stringify({ acceptedForProcessing: true }), "stage12-db-test"],
  );
  const processing = await asApp<{ status: string }>(
    `SELECT getomerch_marking.record_return_poll(
      $1::uuid,'IN_PROGRESS',$2::jsonb,NULL,NULL,$3
    ) AS status`,
    [documentId, JSON.stringify({ status: "IN_PROGRESS" }), "stage12-db-test"],
  );
  assert.equal(processing.rows[0].status, "processing");
  const accepted = await asApp<{ status: string }>(
    `SELECT getomerch_marking.record_return_poll(
      $1::uuid,'CHECKED_OK',$2::jsonb,NULL,NULL,$3
    ) AS status`,
    [documentId, JSON.stringify({ status: "CHECKED_OK" }), "stage12-db-test"],
  );
  assert.equal(accepted.rows[0].status, "accepted");
}

async function receiveIntact(
  returnCaseId: string,
  expectedVersion: number,
  productId: string,
  warehouseId: string,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE getomerch_app");
    const locked = await client.query(
      `SELECT id FROM getomerch_marking.get_seller_receipt_context($1::uuid)`,
      [returnCaseId],
    );
    assert.equal(locked.rows.length, 1);
    await client.query(
      `INSERT INTO public.merch_inventory (product_id, warehouse_id, quantity)
       VALUES ($1::uuid,$2::uuid,0)
       ON CONFLICT (product_id, warehouse_id) DO NOTHING`,
      [productId, warehouseId],
    );
    await client.query(
      `UPDATE public.merch_inventory SET quantity = quantity + 1,
         updated_at = clock_timestamp()
       WHERE product_id = $1::uuid AND warehouse_id = $2::uuid`,
      [productId, warehouseId],
    );
    const transactionId = (await client.query<{ id: string }>(
      `INSERT INTO public.merch_transactions (
        type, product_id, to_warehouse_id, quantity, notes
      ) VALUES ('receive',$1::uuid,$2::uuid,1,$3) RETURNING id`,
      [productId, warehouseId, `Stage 12 marked return ${returnCaseId}`],
    )).rows[0].id;
    const result = (await client.query<{
      process_status: string;
      stock_received: boolean;
    }>(
      `SELECT process_status, stock_received
       FROM getomerch_marking.record_seller_return_receipt(
         $1::uuid,$2::bigint,'intact',$3::uuid,$4::uuid,$5,$6::uuid
       )`,
      [returnCaseId, expectedVersion, warehouseId, transactionId,
        "stage12-db-test", randomUUID()],
    )).rows[0];
    await client.query("COMMIT");
    return { ...result, inventory_transaction_id: transactionId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function returnState(returnCaseId: string) {
  return (await pool.query<{
    version: string;
    process_status: string;
    crpt_state: string;
    unit_state: string;
    custody_state: string;
    unit_warehouse_id: string | null;
  }>(
    `SELECT return_case.version, return_case.process_status,
      code.crpt_state, unit.unit_state, unit.custody_state,
      unit.warehouse_id AS unit_warehouse_id
     FROM public.merch_marking_return_cases AS return_case
     JOIN public.merch_marking_codes AS code ON code.id = return_case.marking_code_id
     JOIN public.merch_marking_units AS unit ON unit.id = return_case.marking_unit_id
     WHERE return_case.id = $1::uuid`,
    [returnCaseId],
  )).rows[0];
}

async function ensureInventoryRow(productId: string, warehouseId: string) {
  await pool.query(
    `INSERT INTO public.merch_inventory (product_id, warehouse_id, quantity)
     VALUES ($1::uuid,$2::uuid,0)
     ON CONFLICT (product_id, warehouse_id) DO NOTHING`,
    [productId, warehouseId],
  );
}

async function inventoryQuantity(productId: string, warehouseId: string) {
  return (await pool.query<{ quantity: number }>(
    `SELECT quantity FROM public.merch_inventory
     WHERE product_id = $1::uuid AND warehouse_id = $2::uuid`,
    [productId, warehouseId],
  )).rows[0].quantity;
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

type Fixture = {
  withdrawal_document_id: string;
  fulfillment_order_id: string;
  handover_id: string;
  posting_number: string;
  assignment_id: string;
  marking_unit_id: string;
  marking_code_id: string;
  product_id: string;
  warehouse_id: string;
  offer_id: string;
  ozon_sku: string;
};

type ReturnUpsertRow = {
  return_case_id: string;
  case_version: string;
  process_status: string;
  identity_linked: boolean;
  source_return_id: string;
};
