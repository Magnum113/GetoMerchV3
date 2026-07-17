#!/usr/bin/env node

import crypto from "node:crypto";

const baseUrl = (process.env.ADMIN_BFF_BASE_URL || "http://127.0.0.1:3102").replace(/\/$/, "");
const cookieSecret = process.env.ADMIN_AUTH_COOKIE_SECRET;
const cookieName = process.env.ADMIN_AUTH_COOKIE_NAME || "getomerch_admin_session";
const url = new URL(baseUrl);

if (process.env.ALLOW_REAL_OZON_DRY_RUN !== "true") {
  fail("ALLOW_REAL_OZON_DRY_RUN=true is required", 2);
}
if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
  fail("Real Ozon rehearsal smoke must target a loopback candidate", 2);
}
if (!cookieSecret) fail("ADMIN_AUTH_COOKIE_SECRET is required", 2);

const health = await requestJson("/api/admin/health", { method: "GET" });
expect(health.status === 200, `health returned ${health.status}`);
expect(health.payload?.data?.databaseReadSource === "server", "candidate read source is not server");
expect(health.payload?.data?.databaseWriteSource === "server", "candidate write source is not server");

const orders = await startJob("/api/ozon/sync-orders?scope=active&days=60&dryRun=true");
expect(orders.result?.dryRun === true, "orders smoke was not a dry run");
console.log(`ok - real Ozon active orders dry run, fetched=${Number(orders.result?.fetched ?? 0)}`);

const prices = await startJob("/api/ozon/sync-prices?dryRun=true");
expect(prices.result?.dryRun === true, "prices smoke was not a dry run");
console.log(`ok - real Ozon prices dry run, fetched=${Number(prices.result?.fetchedPrices ?? 0)}`);

const to = new Date(Date.now() + 86_400_000).toISOString();
const from = new Date(Date.now() - 2 * 86_400_000).toISOString();
const finance = await startJob(
  `/api/ozon/sync-finance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&dryRun=true`,
);
expect(finance.result?.dryRun === true, "finance smoke was not a dry run");
console.log(`ok - real Ozon finance dry run, fetched=${Number(finance.result?.fetched ?? 0)}`);

const preview = await startJob("/api/ozon/import/preview");
expect(typeof preview.result?.runId === "string", "import preview did not return runId");
const previewTotal = Number(preview.result?.summary?.totalOzonItems);
expect(Number.isSafeInteger(previewTotal) && previewTotal > 0, "import preview returned no Ozon items");
console.log(`ok - real Ozon import preview, total=${previewTotal}`);
console.log("ok - real Ozon rehearsal smoke passed (4 groups)");

async function startJob(path) {
  const response = await requestJson(path, {
    method: "POST",
    headers: {
      "X-Idempotency-Key": crypto.randomUUID(),
      "X-Request-Id": crypto.randomUUID(),
    },
  });
  expect(response.status === 202, `${path} returned ${response.status}: ${response.text.slice(0, 240)}`);
  const jobId = response.payload?.jobId;
  expect(typeof jobId === "string", `${path} did not return jobId`);
  return waitForJob(jobId, 10 * 60_000);
}

async function waitForJob(jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await requestJson(`/api/admin/jobs/${jobId}`, { method: "GET" });
    expect(response.status === 200, `job ${jobId} returned ${response.status}`);
    const job = response.payload?.data;
    if (job?.status === "succeeded") return job;
    if (job?.status === "failed" || job?.status === "cancelled") {
      throw new Error(`job ${jobId} ended as ${job.status}: ${job.errorCode ?? "unknown"} ${job.errorMessage ?? ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`job ${jobId} timed out`);
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

function authCookie() {
  const now = Math.floor(Date.now() / 1_000);
  const body = Buffer.from(JSON.stringify({ sub: "owner", iat: now, exp: now + 3_600 }), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", cookieSecret).update(body).digest("base64url");
  return `${cookieName}=${body}.${signature}`;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message, code) {
  console.error(message);
  process.exit(code);
}
