#!/usr/bin/env node
import crypto from "node:crypto";

const baseUrl = (process.env.ADMIN_BFF_BASE_URL || process.argv[2] || "http://127.0.0.1:3100").replace(/\/$/, "");
const cookieSecret = process.env.ADMIN_AUTH_COOKIE_SECRET;
const cookieName = process.env.ADMIN_AUTH_COOKIE_NAME || "getomerch_admin_session";
const sessionDays = Number(process.env.ADMIN_AUTH_SESSION_DAYS || "60");

const checks = [
  { name: "catalog without cookie returns 401", run: () => expectStatus("/api/admin/catalog", 401) },
  { name: "products validation returns 400", run: () => expectStatus("/api/admin/products?limit=not-a-number", 400, authCookie()) },
  { name: "health with valid cookie returns 200", run: () => expectStatus("/api/admin/health", 200, authCookie()) },
  { name: "products pagination with valid cookie returns cursor metadata", run: () => expectProductsPagination() },
  { name: "Ozon orders page data with valid cookie returns 200", run: () => expectStatus("/api/admin/ozon/orders?limit=5", 200, authCookie()) },
  { name: "inventory page data with valid cookie returns 200", run: () => expectStatus("/api/admin/inventory?limit=10", 200, authCookie()) },
  { name: "design product counts with valid cookie returns array", run: () => expectDesignProductCounts() },
  { name: "blank matches with valid cookie accepts empty key set", run: () => expectBlankMatches() },
  { name: "inventory matrix with valid cookie returns rows", run: () => expectInventoryMatrix() },
  {
    name: "admin RPC without cookie returns 401",
    run: () => expectStatus("/api/admin/rpc", 401, undefined, rpcInit("listWarehouses")),
  },
  {
    name: "admin RPC with valid cookie returns 200",
    run: () => expectStatus("/api/admin/rpc", 200, authCookie(), rpcInit("listWarehouses")),
  },
  {
    name: "Ozon sync route without cookie returns 401",
    run: () => expectStatus("/api/ozon/sync-orders", 401, undefined, { method: "POST" }),
  },
];

if (!cookieSecret) {
  console.error("ADMIN_AUTH_COOKIE_SECRET is required to generate a test admin session cookie.");
  process.exit(2);
}

for (const check of checks) {
  try {
    await check.run();
    console.log(`ok - ${check.name}`);
  } catch (error) {
    console.error(`failed - ${check.name}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function authCookie() {
  const now = Math.floor(Date.now() / 1000);
  const maxAge = Number.isFinite(sessionDays) && sessionDays > 0 ? sessionDays * 24 * 60 * 60 : 60 * 24 * 60 * 60;
  const payload = { sub: "owner", iat: now, exp: now + Math.floor(maxAge) };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", cookieSecret).update(body).digest("base64url");
  return `${cookieName}=${body}.${signature}`;
}

function rpcInit(action) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, args: [] }),
  };
}

async function expectStatus(path, expectedStatus, cookie, init = {}) {
  const headers = { ...(init.headers || {}), ...(cookie ? { Cookie: cookie } : {}) };
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`Expected ${expectedStatus}, got ${response.status}: ${text.slice(0, 300)}`);
  }
}

async function expectProductsPagination() {
  const first = await expectJson("/api/admin/products?limit=10&is_blank=false", 200, authCookie());
  if (!Array.isArray(first.data)) throw new Error("Expected products data array");
  if (first.data.length === 0) throw new Error("Expected at least one finished product");
  if (!first.meta || typeof first.meta.hasMore !== "boolean") {
    throw new Error("Expected products pagination metadata");
  }

  if (first.meta.hasMore) {
    if (typeof first.meta.nextCursor !== "string" || first.meta.nextCursor.length === 0) {
      throw new Error("Expected nextCursor when hasMore is true");
    }
    const second = await expectJson(
      `/api/admin/products?limit=10&is_blank=false&cursor=${encodeURIComponent(first.meta.nextCursor)}`,
      200,
      authCookie(),
    );
    if (!Array.isArray(second.data)) throw new Error("Expected second products data array");
    if (second.data.length === 0) throw new Error("Expected second products page");
    if (second.data[0]?.id === first.data[0]?.id) {
      throw new Error("Expected cursor to move to a different products page");
    }
  }
}

async function expectDesignProductCounts() {
  const payload = await expectJson("/api/admin/designs/product-counts", 200, authCookie());
  if (!Array.isArray(payload.data)) throw new Error("Expected design counts data array");
  for (const row of payload.data) {
    if (typeof row.design_id !== "string" || typeof row.count !== "number") {
      throw new Error("Expected design count rows with design_id and count");
    }
  }
}

async function expectBlankMatches() {
  const payload = await expectJson(
    "/api/admin/products/blank-matches",
    200,
    authCookie(),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys: [] }),
    },
  );
  if (!Array.isArray(payload.data)) throw new Error("Expected blank matches data array");
}

async function expectInventoryMatrix() {
  const payload = await expectJson("/api/admin/inventory/matrix", 200, authCookie());
  if (!payload.data || typeof payload.data !== "object") throw new Error("Expected inventory matrix object");
  if (!Array.isArray(payload.data.blankRows) || !Array.isArray(payload.data.finishedRows)) {
    throw new Error("Expected inventory matrix blankRows and finishedRows arrays");
  }
}

async function expectJson(path, expectedStatus, cookie, init = {}) {
  const headers = { ...(init.headers || {}), ...(cookie ? { Cookie: cookie } : {}) };
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`Expected ${expectedStatus}, got ${response.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON response, got: ${text.slice(0, 300)}`);
  }
}
