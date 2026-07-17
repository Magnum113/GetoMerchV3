#!/usr/bin/env node

const clientId = process.env.OZON_CLIENT_ID || process.env.OZON_CLIEN_ID;
const apiKey = process.env.OZON_API_KEY;
const baseUrl = (process.env.GETOMERCH_OZON_API_BASE_URL || "https://api-seller.ozon.ru").replace(/\/$/, "");

if (!clientId || !apiKey) fail("Ozon credentials are missing", 2);
if (baseUrl !== "https://api-seller.ozon.ru" && process.env.GETOMERCH_ALLOW_OZON_BASE_URL_OVERRIDE !== "true") {
  fail("Ozon base URL override is not allowed", 2);
}

const now = new Date();
const since = new Date(now.getTime() - 2 * 86_400_000);

await check("FBS postings", "/v3/posting/fbs/list", {
  dir: "ASC",
  filter: { since: since.toISOString(), to: now.toISOString(), status: "" },
  limit: 1,
  offset: 0,
  with: { analytics_data: false, barcodes: false, financial_data: false, translit: true },
});
await check("product prices", "/v5/product/info/prices", {
  filter: { visibility: "ALL" },
  cursor: "",
  limit: 1,
});

console.log("ok - Ozon read-only connectivity checks passed");

async function check(label, path, body) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Client-Id": clientId,
      "Api-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const text = await response.text();
    fail(`${label} returned HTTP ${response.status}: ${text.slice(0, 160)}`, 1);
  }
  await response.json();
  console.log(`ok - ${label} ${Math.round(performance.now() - started)}ms`);
}

function fail(message, code) {
  console.error(message);
  process.exit(code);
}
