#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

const connectionString = process.env.GETOMERCH_DATABASE_URL?.trim();
if (!connectionString) throw new Error("GETOMERCH_DATABASE_URL is required");

const pool = new Pool({
  connectionString,
  max: 30,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 40_000,
  ssl: useSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
});

let fixtureIndex = 0;

main().catch((error) => {
  console.error("Stage 6 PostgreSQL checks failed", error);
  process.exitCode = 1;
}).finally(() => pool.end());

async function main() {
  const database = (await pool.query<{ name: string }>(
    "select current_database() as name",
  )).rows[0]?.name;
  if (!database || !/^getomerch_stage(?:6|7|8|10|11|12)_[a-z0-9_]+$/.test(database)) {
    throw new Error(`Refusing Stage 6 DB tests against database: ${database ?? "unknown"}`);
  }

  await testParallelReservations();
  await testQuantityAndCancellation();
  await testRenderedCancellation();
  await testAtomicApplicationAndRollback();
  await testAclAndSafeViews();
  console.log("Stage 6 PostgreSQL concurrency, cancellation and atomicity checks passed");
}

async function testParallelReservations() {
  const fixture = await createFixture(20, 20);
  const results = await Promise.all(
    Array.from({ length: 20 }, () => prepare(fixture.itemId, fixture.warehouseId)),
  );
  assert.equal(new Set(results.map((row) => row.assignment_id)).size, 20);
  assert.equal(new Set(results.map((row) => row.marking_unit_id)).size, 20);
  assert.equal(new Set(results.map((row) => row.code_binding_id)).size, 20);
  assert.deepEqual(
    results.map((row) => Number(row.unit_ordinal)).sort((a, b) => a - b),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
  const count = await pool.query<{
    assignments: string;
    units: string;
    codes: string;
  }>(
    `
      SELECT
        count(*)::text AS assignments,
        count(DISTINCT assignment.marking_unit_id)::text AS units,
        count(DISTINCT binding.marking_code_id)::text AS codes
      FROM public.merch_marking_assignments assignment
      JOIN public.merch_marking_code_bindings binding
        ON binding.id = assignment.code_binding_id
      WHERE assignment.fulfillment_item_id = $1::uuid
        AND assignment.status = 'active'
    `,
    [fixture.itemId],
  );
  assert.deepEqual(count.rows[0], {
    assignments: "20",
    units: "20",
    codes: "20",
  });
}

async function testQuantityAndCancellation() {
  const fixture = await createFixture(3, 4);
  const first = await prepare(fixture.itemId, fixture.warehouseId);
  await prepare(fixture.itemId, fixture.warehouseId);
  await prepare(fixture.itemId, fixture.warehouseId);
  await assert.rejects(
    prepare(fixture.itemId, fixture.warehouseId),
    (error) => pgCode(error) === "MZ606",
  );

  const before = await inventorySnapshot(fixture);
  const cancelled = await asApp<{
    assignment_status: string;
    code_pool_state: string;
  }>(
    `
      SELECT assignment_status, code_pool_state
      FROM getomerch_marking.cancel_jit_assignment($1::uuid, 1, $2, $3)
    `,
    [first.assignment_id, "Тестовая отмена до печати", "stage6-db-test"],
  );
  assert.equal(cancelled.rows[0].assignment_status, "cancelled");
  assert.equal(cancelled.rows[0].code_pool_state, "available");
  assert.deepEqual(await inventorySnapshot(fixture), before);

  const replacement = await prepare(fixture.itemId, fixture.warehouseId);
  assert.equal(Number(replacement.unit_ordinal), 1);
  await pool.query(
    "UPDATE public.merch_fulfillment_order_items SET quantity = 1 WHERE id = $1::uuid",
    [fixture.itemId],
  );
  const states = await pool.query<{ unit_ordinal: number; status: string }>(
    `
      SELECT unit_ordinal, status
      FROM public.merch_marking_assignments
      WHERE fulfillment_item_id = $1::uuid
      ORDER BY created_at, id
    `,
    [fixture.itemId],
  );
  assert.equal(
    states.rows.filter((row) => row.status === "active").length,
    1,
  );
  assert.ok(
    states.rows.filter((row) => row.unit_ordinal > 1)
      .every((row) => row.status === "released"),
  );
}

async function testRenderedCancellation() {
  const fixture = await createFixture(2, 2);
  await prepare(fixture.itemId, fixture.warehouseId);
  const rendered = await prepare(fixture.itemId, fixture.warehouseId);
  await markRendered(rendered.code_binding_id);
  const before = await inventorySnapshot(fixture);
  await pool.query(
    "UPDATE public.merch_fulfillment_order_items SET quantity = 1 WHERE id = $1::uuid",
    [fixture.itemId],
  );
  const state = await assignmentState(rendered.assignment_id);
  assert.equal(state.assignment_status, "quarantined");
  assert.equal(state.unit_state, "quarantined");
  assert.equal(state.pool_state, "quarantined");
  assert.deepEqual(await inventorySnapshot(fixture), before);
}

async function testAtomicApplicationAndRollback() {
  const rollbackFixture = await createFixture(1, 1);
  const rollbackAssignment = await prepare(
    rollbackFixture.itemId,
    rollbackFixture.warehouseId,
  );
  await markRendered(rollbackAssignment.code_binding_id);
  const rollbackBefore = await inventorySnapshot(rollbackFixture);
  await applyInTransaction(rollbackAssignment.assignment_id, true);
  assert.deepEqual(await inventorySnapshot(rollbackFixture), rollbackBefore);
  assert.equal(await applicationJobCount(rollbackAssignment.assignment_id), 0);
  const rollbackState = await assignmentState(rollbackAssignment.assignment_id);
  assert.equal(rollbackState.assignment_status, "active");
  assert.equal(rollbackState.unit_state, "preparing");
  assert.equal(rollbackState.binding_status, "planned");
  assert.equal(rollbackState.pool_state, "reserved");

  const fixture = await createFixture(1, 1);
  const assignment = await prepare(fixture.itemId, fixture.warehouseId);
  await markRendered(assignment.code_binding_id);
  const before = await inventorySnapshot(fixture);
  await applyInTransaction(assignment.assignment_id, false);
  const after = await inventorySnapshot(fixture);
  assert.equal(after.blank, before.blank - 1);
  assert.equal(after.finished, before.finished + 1);
  assert.equal(after.print, before.print - 1);
  const applied = await assignmentState(assignment.assignment_id);
  assert.equal(applied.assignment_status, "active");
  assert.equal(applied.unit_state, "marking_pending");
  assert.equal(applied.binding_status, "active");
  assert.equal(applied.label_state, "applied");
  assert.equal(applied.pool_state, "bound");
  assert.equal(await applicationJobCount(assignment.assignment_id), 1);
  await assert.rejects(
    asApp(
      "SELECT * FROM getomerch_marking.cancel_jit_assignment($1::uuid, 2, $2, $3)",
      [assignment.assignment_id, "Нельзя отвязать нанесенный КМ", "stage6-db-test"],
    ),
    (error) => pgCode(error) === "MZ617",
  );
}

async function testAclAndSafeViews() {
  await assert.rejects(
    asApp("SELECT id FROM public.merch_marking_assignments LIMIT 1"),
    (error) => pgCode(error) === "42501",
  );
  await assert.rejects(
    asApp(
      `
        INSERT INTO public.merch_marking_units (
          product_profile_id,
          product_id_snapshot,
          internal_serial,
          origin_type
        )
        VALUES (gen_random_uuid(), gen_random_uuid(), 'UNSAFE-UNIT', 'own_production')
      `,
    ),
    (error) => pgCode(error) === "42501",
  );
  const safe = await asApp<Record<string, unknown>>(
    "SELECT * FROM getomerch_marking.assignment_safe LIMIT 1",
  );
  assert.equal(safe.rowCount, 1);
  for (const forbidden of [
    "code_ciphertext",
    "code_nonce",
    "code_auth_tag",
    "code_hmac",
    "serial",
  ]) {
    assert.equal(forbidden in safe.rows[0], false);
  }
}

async function createFixture(quantity: number, codeCount: number) {
  fixtureIndex += 1;
  const suffix = `${fixtureIndex}-${randomUUID().slice(0, 7)}`;
  const gtin = makeGtin(`04628837737${String(fixtureIndex).padStart(2, "0")}`);
  const offer = `STAGE6-${suffix}-S`;
  const refs = (
    await pool.query<{
      category_id: string;
      fabric_id: string;
      color_id: string;
      size_id: string;
      design_id: string;
      decoration_id: string;
      warehouse_id: string;
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
          VALUES ($5)
          RETURNING id
        ),
        size AS (
          INSERT INTO public.merch_sizes (name)
          VALUES ($6)
          RETURNING id
        ),
        design AS (
          INSERT INTO public.merch_designs (name, type)
          VALUES ($7, 'print')
          RETURNING id
        ),
        decoration AS (
          INSERT INTO public.merch_decoration_types (name, slug, made_at)
          VALUES ($8, $9, 'own')
          RETURNING id
        ),
        warehouse AS (
          INSERT INTO public.merch_warehouses (name, type)
          VALUES ($10, 'own')
          RETURNING id
        )
        SELECT
          category.id AS category_id,
          fabric.id AS fabric_id,
          color.id AS color_id,
          size.id AS size_id,
          design.id AS design_id,
          decoration.id AS decoration_id,
          warehouse.id AS warehouse_id
        FROM category, fabric, color, size, design, decoration, warehouse
      `,
      [
        `Stage6 T-Shirt ${suffix}`,
        `stage6-tshirt-${suffix}`,
        `Stage6 Cotton ${suffix}`,
        `stage6-cotton-${suffix}`,
        `Белый ${suffix}`,
        `S-${suffix}`,
        `Stage6 Design ${suffix}`,
        `Stage6 Print ${suffix}`,
        `stage6-print-${suffix}`,
        `Stage6 Own ${suffix}`,
      ],
    )
  ).rows[0];

  const products = await pool.query<{ id: string; is_blank: boolean }>(
    `
      INSERT INTO public.merch_products (
        category_id,
        fabric_id,
        color_id,
        size_id,
        design_id,
        decoration_type_id,
        sku,
        is_blank,
        ozon_sku
      )
      VALUES
        ($1, $2, $3, $4, NULL, NULL, $5, true, NULL),
        ($1, $2, $3, $4, $6, $7, $8, false, $9)
      RETURNING id, is_blank
    `,
    [
      refs.category_id,
      refs.fabric_id,
      refs.color_id,
      refs.size_id,
      `BLANK-${suffix}`,
      refs.design_id,
      refs.decoration_id,
      offer,
      6_000_000_000 + fixtureIndex,
    ],
  );
  const blankId = products.rows.find((row) => row.is_blank)!.id;
  const productId = products.rows.find((row) => !row.is_blank)!.id;
  await pool.query(
    `
      INSERT INTO public.merch_inventory (product_id, warehouse_id, quantity)
      VALUES ($1, $3, 100), ($2, $3, 0)
    `,
    [blankId, productId, refs.warehouse_id],
  );
  await pool.query(
    `
      INSERT INTO public.merch_print_inventory (design_id, warehouse_id, quantity)
      VALUES ($1, $2, 100)
    `,
    [refs.design_id, refs.warehouse_id],
  );

  const tradeItemId = (
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
          $1, 'clothes', '6109100000', $2, 'published', 'verified',
          'stage6_test', repeat('a', 64), clock_timestamp(), 'stage6-db-test',
          'Футболка', $3, $4, $5
        )
        RETURNING id
      `,
      [
        gtin,
        `STAGE6-CARD-${suffix}`,
        `Stage6 Cotton ${suffix}`,
        `Белый ${suffix}`,
        `S-${suffix}`,
      ],
    )
  ).rows[0].id;
  const profileId = (
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
          $1, $2, true, 'own_production', 'jit_after_order', 'draft',
          'required', 'stage6_test', clock_timestamp(), 'draft'
        )
        RETURNING id
      `,
      [productId, tradeItemId],
    )
  ).rows[0].id;
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
        $1, 'product_profile_mapping', 'stage6_test', clock_timestamp(),
        repeat('b', 64), 'verified', 'stage6-db-test', clock_timestamp()
      )
    `,
    [profileId],
  );
  await pool.query(
    `
      UPDATE public.merch_marking_product_profiles
      SET
        verification_status = 'verified',
        verification_source = 'stage6_test',
        source_snapshot_hash = repeat('c', 64),
        verified_at = clock_timestamp(),
        verified_by = 'stage6-db-test',
        operational_status = 'enabled',
        operational_changed_at = clock_timestamp(),
        operational_changed_by = 'stage6-db-test',
        revision = revision + 1,
        updated_at = clock_timestamp()
      WHERE id = $1
    `,
    [profileId],
  );
  await pool.query(
    `
      INSERT INTO public.merch_marking_product_profile_channels (
        product_profile_id,
        channel,
        offer_id,
        external_sku,
        marking_requirement,
        requirement_source,
        observed_at
      )
      VALUES ($1, 'ozon_fbs', $2, $2, 'required', 'stage6_test', clock_timestamp())
    `,
    [profileId, offer],
  );
  const orderId = (
    await pool.query<{ id: string }>(
      `
        INSERT INTO public.merch_fulfillment_orders (
          source_channel,
          fulfillment_scheme,
          source_order_key,
          external_posting_number,
          source_status,
          source_updated_at
        )
        VALUES ('ozon_fbs', 'fbs', $1, $1, 'awaiting_packaging', clock_timestamp())
        RETURNING id
      `,
      [`STAGE6-POSTING-${suffix}`],
    )
  ).rows[0].id;
  const itemId = (
    await pool.query<{ id: string }>(
      `
        INSERT INTO public.merch_fulfillment_order_items (
          fulfillment_order_id,
          source_item_key,
          product_id,
          offer_id,
          quantity,
          marking_requirement,
          exemplar_flow_available,
          source_active
        )
        VALUES ($1, $2, $3, $4, $5, 'required', true, true)
        RETURNING id
      `,
      [orderId, `item:${suffix}`, productId, offer, quantity],
    )
  ).rows[0].id;

  for (let index = 0; index < codeCount; index += 1) {
    const hmac = randomBytes(32);
    const codeId = (
      await pool.query<{ id: string }>(
        `
          INSERT INTO public.merch_marking_codes (
            trade_item_id,
            gtin_snapshot,
            code_ciphertext,
            code_nonce,
            code_auth_tag,
            encryption_key_version,
            code_hmac,
            hmac_key_version,
            fingerprint,
            serial,
            acquisition_mode,
            code_order_item_id,
            pool_state,
            crpt_state
          )
          VALUES (
            $1, $2, $3, $4, $5, 1, $6, 1, $7, $8,
            'own_suz_emission', $9, 'available', 'emitted'
          )
          RETURNING id
        `,
        [
          tradeItemId,
          gtin,
          randomBytes(32),
          randomBytes(12),
          randomBytes(16),
          hmac,
          randomBytes(6).toString("hex"),
          `S6${fixtureIndex}${String(index).padStart(4, "0")}`,
          randomUUID(),
        ],
      )
    ).rows[0].id;
    await pool.query(
      `
        INSERT INTO public.merch_marking_code_hmacs (
          marking_code_id,
          hmac_key_version,
          code_hmac
        )
        VALUES ($1, 1, $2)
      `,
      [codeId, hmac],
    );
  }
  return {
    itemId,
    orderId,
    warehouseId: refs.warehouse_id,
    blankId,
    productId,
    designId: refs.design_id,
  };
}

async function prepare(itemId: string, warehouseId: string) {
  const result = await asApp<{
    assignment_id: string;
    marking_unit_id: string;
    code_binding_id: string;
    unit_ordinal: number;
  }>(
    `
      SELECT assignment_id, marking_unit_id, code_binding_id, unit_ordinal
      FROM getomerch_marking.prepare_jit_assignment($1, $2, $3)
    `,
    [itemId, warehouseId, "stage6-db-test"],
  );
  return result.rows[0];
}

async function markRendered(bindingId: string) {
  await pool.query(
    `
      UPDATE public.merch_marking_code_bindings
      SET
        label_state = 'label_rendered',
        template_version = 'stage6-test-v1',
        render_count = 1,
        first_rendered_at = clock_timestamp(),
        last_rendered_at = clock_timestamp(),
        updated_at = clock_timestamp()
      WHERE id = $1::uuid
    `,
    [bindingId],
  );
}

async function applyInTransaction(assignmentId: string, rollback: boolean) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE getomerch_app");
    const locked = (
      await client.query<{
        blank_product_id: string;
        finished_product_id: string;
        warehouse_id: string;
        marking_unit_id: string;
        code_binding_id: string;
        gtin: string;
      }>(
        `
          SELECT
            blank_product_id,
            finished_product_id,
            warehouse_id,
            marking_unit_id,
            code_binding_id,
            gtin
          FROM getomerch_marking.lock_jit_assignment_for_apply($1, 1, $2)
        `,
        [assignmentId, "stage6-db-test"],
      )
    ).rows[0];
    await client.query("RESET ROLE");
    await client.query(
      `
        UPDATE public.merch_inventory
        SET quantity = quantity - 1
        WHERE product_id = $1 AND warehouse_id = $2
      `,
      [locked.blank_product_id, locked.warehouse_id],
    );
    await client.query(
      `
        UPDATE public.merch_inventory
        SET quantity = quantity + 1
        WHERE product_id = $1 AND warehouse_id = $2
      `,
      [locked.finished_product_id, locked.warehouse_id],
    );
    await client.query(
      `
        UPDATE public.merch_print_inventory AS inventory
        SET quantity = inventory.quantity - 1
        FROM public.merch_products AS product
        WHERE product.id = $1
          AND inventory.design_id = product.design_id
          AND inventory.warehouse_id = $2
      `,
      [locked.finished_product_id, locked.warehouse_id],
    );
    const movementId = (
      await client.query<{ id: string }>(
        `
          INSERT INTO public.merch_transactions (
            type,
            product_id,
            source_product_id,
            to_warehouse_id,
            quantity,
            notes
          )
          VALUES ('production', $1, $2, $3, 1, 'stage6 atomicity test')
          RETURNING id
        `,
        [
          locked.finished_product_id,
          locked.blank_product_id,
          locked.warehouse_id,
        ],
      )
    ).rows[0].id;
    await client.query("SET LOCAL ROLE getomerch_app");
    await client.query(
      `
        SELECT *
        FROM getomerch_marking.complete_jit_application($1, 1, $2, $3)
      `,
      [assignmentId, movementId, "stage6-db-test"],
    );
    const jobId = (
      await client.query<{ id: string }>(
        `
          INSERT INTO getomerch_jobs.jobs (
            type,
            dedupe_key,
            idempotency_key,
            request_hash,
            payload,
            actor,
            request_id,
            max_attempts
          )
          VALUES (
            'marking_crpt_application_submit',
            $1,
            $2,
            repeat('d', 64),
            jsonb_build_object(
              'assignmentId', $3::text,
              'markingUnitId', $4::text,
              'codeBindingId', $5::text,
              'gtin', $6::text
            ),
            'stage6-db-test',
            $7::uuid,
            5
          )
          RETURNING id
        `,
        [
          `assignment:${assignmentId}`,
          `marking-crpt-application:${assignmentId}`,
          assignmentId,
          locked.marking_unit_id,
          locked.code_binding_id,
          locked.gtin,
          randomUUID(),
        ],
      )
    ).rows[0].id;
    await client.query(
      `
        INSERT INTO getomerch_jobs.job_events (job_id, level, event, details)
        VALUES (
          $1::uuid,
          'info',
          'queued',
          jsonb_build_object(
            'type',
            'marking_crpt_application_submit',
            'assignmentId',
            $2::text
          )
        )
      `,
      [jobId, assignmentId],
    );
    await client.query(rollback ? "ROLLBACK" : "COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function applicationJobCount(assignmentId: string) {
  return Number((
    await pool.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM getomerch_jobs.jobs
        WHERE type = 'marking_crpt_application_submit'
          AND dedupe_key = $1
      `,
      [`assignment:${assignmentId}`],
    )
  ).rows[0].count);
}

async function assignmentState(assignmentId: string) {
  return (
    await pool.query<{
      assignment_status: string;
      unit_state: string;
      binding_status: string;
      label_state: string;
      pool_state: string;
    }>(
      `
        SELECT
          assignment.status AS assignment_status,
          unit.unit_state,
          binding.status AS binding_status,
          binding.label_state,
          code.pool_state
        FROM public.merch_marking_assignments assignment
        JOIN public.merch_marking_units unit
          ON unit.id = assignment.marking_unit_id
        JOIN public.merch_marking_code_bindings binding
          ON binding.id = assignment.code_binding_id
        JOIN public.merch_marking_codes code
          ON code.id = binding.marking_code_id
        WHERE assignment.id = $1::uuid
      `,
      [assignmentId],
    )
  ).rows[0];
}

async function inventorySnapshot(fixture: {
  blankId: string;
  productId: string;
  warehouseId: string;
  designId: string;
}) {
  const products = await pool.query<{ product_id: string; quantity: number }>(
    `
      SELECT product_id, quantity
      FROM public.merch_inventory
      WHERE warehouse_id = $1
        AND product_id = ANY ($2::uuid[])
    `,
    [fixture.warehouseId, [fixture.blankId, fixture.productId]],
  );
  const print = (
    await pool.query<{ quantity: number }>(
      `
        SELECT quantity
        FROM public.merch_print_inventory
        WHERE warehouse_id = $1 AND design_id = $2
      `,
      [fixture.warehouseId, fixture.designId],
    )
  ).rows[0].quantity;
  return {
    blank: products.rows.find((row) => row.product_id === fixture.blankId)!.quantity,
    finished: products.rows.find((row) => row.product_id === fixture.productId)!.quantity,
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

function makeGtin(first13: string) {
  assert.equal(first13.length, 13);
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
    current = current instanceof Error ? current.cause : undefined;
  }
  return "";
}

function useSsl(value: string) {
  const hostname = new URL(value).hostname;
  return hostname !== "" && hostname !== "localhost" && hostname !== "127.0.0.1";
}
