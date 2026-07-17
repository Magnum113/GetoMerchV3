#!/usr/bin/env node

import { createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { createHash } from "node:crypto";

const [mode, tablesFile, outputDir] = process.argv.slice(2);
const pageSize = 500;
const supabaseUrl = (
  process.env.GETOMERCH_SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  ""
).replace(/\/$/, "");
const serverKey =
  process.env.GETOMERCH_SUPABASE_SERVICE_ROLE_KEY ||
  process.env.GETOMERCH_SUPABASE_SERVER_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "";

if (!new Set(["working", "forensic"]).has(mode) || !tablesFile || !outputDir) {
  throw new Error("usage: getomerch-rest-export.mjs working|forensic TABLES_FILE OUTPUT_DIR");
}
if (!supabaseUrl || !serverKey) {
  throw new Error("Supabase REST URL or server-side key is missing");
}

const tables = readFileSync(tablesFile, "utf8")
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter(Boolean);
if (tables.length === 0 || tables.some((table) => !/^[a-z_][a-z0-9_]*$/.test(table))) {
  throw new Error("table list is empty or contains an unsafe identifier");
}
if (mode === "working" && (tables.length !== 20 || new Set(tables).size !== 20)) {
  throw new Error("working export requires exactly 20 unique tables");
}

const rowsPath = join(outputDir, "rows.ndjson");
const rowsStream = createWriteStream(rowsPath, { encoding: "utf8", mode: 0o600 });
const counts = new Map();
const tableFingerprints = new Map();
const startedAt = new Date().toISOString();

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function requestJson(url, label) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          apikey: serverKey,
          authorization: `Bearer ${serverKey}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        return await response.json();
      }
      const requestId = response.headers.get("x-request-id") || "none";
      const error = new Error(`${label} failed with HTTP ${response.status}, request_id=${requestId}`);
      if (response.status !== 429 && response.status < 500) {
        throw error;
      }
      lastError = error;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) {
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

async function requestExactCount(table) {
  const url = `${supabaseUrl}/rest/v1/${table}?select=*`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "HEAD",
        headers: {
          apikey: serverKey,
          authorization: `Bearer ${serverKey}`,
          prefer: "count=exact",
          range: "0-0",
          "range-unit": "items",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const contentRange = response.headers.get("content-range") || "";
        const match = contentRange.match(/\/(\d+)$/);
        if (!match) {
          throw new Error(`table ${table} did not return an exact count`);
        }
        return Number(match[1]);
      }
      const requestId = response.headers.get("x-request-id") || "none";
      lastError = new Error(
        `table ${table} count failed with HTTP ${response.status}, request_id=${requestId}`,
      );
      if (response.status !== 429 && response.status < 500) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) {
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

async function writeRow(serialized) {
  if (!rowsStream.write(serialized)) {
    await once(rowsStream, "drain");
  }
}

async function exportTable(table, writeRows) {
  let offset = 0;
  let ordered = true;
  let cursor = null;
  let count = 0;
  const digest = createHash("sha256");
  const countBefore = await requestExactCount(table);

  for (;;) {
    const params = new URLSearchParams({
      select: "*",
      limit: String(pageSize),
    });
    if (ordered) {
      params.set("order", "id.asc");
      if (cursor !== null) {
        params.set("id", `gt.${cursor}`);
      }
    } else {
      params.set("offset", String(offset));
    }

    let rows;
    try {
      rows = await requestJson(`${supabaseUrl}/rest/v1/${table}?${params}`, `table ${table}`);
    } catch (error) {
      if (ordered && mode === "forensic" && /HTTP 400/.test(String(error?.message))) {
        ordered = false;
        offset = 0;
        cursor = null;
        count = 0;
        continue;
      }
      throw error;
    }

    if (!Array.isArray(rows)) {
      throw new Error(`table ${table} returned a non-array response`);
    }
    for (const payload of rows) {
      const serialized = `${JSON.stringify({ table_name: table, payload })}\n`;
      digest.update(serialized);
      if (writeRows) {
        await writeRow(serialized);
      }
    }
    count += rows.length;
    if (ordered && rows.length > 0) {
      const lastId = rows.at(-1)?.id;
      if (lastId === undefined || lastId === null) {
        throw new Error(`table ${table} cannot use keyset pagination because id is missing`);
      }
      cursor = String(lastId);
    } else {
      offset += rows.length;
    }
    if (rows.length < pageSize) {
      break;
    }
  }

  const countAfter = await requestExactCount(table);
  if (countBefore !== countAfter || count !== countAfter) {
    throw new Error(
      `table ${table} changed during export: before=${countBefore}, exported=${count}, after=${countAfter}`,
    );
  }
  return {
    count,
    countBefore,
    countAfter,
    sha256: digest.digest("hex"),
  };
}

async function exportAuthUsers() {
  const authPath = join(outputDir, "auth-users.ndjson");
  const authStream = createWriteStream(authPath, { encoding: "utf8", mode: 0o600 });
  let page = 1;
  let count = 0;

  for (;;) {
    const data = await requestJson(
      `${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=1000`,
      "auth users",
    );
    const users = Array.isArray(data?.users) ? data.users : [];
    for (const user of users) {
      if (!authStream.write(`${JSON.stringify(user)}\n`)) {
        await once(authStream, "drain");
      }
    }
    count += users.length;
    if (users.length < 1000) {
      break;
    }
    page += 1;
  }

  authStream.end();
  await once(authStream, "close");
  return count;
}

async function exportPostgrestSchema() {
  const schema = await requestJson(`${supabaseUrl}/rest/v1/`, "PostgREST OpenAPI schema");
  writeFileSync(join(outputDir, "postgrest-openapi.json"), `${JSON.stringify(schema, null, 2)}\n`, {
    mode: 0o600,
  });
}

for (const table of tables) {
  const result = await exportTable(table, true);
  counts.set(table, result.count);
  tableFingerprints.set(table, result.sha256);
}
rowsStream.end();
await once(rowsStream, "close");

let verificationPass = null;
if (mode === "working") {
  const verificationStartedAt = new Date().toISOString();
  for (const table of tables) {
    const result = await exportTable(table, false);
    if (result.count !== counts.get(table) || result.sha256 !== tableFingerprints.get(table)) {
      throw new Error(`table ${table} changed between source snapshot passes`);
    }
  }
  verificationPass = {
    startedAt: verificationStartedAt,
    finishedAt: new Date().toISOString(),
    method: "second full keyset read with exact row-stream SHA-256 comparison",
    status: "stable",
  };
}

let authUserCount = null;
if (mode === "forensic") {
  await exportPostgrestSchema();
  authUserCount = await exportAuthUsers();
}

writeFileSync(
  join(outputDir, "counts.tsv"),
  tables.map((table) => `${table}\t${counts.get(table) ?? 0}\n`).join(""),
  { mode: 0o600 },
);
writeFileSync(
  join(outputDir, "export-manifest.json"),
  `${JSON.stringify(
    {
      mode,
      transport: "supabase-rest",
      startedAt,
      finishedAt: new Date().toISOString(),
      pagination: { pageSize, method: "id keyset when available; offset only for forensic tables without id" },
      consistency: mode === "working"
        ? "exact count before/after plus a stable second full read of every working table"
        : "exact count before/after each table",
      tables: Object.fromEntries(tables.map((table) => [table, counts.get(table) ?? 0])),
      tableFingerprints: Object.fromEntries(
        tables.map((table) => [table, tableFingerprints.get(table)]),
      ),
      verificationPass,
      authUserCount,
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
