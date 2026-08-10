#!/usr/bin/env node

import assert from "node:assert/strict";
import { Pool, type QueryResultRow } from "pg";

const connectionString = process.env.GETOMERCH_DATABASE_URL?.trim();
if (!connectionString) throw new Error("GETOMERCH_DATABASE_URL is required");
const pool = new Pool({
  connectionString,
  max: 4,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 20_000,
  ssl: useSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
});

main().catch((error) => {
  console.error("Stage 9 PostgreSQL checks failed", error);
  process.exitCode = 1;
}).finally(() => pool.end());

async function main() {
  const database = (await pool.query<{ name: string }>(
    "select current_database() as name",
  )).rows[0]?.name;
  if (!database || !/^getomerch_stage9_[a-z0-9_]+$/.test(database)) {
    throw new Error(`Refusing Stage 9 DB tests against database: ${database ?? "unknown"}`);
  }

  await testRestrictedMarkingQueue(database);

  const requestId = crypto.randomUUID();
  const documentId = "SYNTHETIC-DOC-STAGE9";
  const first = await asApp<{ id: string }>(
    "SELECT getomerch_marking.create_crpt_read_query('document_status',NULL,$1,$2,$3::uuid) AS id",
    [documentId, "stage9-db-test", requestId],
  );
  const repeated = await asApp<{ id: string }>(
    "SELECT getomerch_marking.create_crpt_read_query('document_status',NULL,$1,$2,$3::uuid) AS id",
    [documentId, "stage9-db-test", crypto.randomUUID()],
  );
  assert.equal(repeated.rows[0].id, first.rows[0].id);

  const claimed = await asApp<{ query_type: string; code_ciphertext: Buffer | null }>(
    "SELECT * FROM getomerch_marking.claim_crpt_read_query($1::uuid,$2)",
    [first.rows[0].id, "stage9-db-test"],
  );
  assert.equal(claimed.rows[0].query_type, "document_status");
  assert.equal(claimed.rows[0].code_ciphertext, null);
  const completed = await asApp<{ status: string }>(
    "SELECT getomerch_marking.record_crpt_read_success($1::uuid,$2,$3,$4::jsonb,NULL,NULL) AS status",
    [first.rows[0].id, "CHECKED_OK", "CHECKED_OK", JSON.stringify({ documentId, type: "synthetic" })],
  );
  assert.equal(completed.rows[0].status, "succeeded");
  await assert.rejects(
    asApp("SELECT * FROM getomerch_marking.claim_crpt_read_query($1::uuid,$2)", [first.rows[0].id, "stage9-db-test"]),
    (error) => pgCode(error) === "MZ912",
  );
  await assert.rejects(
    asApp("SELECT * FROM public.merch_marking_crpt_queries LIMIT 1"),
    (error) => pgCode(error) === "42501",
  );
  const safe = await asApp<Record<string, unknown>>(
    "SELECT * FROM getomerch_marking.crpt_query_safe WHERE id = $1::uuid",
    [first.rows[0].id],
  );
  assert.equal(safe.rowCount, 1);
  for (const forbidden of ["code_ciphertext", "code_nonce", "code_auth_tag", "token", "signature"]) {
    assert.equal(forbidden in safe.rows[0], false);
  }
  await testUnknownCodeRequiresReview();
  console.log("Stage 9 PostgreSQL idempotency, lifecycle and ACL checks passed");
}

async function testUnknownCodeRequiresReview() {
  const tradeItem = await pool.query<{ id: string }>(`
    INSERT INTO public.merch_marking_trade_items (gtin, product_group)
    VALUES ('04607040840113', 'lp')
    RETURNING id
  `);
  const importBatch = await pool.query<{ id: string }>(`
    INSERT INTO public.merch_marking_import_batches (
      source, file_sha256, file_size_bytes, expected_gtin, trade_item_id,
      acquisition_mode, created_by, expires_at
    ) VALUES (
      'stage9-db-test', repeat('a', 64), 1, '04607040840113', $1::uuid,
      'own_suz_emission', 'stage9-db-test', clock_timestamp() + interval '1 hour'
    )
    RETURNING id
  `, [tradeItem.rows[0].id]);
  const code = await pool.query<{ id: string }>(`
    INSERT INTO public.merch_marking_codes (
      trade_item_id, gtin_snapshot, code_ciphertext, code_nonce, code_auth_tag,
      encryption_key_version, code_hmac, hmac_key_version, fingerprint,
      acquisition_mode, import_batch_id
    ) VALUES (
      $1::uuid, '04607040840113', decode(repeat('11', 24), 'hex'),
      decode(repeat('22', 12), 'hex'), decode(repeat('33', 16), 'hex'),
      1, decode(repeat('44', 32), 'hex'), 1, 'abcdef123456',
      'own_suz_emission', $2::uuid
    )
    RETURNING id
  `, [tradeItem.rows[0].id, importBatch.rows[0].id]);
  const query = await asApp<{ id: string }>(
    "SELECT getomerch_marking.create_crpt_read_query('code_status',$1::uuid,NULL,$2,$3::uuid) AS id",
    [code.rows[0].id, "stage9-db-test", crypto.randomUUID()],
  );
  await asApp("SELECT * FROM getomerch_marking.claim_crpt_read_query($1::uuid,$2)", [
    query.rows[0].id,
    "stage9-db-test",
  ]);
  const result = await asApp<{ status: string }>(
    "SELECT getomerch_marking.record_crpt_read_success($1::uuid,'unknown','UNKNOWN',$2::jsonb,NULL,true) AS status",
    [query.rows[0].id, JSON.stringify({ gtin: "04607040840113", status: "UNKNOWN" })],
  );
  assert.equal(result.rows[0].status, "manual_review");
  const stored = await pool.query<{ crpt_state: string; crpt_status_raw: string }>(
    "SELECT crpt_state, crpt_status_raw FROM public.merch_marking_codes WHERE id = $1::uuid",
    [code.rows[0].id],
  );
  assert.equal(stored.rows[0].crpt_state, "emitted");
  assert.equal(stored.rows[0].crpt_status_raw, "UNKNOWN");
}

async function testRestrictedMarkingQueue(database: string) {
  const role = `stage9_worker_${database.slice("getomerch_stage9_".length)}_${process.pid}`
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 63);
  const coreJobId = crypto.randomUUID();
  await pool.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  try {
    await pool.query(`
      GRANT USAGE ON SCHEMA getomerch_jobs TO ${role};
      GRANT SELECT ON getomerch_jobs.marking_jobs TO ${role};
      GRANT INSERT (
        type, dedupe_key, idempotency_key, request_hash, payload,
        actor, request_id, max_attempts
      ) ON getomerch_jobs.marking_jobs TO ${role};
      GRANT UPDATE (
        status, result, progress, attempt_count, available_at, locked_by,
        locked_at, heartbeat_at, started_at, finished_at, cancel_requested_at,
        error_code, error_message, updated_at
      ) ON getomerch_jobs.marking_jobs TO ${role};
      GRANT EXECUTE ON FUNCTION getomerch_jobs.append_marking_job_event(
        uuid, text, text, jsonb
      ) TO ${role};
    `);
    const inserted = await asRole<{ id: string }>(role, `
      INSERT INTO getomerch_jobs.marking_jobs (
        type, dedupe_key, idempotency_key, request_hash,
        payload, actor, request_id, max_attempts
      ) VALUES (
        'marking_crpt_auth_refresh', 'stage9-marking',
        'stage9-marking-idempotency', repeat('a', 64), '{}'::jsonb,
        'stage9-db-test', $1::uuid, 3
      )
      RETURNING id
    `, [crypto.randomUUID()]);
    const markingJobId = inserted.rows[0].id;
    await asRole(role,
      "SELECT getomerch_jobs.append_marking_job_event($1::uuid,'info','started',$2::jsonb)",
      [markingJobId, JSON.stringify({ phase: "synthetic" })],
    );
    const event = await pool.query<{ event: string }>(
      "SELECT event FROM getomerch_jobs.job_events WHERE job_id = $1::uuid",
      [markingJobId],
    );
    assert.equal(event.rows[0]?.event, "started");
    await assert.rejects(
      asRole(role, "SELECT count(*) FROM getomerch_jobs.jobs"),
      (error) => pgCode(error) === "42501",
    );

    await pool.query(`
      INSERT INTO getomerch_jobs.jobs (
        id, type, dedupe_key, idempotency_key, request_hash,
        payload, actor, request_id, max_attempts
      ) VALUES (
        $1::uuid, 'ozon_orders_sync', 'stage9-core',
        'stage9-core-idempotency', repeat('b', 64), '{}'::jsonb,
        'stage9-db-test', $2::uuid, 3
      )
    `, [coreJobId, crypto.randomUUID()]);
    await assert.rejects(
      asRole(
        role,
        "SELECT getomerch_jobs.append_marking_job_event($1::uuid,'info','invalid',$2::jsonb)",
        [coreJobId, JSON.stringify({ phase: "synthetic" })],
      ),
      (error) => pgCode(error) === "MZ941",
    );
    await assert.rejects(
      asRole(
        role,
        "SELECT getomerch_jobs.append_marking_job_event($1::uuid,'info','invalid',$2::jsonb)",
        [markingJobId, JSON.stringify({ token: "must-not-be-stored" })],
      ),
      (error) => pgCode(error) === "MZ940",
    );
  } finally {
    await pool.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
  }
}

async function asApp<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE getomerch_app");
    const result = await client.query<Row>(text, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function asRole<Row extends QueryResultRow = QueryResultRow>(
  role: string,
  text: string,
  values: unknown[] = [],
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    const result = await client.query<Row>(text, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function pgCode(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (typeof current === "object" && current !== null && "code" in current) {
      return String((current as { code?: unknown }).code);
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return "";
}

function useSsl(value: string) {
  return !value.includes("localhost")
    && !value.includes("127.0.0.1")
    && !value.includes("host=/var/run/postgresql")
    && !value.includes("host=%2Fvar%2Frun%2Fpostgresql");
}
