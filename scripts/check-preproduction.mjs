#!/usr/bin/env node

import crypto from "node:crypto";

const baseUrl = (process.env.ADMIN_BFF_BASE_URL || process.argv[2] || "http://127.0.0.1:3101").replace(/\/$/, "");
const cookieSecret = process.env.ADMIN_AUTH_COOKIE_SECRET;
const cookieName = process.env.ADMIN_AUTH_COOKIE_NAME || "getomerch_admin_session";
const expectedSource = process.env.EXPECTED_DB_READ_SOURCE || "server";
const testPassword = process.env.ADMIN_AUTH_TEST_PASSWORD || "";
const checkKomui = process.env.GETOMERCH_PREPRODUCTION_CHECK_KOMUI !== "false";
const concurrency = boundedInteger(process.env.GETOMERCH_PREPRODUCTION_CONCURRENCY, 4, 1, 8);
const loadRequests = boundedInteger(process.env.GETOMERCH_PREPRODUCTION_REQUESTS, 48, 8, 240);
const p95LimitMs = boundedInteger(process.env.GETOMERCH_PREPRODUCTION_P95_MS, 1_500, 100, 10_000);
const heavyP95LimitMs = boundedInteger(process.env.GETOMERCH_PREPRODUCTION_HEAVY_P95_MS, 5_000, 500, 20_000);
const requestTimeoutMs = boundedInteger(process.env.GETOMERCH_PREPRODUCTION_TIMEOUT_MS, 15_000, 1_000, 60_000);

if (!cookieSecret) fail("ADMIN_AUTH_COOKIE_SECRET is required", 2);
if (!["server", "supabase"].includes(expectedSource)) fail("EXPECTED_DB_READ_SOURCE must be server or supabase", 2);

const validCookie = signedCookie(Math.floor(Date.now() / 1_000) + 3_600);

await runCheck("anonymous and expired authentication boundary", checkAuthenticationBoundary);
await runCheck("login and logout contract", checkLoginLogout);
await runCheck("all primary UI sections", checkUiSections);
await runCheck("health and jobs API", checkOperationalApi);
if (checkKomui) await runCheck("KOMUI production and stage read APIs", checkKomuiTargets);
await runCheck("bounded-concurrency load smoke", checkLoadSmoke);

console.log("ok - stage 9 pre-production checks passed (6 groups)");

async function checkAuthenticationBoundary() {
  await expectStatus("/api/admin/catalog", 401);
  await expectStatus("/api/admin/catalog", 401, { cookie: signedCookie(Math.floor(Date.now() / 1_000) - 60) });
  await expectStatus("/api/admin/catalog", 401, { cookie: `${validCookie}tampered` });

  const page = await request("/inventory", { redirect: "manual" });
  expect([302, 303, 307, 308].includes(page.status), `anonymous page returned ${page.status}`);
  const location = page.headers.get("location") || "";
  expect(location.includes("/login") && location.includes("next="), "anonymous page did not redirect to login with next");
}

async function checkLoginLogout() {
  const loginPage = await request("/login");
  expect(loginPage.status === 200, `login page returned ${loginPage.status}`);
  expect((loginPage.headers.get("content-type") || "").includes("text/html"), "login page did not return HTML");

  const invalid = await request("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": `198.51.100.${crypto.randomInt(1, 250)}`,
    },
    body: JSON.stringify({ password: `invalid-stage9-${crypto.randomUUID()}` }),
  });
  expect(invalid.status === 401, `invalid login returned ${invalid.status}`);
  expect(!invalid.headers.get("set-cookie"), "invalid login unexpectedly set a cookie");

  let sessionCookie = validCookie;
  if (testPassword) {
    const login = await request("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": `203.0.113.${crypto.randomInt(1, 250)}`,
      },
      body: JSON.stringify({ password: testPassword }),
    });
    expect(login.status === 200, `valid test login returned ${login.status}`);
    const setCookie = login.headers.get("set-cookie") || "";
    expect(setCookie.includes(`${cookieName}=`), "valid login did not set the admin cookie");
    expect(/HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), "admin cookie security attributes changed");
    sessionCookie = setCookie.split(";", 1)[0];
  }

  const authenticated = await request("/api/admin/health", { cookie: sessionCookie });
  expect(authenticated.status === 200, `authenticated health returned ${authenticated.status}`);

  const logout = await request("/api/auth/logout", { method: "POST", cookie: sessionCookie });
  expect(logout.status === 200, `logout returned ${logout.status}`);
  const cleared = logout.headers.get("set-cookie") || "";
  expect(cleared.includes(`${cookieName}=`) && /Max-Age=0/i.test(cleared), "logout did not clear the admin cookie");
}

async function checkUiSections() {
  const paths = [
    "/",
    "/products",
    "/designs",
    "/settings",
    "/inventory",
    "/transactions",
    "/workshop",
    "/orders",
    "/expenses",
    "/ozon/import",
    "/komui/runtime",
    "/komui/products",
    "/komui/orders",
  ];
  for (const path of paths) {
    const response = await request(path, { cookie: validCookie });
    expect(response.status === 200, `${path} returned ${response.status}`);
    expect((response.headers.get("content-type") || "").includes("text/html"), `${path} did not return HTML`);
    const body = await response.text();
    expect(body.length > 500, `${path} returned an unexpectedly short page`);
  }
}

async function checkOperationalApi() {
  const health = await jsonRequest("/api/admin/health", { cookie: validCookie });
  expect(health.response.status === 200, `health returned ${health.response.status}`);
  expect(health.payload?.data?.databaseReadSource === expectedSource, "health reported an unexpected read source");

  if (expectedSource === "server") {
    const jobs = await jsonRequest("/api/admin/jobs?limit=20", { cookie: validCookie });
    expect(jobs.response.status === 200, `jobs returned ${jobs.response.status}`);
    expect(Array.isArray(jobs.payload?.data), "jobs API did not return an array");
  }
}

async function checkKomuiTargets() {
  for (const target of ["prod", "stage"]) {
    const cookie = `${validCookie}; komui_api_target=${target}`;
    for (const path of [
      "/api/komui/runtime",
      "/api/komui/storefront/products?limit=2&offset=0",
      "/api/komui/storefront/orders?limit=2&offset=0",
    ]) {
      const { response, payload, text } = await jsonRequest(path, { cookie });
      expect(response.status >= 200 && response.status < 300, `${target} ${path} returned ${response.status}: ${text.slice(0, 160)}`);
      expect(payload !== null && typeof payload === "object", `${target} ${path} did not return JSON data`);
    }
  }
}

async function checkLoadSmoke() {
  const paths = [
    "/api/admin/health",
    "/api/admin/catalog",
    "/api/admin/products?limit=50",
    "/api/admin/inventory?limit=50",
    "/api/admin/inventory/movements?limit=100",
    "/api/admin/workshop/orders?limit=100",
    "/api/admin/ozon/orders?limit=50",
    "/api/admin/expenses?limit=100",
    "/api/admin/finance/ozon?limit=100",
  ];
  const tasks = Array.from({ length: loadRequests }, (_, index) => paths[index % paths.length]);
  const latencies = [];
  let nextIndex = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= tasks.length) return;
      const started = performance.now();
      const response = await request(tasks[index], { cookie: validCookie });
      const text = await response.text();
      expect(response.status === 200, `${tasks[index]} returned ${response.status}: ${text.slice(0, 120)}`);
      latencies.push(Math.round(performance.now() - started));
    }
  }));

  const heavy = [];
  for (let index = 0; index < 4; index += 1) {
    const started = performance.now();
    const response = await request("/api/admin/inventory/matrix", { cookie: validCookie });
    const text = await response.text();
    expect(response.status === 200, `matrix returned ${response.status}: ${text.slice(0, 120)}`);
    heavy.push(Math.round(performance.now() - started));
  }

  const p95 = percentile(latencies, 0.95);
  const heavyP95 = percentile(heavy, 0.95);
  console.log(`metrics - load concurrency=${concurrency} requests=${latencies.length} p95=${p95}ms limit=${p95LimitMs}ms`);
  console.log(`metrics - matrix requests=${heavy.length} p95=${heavyP95}ms limit=${heavyP95LimitMs}ms`);
  expect(p95 <= p95LimitMs, `load p95 ${p95}ms exceeded ${p95LimitMs}ms`);
  expect(heavyP95 <= heavyP95LimitMs, `matrix p95 ${heavyP95}ms exceeded ${heavyP95LimitMs}ms`);
}

async function runCheck(name, check) {
  try {
    await check();
    console.log(`ok - ${name}`);
  } catch (error) {
    fail(`failed - ${name}\n${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

async function expectStatus(path, status, options = {}) {
  const response = await request(path, options);
  const body = await response.text();
  expect(response.status === status, `${path} returned ${response.status}, expected ${status}: ${body.slice(0, 160)}`);
}

async function jsonRequest(path, options = {}) {
  const response = await request(path, options);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${path} did not return JSON: ${text.slice(0, 160)}`);
  }
  return { response, payload, text };
}

function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.cookie) headers.set("Cookie", options.cookie);
  return fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body,
    redirect: options.redirect || "follow",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
}

function signedCookie(exp) {
  const now = Math.floor(Date.now() / 1_000);
  const body = Buffer.from(JSON.stringify({ sub: "owner", iat: now, exp }), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", cookieSecret).update(body).digest("base64url");
  return `${cookieName}=${body}.${signature}`;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] || 0;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message, code) {
  console.error(message);
  process.exit(code);
}
