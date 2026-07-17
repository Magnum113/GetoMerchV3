#!/usr/bin/env node

import crypto from "node:crypto";

const baseUrl = (process.env.ADMIN_BFF_BASE_URL || process.argv[2] || "http://127.0.0.1:3101").replace(/\/$/, "");
const cookieSecret = process.env.ADMIN_AUTH_COOKIE_SECRET;
const cookieName = process.env.ADMIN_AUTH_COOKIE_NAME || "getomerch_admin_session";
const sessionDays = Number(process.env.ADMIN_AUTH_SESSION_DAYS || "60");
const expectedSource = process.env.EXPECTED_DB_READ_SOURCE || "server";
const perfSamples = positiveInteger(process.env.DB_REPOSITORY_PERF_SAMPLES, 5);
const ordinaryLimitMs = positiveInteger(process.env.DB_REPOSITORY_P95_MS, 1000);
const heavyLimitMs = positiveInteger(process.env.DB_REPOSITORY_HEAVY_P95_MS, 3000);

if (!cookieSecret) fail("ADMIN_AUTH_COOKIE_SECRET is required", 2);
if (!["server", "supabase"].includes(expectedSource)) {
  fail("EXPECTED_DB_READ_SOURCE must be server or supabase", 2);
}

let sampleProduct = null;
let sampleCatalog = null;
let cachedCookie;

const checks = [
  ["authentication boundary", checkAuthentication],
  ["health and catalog repositories", checkCatalog],
  ["product pagination, hydration and filters", checkProducts],
  ["inventory and matrix repositories", checkInventory],
  ["movements and workshop repositories", checkOperations],
  ["Ozon order repository", checkOzonOrders],
  ["expense, finance and import repositories", checkFinance],
  ["read-only RPC repository dispatcher", checkReadOnlyRpc],
];

for (const [name, run] of checks) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    fail(`failed - ${name}\n${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

await runPerformanceChecks();

async function checkAuthentication() {
  const response = await fetch(`${baseUrl}/api/admin/catalog`);
  if (response.status !== 401) throw new Error(`Expected 401, got ${response.status}`);
}

async function checkCatalog() {
  const health = await getJson("/api/admin/health");
  if (health.data?.status !== "ok" || health.data?.databaseReadSource !== expectedSource) {
    throw new Error("Health route did not report the expected database source");
  }

  const payload = await getJson("/api/admin/catalog");
  const expectedArrays = [
    "warehouses",
    "categories",
    "fabrics",
    "colors",
    "sizes",
    "decorationTypes",
    "designs",
    "expenseCategories",
  ];
  for (const key of expectedArrays) assertArray(payload.data?.[key], `data.${key}`);
  if (payload.data.categories.length === 0 || payload.data.sizes.length === 0) {
    throw new Error("Expected non-empty catalog reference data");
  }
  if (expectedSource === "server" && payload.meta?.databaseReadSource !== "server") {
    throw new Error("Catalog did not report the server read adapter");
  }
  sampleCatalog = payload.data;
}

async function checkProducts() {
  const first = await getJson("/api/admin/products?limit=7");
  if (!Array.isArray(first.data) || first.data.length === 0 || first.data.length > 7) {
    throw new Error("Expected a non-empty products page with at most seven rows");
  }
  assertProduct(first.data[0]);
  sampleProduct = first.data[0];
  if (first.meta?.limit !== 7 || first.meta?.offset !== 0 || typeof first.meta?.hasMore !== "boolean") {
    throw new Error("Products pagination metadata changed");
  }

  if (first.meta.hasMore) {
    const second = await getJson(
      `/api/admin/products?limit=7&cursor=${encodeURIComponent(first.meta.nextCursor)}`,
    );
    const firstIds = new Set(first.data.map((row) => row.id));
    if (second.data.some((row) => firstIds.has(row.id))) {
      throw new Error("Products cursor returned overlapping rows");
    }
  }

  for (const isBlank of ["true", "false"]) {
    const payload = await getJson(`/api/admin/products?limit=10&is_blank=${isBlank}`);
    if (!payload.data.every((row) => row.is_blank === (isBlank === "true"))) {
      throw new Error(`is_blank=${isBlank} returned an incompatible row`);
    }
  }

  if (typeof sampleProduct.sku === "string" && sampleProduct.sku.length > 2) {
    const needle = sampleProduct.sku.slice(0, Math.min(8, sampleProduct.sku.length));
    const searched = await getJson(`/api/admin/products?limit=20&search=${encodeURIComponent(needle)}`);
    if (searched.data.length === 0 || searched.data.some((row) => !row.sku?.toLowerCase().includes(needle.toLowerCase()))) {
      throw new Error("Product search returned an incompatible row set");
    }
  }

  const counts = await getJson("/api/admin/designs/product-counts");
  assertArray(counts.data, "design product counts");
  for (const row of counts.data) {
    if (typeof row.design_id !== "string" || typeof row.count !== "number") {
      throw new Error("Invalid design product count row");
    }
  }

  const matches = await postJson("/api/admin/products/blank-matches", {
    keys: [pickDimensions(sampleProduct)],
  });
  assertArray(matches.data, "blank matches");
  for (const product of matches.data) assertProduct(product);
}

async function checkInventory() {
  const inventory = await getJson("/api/admin/inventory?limit=50");
  assertArray(inventory.data, "inventory");
  for (const row of inventory.data) {
    if (typeof row.id !== "string" || typeof row.quantity !== "number") {
      throw new Error("Invalid inventory row");
    }
    if (row.product) assertProduct(row.product);
  }

  const matrix = await getJson("/api/admin/inventory/matrix");
  assertArray(matrix.data?.blankRows, "matrix blankRows");
  assertArray(matrix.data?.finishedRows, "matrix finishedRows");
}

async function checkOperations() {
  const movements = await getJson("/api/admin/inventory/movements?limit=100");
  assertArray(movements.data, "movements");

  const workshop = await getJson("/api/admin/workshop/orders?limit=100");
  assertArray(workshop.data, "workshop orders");
  for (const order of workshop.data) assertArray(order.items, "workshop order items");
}

async function checkOzonOrders() {
  const orders = await getJson("/api/admin/ozon/orders?limit=50");
  assertArray(orders.data, "Ozon orders");
  for (const order of orders.data) {
    if (typeof order.posting_number !== "string") throw new Error("Invalid Ozon order");
    assertArray(order.items, "Ozon order items");
  }
}

async function checkFinance() {
  for (const path of [
    "/api/admin/expenses?limit=200",
    "/api/admin/finance/ozon?limit=200",
    "/api/admin/import/ozon/runs?limit=50",
  ]) {
    const payload = await getJson(path);
    assertArray(payload.data, path);
  }
}

async function checkReadOnlyRpc() {
  const arrayActions = [
    ["listWarehouses"],
    ["listCategories"],
    ["listFabrics"],
    ["listColors"],
    ["listSizes"],
    ["listDecorationTypes"],
    ["listDesigns", [{}]],
    ["listProducts", [{ is_blank: true }]],
    ["listInventory", [sampleCatalog.warehouses[0]?.id]],
    ["listTransactions", [25]],
    ["listPrintInventory", [sampleCatalog.warehouses[0]?.id]],
    ["listWorkshopOrders"],
    ["listOzonOrders"],
    ["listExpenseCategories", [{ includeArchived: true }]],
    ["listExpenses", [{}]],
    ["listFinanceOperations", [{}]],
    ["listOzonSkuProductMap"],
  ];
  const results = new Map();
  for (const [action, args = []] of arrayActions) {
    const data = await rpc(action, args);
    assertArray(data, `RPC ${action}`);
    results.set(action, data);
  }

  const warehouseId = sampleCatalog.warehouses[0]?.id;
  if (warehouseId) {
    const quantity = await rpc("getInventoryFor", [sampleProduct.id, warehouseId]);
    if (typeof quantity !== "number") throw new Error("RPC getInventoryFor did not return a number");
  }

  const printRow = results.get("listPrintInventory")[0];
  if (printRow) {
    const quantity = await rpc("getPrintInventoryFor", [printRow.design_id, printRow.warehouse_id]);
    if (typeof quantity !== "number") throw new Error("RPC getPrintInventoryFor did not return a number");
  }

  const workshopOrder = results.get("listWorkshopOrders")[0];
  if (workshopOrder) {
    const order = await rpc("getWorkshopOrder", [workshopOrder.id]);
    if (!order || order.id !== workshopOrder.id) throw new Error("RPC getWorkshopOrder mismatch");
  }

  const blank = await rpc("findBlankFor", [sampleProduct]);
  if (blank !== null) assertProduct(blank);

  const lastSync = await rpc("lastFinanceSyncAt");
  if (lastSync !== null && typeof lastSync !== "string") {
    throw new Error("RPC lastFinanceSyncAt returned an invalid value");
  }
}

async function runPerformanceChecks() {
  const ordinaryPaths = [
    "/api/admin/health",
    "/api/admin/catalog",
    "/api/admin/products?limit=50",
    "/api/admin/inventory?limit=50",
    "/api/admin/inventory/movements?limit=100",
    "/api/admin/ozon/orders?limit=50",
    "/api/admin/expenses?limit=200",
    "/api/admin/finance/ozon?limit=200",
  ];
  const ordinary = [];
  for (let sample = 0; sample < perfSamples; sample += 1) {
    for (const path of ordinaryPaths) ordinary.push(await timedGet(path));
  }

  const heavy = [];
  for (let sample = 0; sample < Math.max(3, Math.ceil(perfSamples / 2)); sample += 1) {
    heavy.push(await timedGet("/api/admin/inventory/matrix"));
  }

  const ordinaryP95 = percentile(ordinary, 0.95);
  const heavyP95 = percentile(heavy, 0.95);
  console.log(`metrics - ordinary p95=${ordinaryP95}ms samples=${ordinary.length} limit=${ordinaryLimitMs}ms`);
  console.log(`metrics - heavy p95=${heavyP95}ms samples=${heavy.length} limit=${heavyLimitMs}ms`);
  if (ordinaryP95 > ordinaryLimitMs) fail("Ordinary repository p95 exceeded the stage 6 limit", 1);
  if (heavyP95 > heavyLimitMs) fail("Heavy repository p95 exceeded the stage 6 limit", 1);
}

async function getJson(path) {
  return requestJson(path, { method: "GET" });
}

async function postJson(path, body) {
  return requestJson(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function rpc(action, args = []) {
  const payload = await postJson("/api/admin/rpc", { action, args });
  return payload.data;
}

async function requestJson(path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Cookie: authCookie() },
  });
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`Expected 200 for ${path}, got ${response.status}: ${text.slice(0, 300)}`);
  }
  try {
    const payload = JSON.parse(text);
    if (payload.ok !== true) throw new Error("Response did not contain ok=true");
    return payload;
  } catch (error) {
    throw new Error(`Expected JSON for ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function timedGet(path) {
  const started = performance.now();
  await getJson(path);
  return Math.round(performance.now() - started);
}

function assertProduct(product) {
  for (const key of ["id", "category_id", "fabric_id", "color_id", "size_id", "is_blank", "created_at"]) {
    if (!(key in product)) throw new Error(`Product is missing ${key}`);
  }
  for (const key of ["category", "fabric", "color", "size"]) {
    if (!product[key] || typeof product[key].id !== "string") {
      throw new Error(`Product is missing hydrated ${key}`);
    }
  }
}

function pickDimensions(product) {
  return {
    category_id: product.category_id,
    fabric_id: product.fabric_id,
    color_id: product.color_id,
    size_id: product.size_id,
  };
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`Expected ${label} array`);
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function authCookie() {
  if (cachedCookie) return cachedCookie;
  const now = Math.floor(Date.now() / 1000);
  const maxAge = Number.isFinite(sessionDays) && sessionDays > 0
    ? sessionDays * 24 * 60 * 60
    : 60 * 24 * 60 * 60;
  const body = Buffer.from(JSON.stringify({ sub: "owner", iat: now, exp: now + Math.floor(maxAge) }), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", cookieSecret).update(body).digest("base64url");
  cachedCookie = `${cookieName}=${body}.${signature}`;
  return cachedCookie;
}

function fail(message, code) {
  console.error(message);
  process.exit(code);
}
