#!/usr/bin/env node

import assert from "node:assert/strict";
import { Pool, type QueryResultRow } from "pg";
import { InvalidMarkingCursorError } from "@/lib/marking/read-models/cursor";
import { PostgresMarkingReadRepository } from "@/lib/marking/read-models/repository";

const connectionString = process.env.GETOMERCH_DATABASE_URL?.trim();
if (!connectionString) throw new Error("GETOMERCH_DATABASE_URL is required");

const pool = new Pool({
  connectionString,
  max: 3,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 20_000,
  ssl: useSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
});

main().catch((error) => {
  console.error("Stage 5 read-model checks failed", error);
  process.exitCode = 1;
}).finally(() => pool.end());

async function main() {
  const database = (await pool.query<{ name: string }>(
    "select current_database() as name",
  )).rows[0]?.name;
  if (!database || !/^getomerch_stage5_[a-z0-9_]+$/.test(database)) {
    throw new Error(`Refusing Stage 5 read-model tests against ${database ?? "unknown"}`);
  }
  const repository = new PostgresMarkingReadRepository(async <
    Row extends QueryResultRow = QueryResultRow,
  >(text: string, values: readonly unknown[] = []) => {
    const result = await pool.query<Row>(text, [...values]);
    return { rows: result.rows, rowCount: result.rowCount };
  });

  const firstPage = await repository.listCodePool({ limit: 1 });
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.summary.total >= 2);
  assert.ok(firstPage.summary.available >= 2);
  const first = firstPage.items[0];
  assert.equal(first.fingerprint.length, 12);
  assert.equal(first.gtin.length, 14);
  assert.ok(first.productSkus.some((sku) => sku.startsWith("STAGE5-POOL-")));
  assertSafe(first);

  if (firstPage.page.hasMore) {
    assert.ok(firstPage.page.nextCursor);
    const secondPage = await repository.listCodePool({
      limit: 1,
      cursor: firstPage.page.nextCursor,
    });
    assert.equal(secondPage.items.length, 1);
    assert.notEqual(secondPage.items[0].id, first.id);
  }

  const searched = await repository.listCodePool({
    limit: 10,
    search: first.fingerprint,
  });
  assert.ok(searched.items.some((item) => item.id === first.id));
  const filtered = await repository.listCodePool({
    limit: 10,
    poolState: "available",
    gtin: first.gtin,
  });
  assert.ok(filtered.items.length >= 1);

  const imports = await repository.listCodeImports({ limit: 2 });
  assert.equal(imports.items.length, 2);
  const detail = await repository.getCodeImport(imports.items[0].id);
  assert.ok(detail);
  assert.ok(detail!.rows.length >= 1);
  assertSafe(detail);

  const events = await repository.listEvents({
    limit: 50,
    eventType: "marking_code_imported",
  });
  assert.ok(events.items.length >= 1);
  assert.ok(events.items.every((event) => event.markingCodeId));
  assertSafe(events);

  await assert.rejects(
    repository.listCodePool({ limit: 10, cursor: "not-a-valid-cursor" }),
    InvalidMarkingCursorError,
  );
  await assert.rejects(
    repository.listCodeImports({ limit: 10, cursor: "not-a-valid-cursor" }),
    InvalidMarkingCursorError,
  );

  console.log("Stage 5 safe pool/import read-model checks passed");
}

function assertSafe(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "code_ciphertext",
    "code_nonce",
    "code_auth_tag",
    "code_hmac",
    "dedup_hmacs",
    "encryption_key_version",
    "hmac_key_version",
    "serial",
    "crypto_tail",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `leaked field: ${forbidden}`);
  }
}

function useSsl(value: string) {
  try {
    return !["", "localhost", "127.0.0.1", "::1"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}
