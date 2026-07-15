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
  { name: "products read-only with valid cookie returns 200", run: () => expectStatus("/api/admin/products?limit=1", 200, authCookie()) },
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
