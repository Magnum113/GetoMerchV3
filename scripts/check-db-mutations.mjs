#!/usr/bin/env node

import crypto from "node:crypto";
import pg from "pg";

const { Client } = pg;
const baseUrl = (process.env.ADMIN_BFF_BASE_URL || process.argv[2] || "http://127.0.0.1:3102").replace(/\/$/, "");
const connectionString = process.env.GETOMERCH_DATABASE_URL;
const cookieSecret = process.env.ADMIN_AUTH_COOKIE_SECRET;
const cookieName = process.env.ADMIN_AUTH_COOKIE_NAME || "getomerch_admin_session";
const expectedDatabase = process.env.EXPECTED_STAGE7_DATABASE || "";
let cachedCookie;

if (!connectionString) fail("GETOMERCH_DATABASE_URL is required", 2);
if (!cookieSecret) fail("ADMIN_AUTH_COOKIE_SECRET is required", 2);
const databaseName = new URL(connectionString).pathname.replace(/^\//, "");
if (!/^getomerch_stage(?:7|9)_[a-z0-9_]+$/.test(databaseName)) {
  fail(`Refusing mutation tests against non-disposable database ${JSON.stringify(databaseName)}`, 2);
}
if (expectedDatabase && databaseName !== expectedDatabase) {
  fail(`Database ${databaseName} does not match EXPECTED_STAGE7_DATABASE`, 2);
}

const client = new Client({ connectionString, ssl: false, application_name: "getomerch-stage7-mutation-tests" });
await client.connect();
const token = crypto.randomBytes(6).toString("hex");
const notesPrefix = `stage7-test-${token}`;

try {
  await checkRuntime();
  const fixture = await loadFixture();
  await checkReceiveIdempotency(fixture);
  await checkReceiveRollback(fixture);
  await checkConcurrentStockProtection(fixture);
  await checkTransferCommit(fixture);
  await checkProductionRollback(fixture);
  await checkProductionCommit(fixture);
  await checkWorkshopRollback(fixture);
  await checkWorkshopCommit(fixture);
  await checkOzonFbsRollback(fixture);
  await checkOzonFbsCommitAndUnship(fixture);
  await checkOzonFboIsolation(fixture);
  await checkAuditTrail();
  console.log("ok - stage 7 mutation checks passed (12 groups)");
} finally {
  await client.end();
}

async function checkRuntime() {
  const health = await requestJson("/api/admin/health", { method: "GET" });
  if (health.status !== 200) throw new Error(`Health returned ${health.status}`);
  if (health.payload?.data?.databaseReadSource !== "server" || health.payload?.data?.databaseWriteSource !== "server") {
    throw new Error("Candidate is not using server read/write sources");
  }
  console.log("ok - isolated server write runtime");
}

async function loadFixture() {
  const warehouses = await client.query(`
    SELECT id, type
    FROM merch_warehouses
    ORDER BY CASE type WHEN 'own' THEN 0 ELSE 1 END, id
  `);
  const own = warehouses.rows.find((row) => row.type === "own");
  const workshop = warehouses.rows.find((row) => row.type === "workshop");
  if (!own || !workshop) throw new Error("Expected own and workshop warehouses");

  const products = await client.query(`
    SELECT
      finished.id AS finished_id,
      blank.id AS blank_id,
      finished.design_id,
      finished.decoration_type_id,
      finished.design_version,
      finished.hoodie_fit,
      finished.hoodie_fabric,
      decoration.slug AS decoration_slug
    FROM merch_products finished
    JOIN merch_products blank
      ON blank.category_id = finished.category_id
     AND blank.fabric_id = finished.fabric_id
     AND blank.color_id = finished.color_id
     AND blank.size_id = finished.size_id
     AND blank.is_blank = true
    JOIN merch_decoration_types decoration ON decoration.id = finished.decoration_type_id
    WHERE finished.is_blank = false
      AND finished.design_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM merch_products duplicate
        WHERE duplicate.id <> finished.id
          AND duplicate.category_id = finished.category_id
          AND duplicate.fabric_id = finished.fabric_id
          AND duplicate.color_id = finished.color_id
          AND duplicate.size_id = finished.size_id
          AND duplicate.design_id = finished.design_id
          AND duplicate.decoration_type_id = finished.decoration_type_id
          AND duplicate.design_version IS NOT DISTINCT FROM finished.design_version
          AND duplicate.hoodie_fit IS NOT DISTINCT FROM finished.hoodie_fit
          AND duplicate.hoodie_fabric IS NOT DISTINCT FROM finished.hoodie_fabric
      )
    ORDER BY CASE WHEN decoration.slug = 'print' THEN 0 ELSE 1 END, finished.id
    LIMIT 1
  `);
  const product = products.rows[0];
  if (!product) throw new Error("Expected a finished product with matching blank");
  return { own, workshop, ...product };
}

async function checkReceiveIdempotency(fixture) {
  await setInventory(fixture.blank_id, fixture.own.id, 10);
  const beforeMovements = await movementCount(`${notesPrefix}-receive`);
  const key = crypto.randomUUID();
  const args = [{
    productId: fixture.blank_id,
    warehouseId: fixture.own.id,
    quantity: 3,
    notes: `${notesPrefix}-receive`,
  }];
  expectStatus(await rpc("receive", args, { key }), 200, "receive");
  expectStatus(await rpc("receive", args, { key }), 200, "receive replay");
  const quantity = await inventoryQuantity(fixture.blank_id, fixture.own.id);
  if (quantity !== 13) throw new Error(`Idempotent receive changed stock to ${quantity}, expected 13`);
  if (await movementCount(`${notesPrefix}-receive`) !== beforeMovements + 1) {
    throw new Error("Idempotent replay created a duplicate movement");
  }
  const conflictResponse = await rpc("receive", [{ ...args[0], quantity: 4 }], { key });
  expectStatus(conflictResponse, 409, "idempotency payload conflict");
  console.log("ok - idempotency and replay");
}

async function checkReceiveRollback(fixture) {
  await setInventory(fixture.blank_id, fixture.own.id, 20);
  const beforeMovements = await movementCount(`${notesPrefix}-receive-fault`);
  const response = await rpc("receive", [{
    productId: fixture.blank_id,
    warehouseId: fixture.own.id,
    quantity: 5,
    notes: `${notesPrefix}-receive-fault`,
  }], { fault: "after_inventory" });
  expectStatus(response, 500, "receive fault");
  if (await inventoryQuantity(fixture.blank_id, fixture.own.id) !== 20) {
    throw new Error("Receive fault left a partial stock update");
  }
  if (await movementCount(`${notesPrefix}-receive-fault`) !== beforeMovements) {
    throw new Error("Receive fault left a movement");
  }
  console.log("ok - receive rollback");
}

async function checkConcurrentStockProtection(fixture) {
  await setInventory(fixture.blank_id, fixture.own.id, 4);
  const payload = {
    productId: fixture.blank_id,
    warehouseId: fixture.own.id,
    quantity: 3,
    notes: `${notesPrefix}-concurrent-sale`,
  };
  const responses = await Promise.all([
    rpc("sale", [payload]),
    rpc("sale", [payload]),
  ]);
  const statuses = responses.map((response) => response.status).sort();
  if (statuses[0] !== 200 || statuses[1] !== 409) {
    throw new Error(`Concurrent sales returned ${statuses.join(",")}, expected 200,409`);
  }
  if (await inventoryQuantity(fixture.blank_id, fixture.own.id) !== 1) {
    throw new Error("Concurrent sales produced an invalid final stock");
  }
  console.log("ok - concurrent row lock and nonnegative stock");
}

async function checkTransferCommit(fixture) {
  await setInventory(fixture.blank_id, fixture.own.id, 6);
  await setInventory(fixture.blank_id, fixture.workshop.id, 1);
  const beforeMovements = await movementCount(`${notesPrefix}-transfer`);
  const response = await rpc("transfer", [{
    productId: fixture.blank_id,
    fromWarehouseId: fixture.own.id,
    toWarehouseId: fixture.workshop.id,
    quantity: 2,
    notes: `${notesPrefix}-transfer`,
  }]);
  expectStatus(response, 200, "transfer commit");
  const own = await inventoryQuantity(fixture.blank_id, fixture.own.id);
  const workshop = await inventoryQuantity(fixture.blank_id, fixture.workshop.id);
  if (own !== 4 || workshop !== 3) {
    throw new Error(`Transfer committed invalid stock own=${own} workshop=${workshop}`);
  }
  if (await movementCount(`${notesPrefix}-transfer`) !== beforeMovements + 1) {
    throw new Error("Transfer did not create exactly one movement");
  }
  console.log("ok - transfer commit and movement");
}

async function checkProductionRollback(fixture) {
  await setInventory(fixture.blank_id, fixture.own.id, 8);
  await setInventory(fixture.finished_id, fixture.own.id, 2);
  if (fixture.decoration_slug === "print") await setPrintInventory(fixture.design_id, fixture.own.id, 8);
  const before = await productionState(fixture);
  const response = await rpc("produce", [{
    blankProductId: fixture.blank_id,
    finishedProductId: fixture.finished_id,
    warehouseId: fixture.own.id,
    quantity: 2,
    notes: `${notesPrefix}-production-fault`,
  }], { fault: "after_product_inventory" });
  expectStatus(response, 500, "production fault");
  const after = await productionState(fixture);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error(`Production fault left partial state: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
  console.log("ok - production rollback across blank/finished/print");
}

async function checkProductionCommit(fixture) {
  await setInventory(fixture.blank_id, fixture.own.id, 5);
  await setInventory(fixture.finished_id, fixture.own.id, 1);
  if (fixture.decoration_slug === "print") await setPrintInventory(fixture.design_id, fixture.own.id, 5);
  const response = await rpc("produce", [{
    blankProductId: fixture.blank_id,
    finishedProductId: fixture.finished_id,
    warehouseId: fixture.own.id,
    quantity: 2,
    notes: `${notesPrefix}-production-commit`,
  }]);
  expectStatus(response, 200, "production commit");
  const state = await productionState(fixture, `${notesPrefix}-production-commit`);
  const expectedPrint = fixture.decoration_slug === "print" ? 3 : null;
  if (state.blank !== 3 || state.finished !== 3 || state.print !== expectedPrint || state.movementCount !== 1) {
    throw new Error(`Production committed invalid state: ${JSON.stringify(state)}`);
  }
  console.log("ok - production commit across blank/finished/print");
}

async function checkWorkshopRollback(fixture) {
  const before = Number((await client.query("SELECT count(*)::int AS count FROM merch_workshop_orders")).rows[0].count);
  const response = await rpc("createWorkshopOrder", [{
    workshopId: fixture.workshop.id,
    ownWarehouseId: fixture.own.id,
    notes: `${notesPrefix}-workshop-fault`,
    items: [{
      blankProductId: fixture.blank_id,
      designId: fixture.design_id,
      decorationTypeId: fixture.decoration_type_id,
      quantity: 1,
    }],
  }], { fault: "after_order" });
  expectStatus(response, 500, "workshop fault");
  const after = Number((await client.query("SELECT count(*)::int AS count FROM merch_workshop_orders")).rows[0].count);
  if (after !== before) throw new Error("Workshop fault left a partial order");
  console.log("ok - workshop order rollback");
}

async function checkWorkshopCommit(fixture) {
  await setInventory(fixture.blank_id, fixture.own.id, 5);
  await setInventory(fixture.blank_id, fixture.workshop.id, 0);
  await setInventory(fixture.finished_id, fixture.workshop.id, 0);
  if (fixture.decoration_slug === "print") await setPrintInventory(fixture.design_id, fixture.workshop.id, 2);
  const created = await rpc("createWorkshopOrder", [{
    workshopId: fixture.workshop.id,
    ownWarehouseId: fixture.own.id,
    notes: `${notesPrefix}-workshop-commit`,
    items: [{
      blankProductId: fixture.blank_id,
      designId: fixture.design_id,
      decorationTypeId: fixture.decoration_type_id,
      quantity: 2,
      designVersion: fixture.design_version,
      hoodieFit: fixture.hoodie_fit,
      hoodieFabric: fixture.hoodie_fabric,
    }],
  }]);
  expectStatus(created, 200, "workshop create commit");
  const orderId = created.payload?.data;
  if (typeof orderId !== "string") throw new Error("Workshop create did not return an order id");
  if (await inventoryQuantity(fixture.blank_id, fixture.own.id) !== 3 ||
      await inventoryQuantity(fixture.blank_id, fixture.workshop.id) !== 2) {
    throw new Error("Workshop create did not transfer the required blanks");
  }
  const received = await rpc("updateWorkshopOrderStatus", [
    orderId,
    "received",
    { ownWarehouseId: fixture.own.id },
  ]);
  expectStatus(received, 200, "workshop receive commit");
  const state = await client.query(`
    SELECT order_row.status, item.result_product_id
    FROM merch_workshop_orders order_row
    JOIN merch_workshop_order_items item ON item.order_id = order_row.id
    WHERE order_row.id = $1
  `, [orderId]);
  if (state.rows[0]?.status !== "received" || state.rows[0]?.result_product_id !== fixture.finished_id) {
    throw new Error(`Workshop receive state is invalid: ${JSON.stringify(state.rows[0])}`);
  }
  if (await inventoryQuantity(fixture.blank_id, fixture.workshop.id) !== 0 ||
      await inventoryQuantity(fixture.finished_id, fixture.workshop.id) !== 2) {
    throw new Error("Workshop receive did not atomically produce finished goods");
  }
  console.log("ok - workshop create/receive commit");
}

async function checkOzonFbsRollback(fixture) {
  const order = await createTestOrder("fbs", fixture.finished_id, 2);
  await setInventory(fixture.finished_id, fixture.own.id, 5);
  await setInventory(fixture.finished_id, fixture.workshop.id, 0);
  const beforeMovements = await movementCount(`Ozon ${order.postingNumber}`);
  const response = await rpc("shipOzonOrder", [order.id, fixture.own.id], { fault: "after_inventory" });
  expectStatus(response, 500, "Ozon FBS ship fault");
  if (await inventoryQuantity(fixture.finished_id, fixture.own.id) !== 5) {
    throw new Error("Ozon FBS fault left a partial stock decrement");
  }
  const shipped = await client.query("SELECT shipped_at FROM merch_ozon_orders WHERE id = $1", [order.id]);
  if (shipped.rows[0].shipped_at !== null) throw new Error("Ozon FBS fault marked the order shipped");
  if (await movementCount(`Ozon ${order.postingNumber}`) !== beforeMovements) {
    throw new Error("Ozon FBS fault left a sale movement");
  }
  console.log("ok - Ozon FBS shipment rollback");
}

async function checkOzonFbsCommitAndUnship(fixture) {
  const order = await createTestOrder("fbs", fixture.finished_id, 2);
  await setInventory(fixture.finished_id, fixture.own.id, 5);
  await setInventory(fixture.finished_id, fixture.workshop.id, 0);
  const key = crypto.randomUUID();
  const shipped = await rpc("shipOzonOrder", [order.id, fixture.own.id], { key });
  expectStatus(shipped, 200, "Ozon FBS ship commit");
  expectStatus(await rpc("shipOzonOrder", [order.id, fixture.own.id], { key }), 200, "Ozon FBS ship replay");
  if (await inventoryQuantity(fixture.finished_id, fixture.own.id) !== 3) {
    throw new Error("Ozon FBS ship replay decremented stock more than once");
  }
  const shippedState = await client.query(`
    SELECT order_row.shipped_at, order_row.shipped_from_warehouse_id, item.shipped_from_warehouse_id AS item_warehouse_id
    FROM merch_ozon_orders order_row
    JOIN merch_ozon_order_items item ON item.order_id = order_row.id
    WHERE order_row.id = $1
  `, [order.id]);
  if (!shippedState.rows[0]?.shipped_at || shippedState.rows[0]?.item_warehouse_id !== fixture.own.id) {
    throw new Error(`Ozon FBS shipment state is invalid: ${JSON.stringify(shippedState.rows[0])}`);
  }
  expectStatus(await rpc("unshipOzonOrder", [order.id]), 200, "Ozon FBS unship commit");
  if (await inventoryQuantity(fixture.finished_id, fixture.own.id) !== 5) {
    throw new Error("Ozon FBS unship did not restore stock");
  }
  const unshippedState = await client.query(`
    SELECT order_row.shipped_at, item.shipped_from_warehouse_id AS item_warehouse_id
    FROM merch_ozon_orders order_row
    JOIN merch_ozon_order_items item ON item.order_id = order_row.id
    WHERE order_row.id = $1
  `, [order.id]);
  if (unshippedState.rows[0]?.shipped_at !== null || unshippedState.rows[0]?.item_warehouse_id !== null) {
    throw new Error("Ozon FBS unship did not clear shipment fields");
  }
  console.log("ok - Ozon FBS ship replay and unship commit");
}

async function checkOzonFboIsolation(fixture) {
  const order = await createTestOrder("fbo", fixture.finished_id, 1);
  const before = await inventoryQuantity(fixture.finished_id, fixture.own.id);
  const response = await rpc("shipOzonOrder", [order.id, fixture.own.id]);
  expectStatus(response, 409, "Ozon FBO guard");
  if (await inventoryQuantity(fixture.finished_id, fixture.own.id) !== before) {
    throw new Error("Ozon FBO changed internal inventory");
  }
  const state = await client.query(
    "SELECT shipped_at, workshop_order_id FROM merch_ozon_orders WHERE id = $1",
    [order.id],
  );
  if (state.rows[0].shipped_at !== null || state.rows[0].workshop_order_id !== null) {
    throw new Error("Ozon FBO entered an internal fulfillment state");
  }
  console.log("ok - Ozon FBO inventory isolation");
}

async function checkAuditTrail() {
  const audit = await client.query(`
    SELECT
      count(*) FILTER (WHERE result = 'succeeded')::int AS succeeded,
      count(*) FILTER (WHERE result = 'failed')::int AS failed,
      count(*) FILTER (WHERE actor = 'owner' AND session_id <> '')::int AS attributed
    FROM getomerch_audit.audit_log
    WHERE created_at >= clock_timestamp() - interval '15 minutes'
  `);
  const row = audit.rows[0];
  if (row.succeeded < 2 || row.failed < 4 || row.attributed < row.succeeded + row.failed) {
    throw new Error(`Audit trail is incomplete: ${JSON.stringify(row)}`);
  }
  console.log("ok - attributed success/failure audit");
}

async function createTestOrder(source, productId, quantity) {
  const postingNumber = `STAGE7-${source.toUpperCase()}-${token}-${crypto.randomBytes(3).toString("hex")}`;
  const order = await client.query(`
    INSERT INTO merch_ozon_orders (posting_number, status, source, synced_at)
    VALUES ($1, 'awaiting_packaging', $2, clock_timestamp())
    RETURNING id
  `, [postingNumber, source]);
  await client.query(`
    INSERT INTO merch_ozon_order_items (order_id, offer_id, quantity, product_id)
    VALUES ($1, $2, $3, $4)
  `, [order.rows[0].id, `${notesPrefix}-${source}`, quantity, productId]);
  return { id: order.rows[0].id, postingNumber };
}

async function setInventory(productId, warehouseId, quantity) {
  await client.query(`
    INSERT INTO merch_inventory (product_id, warehouse_id, quantity)
    VALUES ($1, $2, $3)
    ON CONFLICT (product_id, warehouse_id) DO UPDATE SET quantity = EXCLUDED.quantity
  `, [productId, warehouseId, quantity]);
}

async function setPrintInventory(designId, warehouseId, quantity) {
  await client.query(`
    INSERT INTO merch_print_inventory (design_id, warehouse_id, quantity)
    VALUES ($1, $2, $3)
    ON CONFLICT (design_id, warehouse_id) DO UPDATE SET quantity = EXCLUDED.quantity
  `, [designId, warehouseId, quantity]);
}

async function inventoryQuantity(productId, warehouseId) {
  const result = await client.query(
    "SELECT quantity FROM merch_inventory WHERE product_id = $1 AND warehouse_id = $2",
    [productId, warehouseId],
  );
  return result.rows[0]?.quantity ?? 0;
}

async function productionState(fixture, notes = `${notesPrefix}-production-fault`) {
  return {
    blank: await inventoryQuantity(fixture.blank_id, fixture.own.id),
    finished: await inventoryQuantity(fixture.finished_id, fixture.own.id),
    print: fixture.decoration_slug === "print"
      ? Number((await client.query(
          "SELECT quantity FROM merch_print_inventory WHERE design_id = $1 AND warehouse_id = $2",
          [fixture.design_id, fixture.own.id],
        )).rows[0]?.quantity ?? 0)
      : null,
    movementCount: await movementCount(notes),
  };
}

async function movementCount(notes) {
  const result = await client.query(
    "SELECT count(*)::int AS count FROM merch_transactions WHERE notes = $1",
    [notes],
  );
  return Number(result.rows[0].count);
}

async function rpc(action, args, options = {}) {
  return requestJson("/api/admin/rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": options.key || crypto.randomUUID(),
      "X-Request-Id": crypto.randomUUID(),
      ...(options.fault ? { "X-Getomerch-Fault-After": options.fault } : {}),
    },
    body: JSON.stringify({ action, args }),
  });
}

async function requestJson(path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Cookie: authCookie() },
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* asserted by callers */ }
  return { status: response.status, payload, text };
}

function expectStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${response.status}: ${response.text.slice(0, 400)}`);
  }
}

function authCookie() {
  if (cachedCookie) return cachedCookie;
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ sub: "owner", iat: now, exp: now + 3600 }), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", cookieSecret).update(body).digest("base64url");
  cachedCookie = `${cookieName}=${body}.${signature}`;
  return cachedCookie;
}

function fail(message, code) {
  console.error(message);
  process.exit(code);
}
