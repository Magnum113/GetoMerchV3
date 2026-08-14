#!/usr/bin/env node

import assert from "node:assert/strict";
import { Pool, type QueryResultRow } from "pg";

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
  console.error("Mac marking agent PostgreSQL checks failed", error);
  process.exitCode = 1;
}).finally(() => pool.end());

async function main() {
  const database = (await pool.query<{ name: string }>("select current_database() as name")).rows[0]?.name;
  if (!database || !/^getomerch_stage9_[a-z0-9_]+$/.test(database)) {
    throw new Error(`Refusing remote signer DB tests against database: ${database ?? "unknown"}`);
  }
  const agentId = "synthetic-mac-agent";
  const nonce = "a".repeat(32);
  await acceptAgent(agentId, nonce, crypto.randomUUID());
  await assert.rejects(
    acceptAgent(agentId, nonce, crypto.randomUUID()),
    (error) => pgCode(error) === "MZ955",
  );
  const created = await createRequest("1".repeat(64));
  assert.equal(created.request_status, "pending");
  assert.equal(created.reused, false);
  const pendingDuplicate = await createRequest("1".repeat(64));
  assert.equal(pendingDuplicate.signature_request_id, created.signature_request_id);
  assert.equal(pendingDuplicate.request_status, "pending");
  assert.equal(pendingDuplicate.reused, true);
  await assert.rejects(
    asApp(
      "SELECT * FROM getomerch_marking.create_remote_signature_request($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        "crpt_auth_attached_cades_bes",
        "3".repeat(64),
        Buffer.alloc(96, 0x11),
        Buffer.alloc(12, 0x22),
        Buffer.alloc(16, 0x33),
        1,
        "marking-worker",
        crypto.randomUUID(),
        new Date(Date.now() + 120_000),
      ],
    ),
    (error) => pgCode(error) === "42501",
  );
  const claimed = await asApp<{ signature_request_id: string; payload_ciphertext: Buffer }>(
    "SELECT * FROM getomerch_marking.claim_remote_signature_request($1,$2)",
    [agentId, 30],
  );
  assert.equal(claimed.rows[0].signature_request_id, created.signature_request_id);
  assert.equal(claimed.rows[0].payload_ciphertext.length, 96);
  const safe = await asApp<Record<string, unknown>>(
    "SELECT * FROM getomerch_marking.signature_request_safe WHERE id = $1::uuid",
    [created.signature_request_id],
  );
  for (const forbidden of ["payload_ciphertext", "payload_nonce", "signature_ciphertext", "signature_auth_tag"]) {
    assert.equal(forbidden in safe.rows[0], false);
  }
  await asApp(
    `SELECT getomerch_marking.complete_remote_signature_request(
      $1,$2::uuid,$3,$4,$5,1,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12
    )`,
    [
      agentId,
      created.signature_request_id,
      Buffer.alloc(128, 0x5a),
      Buffer.alloc(12, 0x6a),
      Buffer.alloc(16, 0x7a),
      "A".repeat(40),
      "CN=Synthetic remote signer",
      "050000000000",
      "123456789012345",
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 86_400_000),
      "GOST R 34.10-2012-256",
    ],
  );
  const signedDuplicate = await createRequest("1".repeat(64));
  assert.equal(signedDuplicate.signature_request_id, created.signature_request_id);
  assert.equal(signedDuplicate.request_status, "signed");
  assert.equal(signedDuplicate.reused, true);
  const signed = await pool.query<{ request_status: string; certificate_inn: string }>(
    "SELECT * FROM getomerch_marking.get_remote_signature_result($1::uuid,$2)",
    [created.signature_request_id, "marking-worker"],
  );
  assert.equal(signed.rows[0].request_status, "signed");
  assert.equal(signed.rows[0].certificate_inn, "050000000000");
  await pool.query(
    "SELECT getomerch_marking.consume_remote_signature_request($1::uuid,$2)",
    [created.signature_request_id, "marking-worker"],
  );
  const consumed = await pool.query<{ request_status: string }>(
    "SELECT * FROM getomerch_marking.get_remote_signature_result($1::uuid,$2)",
    [created.signature_request_id, "marking-worker"],
  );
  assert.equal(consumed.rows[0].request_status, "consumed");
  await assert.rejects(
    asApp("SELECT * FROM public.merch_marking_signature_requests LIMIT 1"),
    (error) => pgCode(error) === "42501",
  );
  await testFailureRetry(agentId);
  console.log("Mac marking agent PostgreSQL lifecycle, replay and ACL checks passed");
}

async function testFailureRetry(agentId: string) {
  const created = await createRequest("2".repeat(64));
  await asApp("SELECT * FROM getomerch_marking.claim_remote_signature_request($1,$2)", [agentId, 30]);
  const retry = await asApp<{ status: string }>(
    "SELECT getomerch_marking.fail_remote_signature_request($1,$2::uuid,$3,$4,true) AS status",
    [agentId, created.signature_request_id, "provider_pin_unavailable", "PIN is required"],
  );
  assert.equal(retry.rows[0].status, "pending");
  await asApp("SELECT * FROM getomerch_marking.claim_remote_signature_request($1,$2)", [agentId, 30]);
  const failed = await asApp<{ status: string }>(
    "SELECT getomerch_marking.fail_remote_signature_request($1,$2::uuid,$3,$4,false) AS status",
    [agentId, created.signature_request_id, "provider_certificate_error", "Certificate is unavailable"],
  );
  assert.equal(failed.rows[0].status, "failed");
}

async function acceptAgent(agentId: string, nonce: string, requestId: string) {
  return asApp(
    `SELECT getomerch_marking.accept_signing_agent_envelope(
      $1,$2,$3::uuid,clock_timestamp(),$4,'ready',true,true,'unknown',
      $5,clock_timestamp() + interval '1 day','1.0.0',NULL,NULL
    )`,
    [agentId, nonce, requestId, "Synthetic Mac", "A".repeat(40)],
  );
}

async function createRequest(digest: string) {
  const result = await pool.query<{
    signature_request_id: string;
    request_status: string;
    reused: boolean;
  }>(
    `SELECT * FROM getomerch_marking.create_remote_signature_request(
      'crpt_auth_attached_cades_bes',$1,$2,$3,$4,1,'marking-worker',$5::uuid,
      clock_timestamp() + interval '2 minutes'
    )`,
    [digest, Buffer.alloc(96, 0x11), Buffer.alloc(12, 0x22), Buffer.alloc(16, 0x33), crypto.randomUUID()],
  );
  return result.rows[0];
}

async function asApp<Row extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
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
