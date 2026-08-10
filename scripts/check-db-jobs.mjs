#!/usr/bin/env node

import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import pg from "pg";

const { Client } = pg;
const baseUrl = (process.env.ADMIN_BFF_BASE_URL || process.argv[2] || "http://127.0.0.1:3102").replace(/\/$/, "");
const connectionString = process.env.GETOMERCH_DATABASE_URL;
const cookieSecret = process.env.ADMIN_AUTH_COOKIE_SECRET;
const cookieName = process.env.ADMIN_AUTH_COOKIE_NAME || "getomerch_admin_session";
const expectedDatabase = process.env.EXPECTED_STAGE8_DATABASE || "";
const internalServiceToken = process.env.EXPECTED_INTERNAL_SERVICE_TOKEN || "";
let cachedCookie;

if (!connectionString) fail("GETOMERCH_DATABASE_URL is required", 2);
if (!cookieSecret) fail("ADMIN_AUTH_COOKIE_SECRET is required", 2);
const databaseName = new URL(connectionString).pathname.replace(/^\//, "");
if (!/^getomerch_stage(?:8|9)_[a-z0-9_]+$/.test(databaseName)) {
  fail(`Refusing job tests against non-disposable database ${JSON.stringify(databaseName)}`, 2);
}
if (expectedDatabase && databaseName !== expectedDatabase) {
  fail(`Database ${databaseName} does not match EXPECTED_STAGE8_DATABASE`, 2);
}

const client = new Client({ connectionString, ssl: false, application_name: "getomerch-stage8-job-tests" });
await client.connect();
const token = crypto.randomBytes(5).toString("hex");
const fixture = await loadFixture();
const mock = await startOzonMock(fixture, token);
const workerLogs = [];
let workers = [];

try {
  await checkRuntime();
  await checkInputValidation();
  await checkServiceAuthentication();
  await prepareOrdersFixture(fixture, token);
  const queued = await checkQueueSemantics();
  await insertStaleWorkerFixture();
  workers = [startWorker(mock.url, workerLogs), startWorker(mock.url, workerLogs)];

  const firstJob = await waitForJob(queued.jobId, 90_000);
  expect(firstJob.status === "succeeded", `orders job failed: ${JSON.stringify(firstJob)}`);
  expect(firstJob.attemptCount === 2, `orders retry count is ${firstJob.attemptCount}, expected 2`);
  expect(firstJob.events.some((event) => event.event === "retry_scheduled"), "retry_scheduled event is missing");
  await checkCancelledRefresh(token);
  console.log("ok - queue idempotency, worker retry and cancelled refresh");

  await checkRepeatOrderSync(token);
  await checkFullOrderPagination(token);
  await checkFinancePagination(token);
  await checkFinanceDryRun(token);
  await checkPricePagination(fixture);
  await checkImportJobs();
  await checkStaleRecovery();
  await checkRetention();
  console.log("ok - stage 8 background job checks passed (10 groups)");
} finally {
  for (const worker of workers) worker.kill("SIGTERM");
  await Promise.all(workers.map(waitForExit));
  await new Promise((resolve) => mock.server.close(resolve));
  await client.end();
  if (process.exitCode && workerLogs.length > 0) {
    console.error(workerLogs.slice(-30).join(""));
  }
}

async function checkRuntime() {
  const response = await requestJson("/api/admin/health", { method: "GET" });
  expect(response.status === 200, `health returned ${response.status}`);
  expect(response.payload?.data?.databaseReadSource === "server", "candidate read source is not server");
  expect(response.payload?.data?.databaseWriteSource === "server", "candidate write source is not server");
  console.log("ok - isolated server read/write runtime");
}

async function checkInputValidation() {
  const checks = [
    "/api/ozon/sync-orders?days=NaN",
    "/api/ozon/sync-orders?scope=unknown",
    "/api/ozon/sync-orders?dryRun=maybe",
    "/api/ozon/sync-finance?from=invalid",
  ];
  for (const path of checks) {
    const response = await enqueue(path, `stage8-invalid-${crypto.randomUUID()}`);
    expect(response.status === 400, `${path} returned ${response.status}, expected 400`);
  }
  const apply = await enqueueJson(
    "/api/ozon/import/apply",
    `stage8-invalid-apply-${token}`,
    {
      runId: "not-a-uuid",
      designOverrides: {},
      selection: defaultImportSelection(),
    },
  );
  expect(apply.status === 400, `invalid import run returned ${apply.status}`);
  console.log("ok - Ozon route input validation");
}

async function checkServiceAuthentication() {
  expect(internalServiceToken.length >= 8, "EXPECTED_INTERNAL_SERVICE_TOKEN is required");
  const headers = {
    "X-Idempotency-Key": `stage8-service-${token}`,
    "X-Request-Id": crypto.randomUUID(),
  };
  const anonymous = await requestJsonWithoutCookie("/api/ozon/sync-prices?dryRun=true", {
    method: "POST",
    headers,
  });
  expect(anonymous.status === 401, `anonymous enqueue returned ${anonymous.status}`);
  const rejected = await requestJsonWithoutCookie("/api/ozon/sync-prices?dryRun=true", {
    method: "POST",
    headers: { ...headers, Authorization: "Bearer wrong-stage8-token" },
  });
  expect(rejected.status === 401, `invalid service token returned ${rejected.status}`);
  const accepted = await requestJsonWithoutCookie("/api/ozon/sync-prices?dryRun=true", {
    method: "POST",
    headers: { ...headers, Authorization: `Bearer ${internalServiceToken}` },
  });
  expect(accepted.status === 202, `service token enqueue returned ${accepted.status}`);
  const cancelled = await requestJson(`/api/admin/jobs/${accepted.payload.jobId}`, { method: "DELETE" });
  expect(cancelled.status === 200 && cancelled.payload?.data?.status === "cancelled", "queued job was not cancelled");
  console.log("ok - admin/service auth boundary and queued cancellation");
}

async function checkQueueSemantics() {
  const key = `stage8-orders-${token}`;
  const first = await enqueue("/api/ozon/sync-orders?scope=active&days=60", key);
  expect(first.status === 202, `orders enqueue returned ${first.status}`);
  const jobId = first.payload?.jobId;
  expect(typeof jobId === "string", "orders enqueue did not return jobId");
  const replay = await enqueue("/api/ozon/sync-orders?scope=active&days=60", key);
  expect(replay.status === 202 && replay.payload?.jobId === jobId, "idempotent enqueue returned another job");
  const conflict = await enqueue("/api/ozon/sync-orders?scope=active&days=61", key);
  expect(conflict.status === 409, `idempotency conflict returned ${conflict.status}`);
  const deduped = await enqueue("/api/ozon/sync-orders?scope=active&days=60", `stage8-dedupe-${token}`);
  expect(deduped.status === 202 && deduped.payload?.jobId === jobId, "active dedupe returned another job");
  const queued = await getJob(jobId);
  expect(queued.status === "queued", "job did not remain durable before worker start");
  return { jobId };
}

async function checkCancelledRefresh(testToken) {
  const cancelled = `STAGE8-CANCELLED-${testToken}`;
  const active = `STAGE8-ACTIVE-${testToken}`;
  const rows = await client.query(
    "SELECT posting_number, status, source FROM merch_ozon_orders WHERE posting_number = ANY($1::text[]) ORDER BY posting_number",
    [[cancelled, active]],
  );
  expect(rows.rows.length === 2, `expected 2 synced orders, got ${rows.rows.length}`);
  expect(rows.rows.find((row) => row.posting_number === cancelled)?.status === "cancelled", "stale order was not cancelled");
  const items = await client.query(`
    SELECT order_row.posting_number, count(item.id)::int AS count
    FROM merch_ozon_orders order_row
    LEFT JOIN merch_ozon_order_items item ON item.order_id = order_row.id
    WHERE order_row.posting_number = ANY($1::text[])
    GROUP BY order_row.posting_number
  `, [[cancelled, active]]);
  expect(items.rows.every((row) => row.count === 1), `order item replacement is invalid: ${JSON.stringify(items.rows)}`);
}

async function checkRepeatOrderSync(testToken) {
  const response = await enqueue("/api/ozon/sync-orders?scope=active&days=60", `stage8-repeat-${testToken}`);
  const job = await waitForJob(response.payload.jobId, 60_000);
  expect(job.status === "succeeded", `repeat orders job failed: ${job.errorMessage}`);
  const active = `STAGE8-ACTIVE-${testToken}`;
  const counts = await client.query(`
    SELECT
      count(DISTINCT order_row.id)::int AS orders,
      count(item.id)::int AS items
    FROM merch_ozon_orders order_row
    LEFT JOIN merch_ozon_order_items item ON item.order_id = order_row.id
    WHERE order_row.posting_number = $1
  `, [active]);
  expect(counts.rows[0].orders === 1 && counts.rows[0].items === 1, "repeat order sync created duplicates");
  console.log("ok - repeat order sync is idempotent");
}

async function checkFullOrderPagination(testToken) {
  const response = await enqueue("/api/ozon/sync-orders?scope=all&days=30", `stage8-full-${testToken}`);
  const job = await waitForJob(response.payload.jobId, 60_000);
  expect(job.status === "succeeded", `full orders job failed: ${job.errorMessage}`);
  expect(job.result.fetched === 3, `full pagination fetched ${job.result.fetched}, expected 3`);
  const fbo = await client.query(
    "SELECT source FROM merch_ozon_orders WHERE posting_number = $1",
    [`STAGE8-FBO-${testToken}`],
  );
  expect(fbo.rows[0]?.source === "fbo", "FBO source was not preserved");
  console.log("ok - FBS pagination to has_next end and FBO source");
}

async function checkFinancePagination(testToken) {
  const from = "2026-01-01T00:00:00.000Z";
  const to = "2026-01-02T00:00:00.000Z";
  const first = await enqueue(`/api/ozon/sync-finance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, `stage8-finance-${testToken}`);
  const firstJob = await waitForJob(first.payload.jobId, 60_000);
  expect(firstJob.status === "succeeded", `finance job failed: ${firstJob.errorMessage}`);
  expect(firstJob.result.fetched === 2 && firstJob.result.created === 2, `finance first result invalid: ${JSON.stringify(firstJob.result)}`);
  const second = await enqueue(`/api/ozon/sync-finance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, `stage8-finance-repeat-${testToken}`);
  const secondJob = await waitForJob(second.payload.jobId, 60_000);
  expect(secondJob.status === "succeeded" && secondJob.result.created === 0 && secondJob.result.updated === 2, "finance replay is not idempotent");
  console.log("ok - finance page_count pagination and idempotent upsert");
}

async function checkFinanceDryRun(testToken) {
  const before = Number((await client.query("SELECT count(*) FROM merch_ozon_finance_operations")).rows[0].count);
  const response = await enqueue(
    `/api/ozon/sync-finance?from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-02T00%3A00%3A00.000Z&dryRun=true`,
    `stage8-finance-dry-${testToken}`,
  );
  const job = await waitForJob(response.payload.jobId, 60_000);
  const after = Number((await client.query("SELECT count(*) FROM merch_ozon_finance_operations")).rows[0].count);
  expect(job.status === "succeeded" && job.result.dryRun === true, `finance dry run failed: ${JSON.stringify(job)}`);
  expect(job.result.created === 0 && job.result.updated === 0 && before === after, "finance dry run changed stored rows");
  console.log("ok - finance dry run leaves database unchanged");
}

async function checkPricePagination(product) {
  await client.query("UPDATE merch_products SET sale_price = 100 WHERE id = $1", [product.id]);
  const response = await enqueue("/api/ozon/sync-prices", `stage8-prices-${token}`);
  const job = await waitForJob(response.payload.jobId, 60_000);
  expect(job.status === "succeeded", `price job failed: ${job.errorMessage}`);
  expect(job.result.fetchedPrices === 1, `price cursor pages were not merged: ${JSON.stringify(job.result)}`);
  const price = Number((await client.query("SELECT sale_price FROM merch_products WHERE id = $1", [product.id])).rows[0].sale_price);
  expect(price === 777, `price was not updated from second cursor flow: ${price}`);
  console.log("ok - price cursor pagination and batch update");
}

async function checkImportJobs() {
  const previewResponse = await enqueue("/api/ozon/import/preview", `stage8-preview-${token}`);
  const previewJob = await waitForJob(previewResponse.payload.jobId, 60_000);
  expect(previewJob.status === "succeeded", `preview job failed: ${previewJob.errorMessage}`);
  expect(typeof previewJob.result.runId === "string", "preview job did not return runId");
  expect(!("items" in previewJob.result), "preview job duplicated import items in job result");
  const details = await requestJson(`/api/admin/import/ozon/runs/${previewJob.result.runId}`, { method: "GET" });
  expect(details.status === 200 && details.payload?.data?.items?.length === 1, "persisted preview details are missing");
  const applyResponse = await enqueueJson(
    "/api/ozon/import/apply",
    `stage8-apply-${token}`,
    {
      runId: previewJob.result.runId,
      designOverrides: {},
      selection: defaultImportSelection(),
    },
  );
  const applyJob = await waitForJob(applyResponse.payload.jobId, 60_000);
  expect(applyJob.status === "succeeded" && applyJob.result.status === "applied", `import apply failed: ${JSON.stringify(applyJob)}`);
  console.log("ok - queued import preview details and atomic apply");
}

async function insertStaleWorkerFixture() {
  await client.query(`
    INSERT INTO getomerch_jobs.jobs (
      type, status, dedupe_key, idempotency_key, request_hash, payload,
      actor, request_id, attempt_count, max_attempts, locked_by, locked_at,
      heartbeat_at, started_at
    )
    VALUES (
      'ozon_prices_sync', 'running', $1, $2, repeat('a', 64), '{}'::jsonb,
      'stage8-test', gen_random_uuid(), 1, 1, 'dead-worker',
      clock_timestamp() - interval '10 minutes',
      clock_timestamp() - interval '10 minutes',
      clock_timestamp() - interval '10 minutes'
    )
  `, [`stale-${token}`, `stale-idempotency-${token}`]);
}

async function checkStaleRecovery() {
  const row = await client.query(
    "SELECT status, error_code FROM getomerch_jobs.jobs WHERE dedupe_key = $1",
    [`stale-${token}`],
  );
  expect(row.rows[0]?.status === "failed" && row.rows[0]?.error_code === "worker_heartbeat_stale", "stale running job was not recovered");
  console.log("ok - stale heartbeat recovery");
}

async function checkRetention() {
  const dedupeKey = `retention-${token}`;
  await client.query(`
    INSERT INTO getomerch_jobs.jobs (
      type, status, dedupe_key, idempotency_key, request_hash, payload,
      result, actor, request_id, attempt_count, max_attempts, finished_at
    )
    VALUES (
      'ozon_prices_sync', 'succeeded', $1, $2, repeat('b', 64), '{"dryRun":true}'::jsonb,
      '{}'::jsonb, 'stage8-test', gen_random_uuid(), 1, 1,
      clock_timestamp() - interval '31 days'
    )
  `, [dedupeKey, `retention-idempotency-${token}`]);
  const pruned = await client.query(
    "SELECT getomerch_jobs.prune_finished_jobs(interval '30 days', 500) AS count",
  );
  const remaining = await client.query("SELECT count(*) FROM getomerch_jobs.jobs WHERE dedupe_key = $1", [dedupeKey]);
  expect(Number(pruned.rows[0].count) >= 1 && Number(remaining.rows[0].count) === 0, "finished job retention did not prune old row");
  console.log("ok - finished job retention");
}

async function prepareOrdersFixture(product, testToken) {
  await client.query("UPDATE merch_ozon_orders SET status = 'delivered' WHERE source = 'fbs'");
  const postingNumber = `STAGE8-CANCELLED-${testToken}`;
  const order = await client.query(`
    INSERT INTO merch_ozon_orders (posting_number, status, source, synced_at)
    VALUES ($1, 'awaiting_packaging', 'fbs', clock_timestamp())
    ON CONFLICT (posting_number) DO UPDATE SET status = 'awaiting_packaging', source = 'fbs', shipped_at = NULL
    RETURNING id
  `, [postingNumber]);
  await client.query("DELETE FROM merch_ozon_order_items WHERE order_id = $1", [order.rows[0].id]);
  const sourceItemKey = `stage8:${Buffer.from(product.sku).toString("hex")}`;
  await client.query(`
    INSERT INTO merch_ozon_order_items (
      order_id,
      source_item_key,
      offer_id,
      quantity,
      product_id
    )
    VALUES ($1, $2, $3, 1, $4)
  `, [order.rows[0].id, sourceItemKey, product.sku, product.id]);
}

async function loadFixture() {
  const result = await client.query(`
    SELECT id, sku, ozon_sku
    FROM merch_products
    WHERE sku IS NOT NULL AND is_blank = false
    ORDER BY id
    LIMIT 1
  `);
  if (!result.rows[0]) throw new Error("Expected a finished product fixture");
  return result.rows[0];
}

async function startOzonMock(product, testToken) {
  let unfulfilledFailures = 0;
  const financeBase = Number(`8${Date.now().toString().slice(-10)}`);
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    const path = request.url || "";
    if (path === "/v3/posting/fbs/unfulfilled/list") {
      if (unfulfilledFailures < 4) {
        unfulfilledFailures += 1;
        return json(response, 503, { error: "temporary" });
      }
      return json(response, 200, { result: { postings: [posting(`STAGE8-ACTIVE-${testToken}`, "awaiting_packaging", product)] } });
    }
    if (path === "/v3/posting/fbs/get") {
      return json(response, 200, { result: posting(String(body.posting_number), "cancelled", product) });
    }
    if (path === "/v3/posting/fbs/list") {
      const offset = Number(body.offset || 0);
      return offset === 0
        ? json(response, 200, { result: { postings: [posting(`STAGE8-FBS-1-${testToken}`, "delivered", product)], has_next: true } })
        : json(response, 200, { result: { postings: [posting(`STAGE8-FBS-2-${testToken}`, "cancelled", product)], has_next: false } });
    }
    if (path === "/v2/posting/fbo/list") {
      return json(response, 200, { result: Number(body.offset || 0) === 0 ? [posting(`STAGE8-FBO-${testToken}`, "delivered", product)] : [] });
    }
    if (path === "/v3/finance/transaction/list") {
      const page = Number(body.page || 1);
      return json(response, 200, { result: { page_count: 2, operations: [financeOperation(financeBase + page, page)] } });
    }
    if (path === "/v5/product/info/prices") {
      if (!body.cursor) {
        return json(response, 200, { items: [{ offer_id: product.sku, price: { marketing_seller_price: 777 } }], cursor: "page-2" });
      }
      return json(response, 200, { items: [], cursor: "" });
    }
    if (path === "/v3/product/list") {
      if (!body.last_id) return json(response, 200, { result: { items: [{ offer_id: product.sku }], last_id: "page-2" } });
      return json(response, 200, { result: { items: [], last_id: "" } });
    }
    if (path === "/v3/product/info/list") {
      return json(response, 200, { items: [{ offer_id: product.sku, sku: product.ozon_sku ?? undefined, name: "Тестовый товар", images: [] }] });
    }
    return json(response, 404, { error: `unknown ${path}` });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function posting(postingNumber, status, product) {
  return {
    posting_number: postingNumber,
    order_id: 1,
    order_number: postingNumber,
    status,
    created_at: "2026-01-01T00:00:00.000Z",
    in_process_at: "2026-01-01T01:00:00.000Z",
    shipment_date: "2026-01-02T00:00:00.000Z",
    products: [{ offer_id: product.sku, sku: product.ozon_sku ?? 1, name: "Test", quantity: 1, price: "777" }],
  };
}

function financeOperation(operationId, page) {
  return {
    operation_id: operationId,
    operation_type: "OperationAgentDeliveredToCustomer",
    operation_type_name: `Page ${page}`,
    operation_date: `2026-01-01T0${page}:00:00.000Z`,
    amount: 100 + page,
    posting: { posting_number: `FIN-${token}-${page}` },
    items: [],
    services: [],
  };
}

function startWorker(mockUrl, logs) {
  const child = spawn(process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/getomerch-worker.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_OPTIONS: "--conditions=react-server",
      OZON_CLIEN_ID: "stage8-test",
      OZON_API_KEY: "stage8-test",
      GETOMERCH_OZON_API_BASE_URL: mockUrl,
      GETOMERCH_ALLOW_OZON_BASE_URL_OVERRIDE: "true",
      GETOMERCH_WORKER_POLL_MS: "250",
      GETOMERCH_WORKER_HEARTBEAT_MS: "2000",
      GETOMERCH_WORKER_STALE_SECONDS: "30",
      GETOMERCH_DATABASE_POOL_MAX: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  return child;
}

async function enqueue(path, key) {
  return requestJson(path, {
    method: "POST",
    headers: { "X-Idempotency-Key": key, "X-Request-Id": crypto.randomUUID() },
  });
}

async function enqueueJson(path, key, body) {
  return requestJson(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": key,
      "X-Request-Id": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
}

async function waitForJob(jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getJob(jobId);
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function getJob(jobId) {
  const response = await requestJson(`/api/admin/jobs/${jobId}`, { method: "GET" });
  expect(response.status === 200, `job ${jobId} returned ${response.status}`);
  return response.payload.data;
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

async function requestJsonWithoutCookie(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* asserted by callers */ }
  return { status: response.status, payload, text };
}

function authCookie() {
  if (cachedCookie) return cachedCookie;
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ sub: "owner", iat: now, exp: now + 3600 }), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", cookieSecret).update(body).digest("base64url");
  cachedCookie = `${cookieName}=${body}.${signature}`;
  return cachedCookie;
}

function defaultImportSelection() {
  return {
    createDesigns: true,
    createProducts: true,
    updateIdentifiers: true,
    updatePrices: false,
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message, code) {
  console.error(message);
  process.exit(code);
}
