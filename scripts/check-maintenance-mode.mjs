#!/usr/bin/env node

import crypto from "node:crypto";

const baseUrl = (process.env.ADMIN_BFF_BASE_URL || process.argv[2] || "http://127.0.0.1:3100").replace(/\/$/, "");
const cookieSecret = process.env.ADMIN_AUTH_COOKIE_SECRET;
const cookieName = process.env.ADMIN_AUTH_COOKIE_NAME || "getomerch_admin_session";
const skipReads = process.env.GETOMERCH_MAINTENANCE_SKIP_READS === "true";

if (!cookieSecret) fail("ADMIN_AUTH_COOKIE_SECRET is required", 2);
const cookie = signedCookie();

if (!skipReads) {
  await expectJson("/api/admin/health", 200, { cookie }, (body) => {
    expect(body?.data?.maintenanceMode === "read_only", "health did not report read_only mode");
  });
  await expectJson("/api/admin/catalog", 200, { cookie });
  await expectJson("/api/admin/rpc", 200, {
    method: "POST",
    cookie,
    body: { action: "listWarehouses", args: [] },
  });
}
await expectJson("/api/admin/rpc", 503, {
  method: "POST",
  cookie,
  headers: mutationHeaders(),
  body: { action: "createColor", args: [{ name: "maintenance-check" }] },
}, maintenanceError);
await expectJson("/api/ozon/sync-orders", 503, {
  method: "POST",
  cookie,
  headers: mutationHeaders(),
}, maintenanceError);
await expectJson("/api/komui/import", 503, {
  method: "POST",
  cookie,
  headers: mutationHeaders(),
  body: { previewId: "maintenance-check", confirm: true },
}, maintenanceError);
await expectJson("/api/auth/login", 401, {
  method: "POST",
  body: { password: `invalid-${crypto.randomUUID()}` },
});

console.log("ok - maintenance mode keeps reads/auth available and blocks writes");

async function expectJson(path, expectedStatus, options = {}, inspect = undefined) {
  const headers = new Headers(options.headers || {});
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    fail(`${path} returned invalid JSON: ${text.slice(0, 160)}`, 1);
  }
  expect(response.status === expectedStatus, `${path} returned ${response.status}, expected ${expectedStatus}: ${text.slice(0, 160)}`);
  inspect?.(body);
}

function maintenanceError(body) {
  expect(body?.error?.code === "maintenance", "response did not contain maintenance error code");
}

function mutationHeaders() {
  return {
    "X-Idempotency-Key": crypto.randomUUID(),
    "X-Request-Id": crypto.randomUUID(),
  };
}

function signedCookie() {
  const now = Math.floor(Date.now() / 1_000);
  const payload = Buffer.from(JSON.stringify({ sub: "owner", iat: now, exp: now + 3_600 }), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", cookieSecret).update(payload).digest("base64url");
  return `${cookieName}=${payload}.${signature}`;
}

function expect(condition, message) {
  if (!condition) fail(message, 1);
}

function fail(message, code) {
  console.error(message);
  process.exit(code);
}
