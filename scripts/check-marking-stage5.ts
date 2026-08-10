#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  MARKING_IMPORT_MAX_BYTES,
  parseAndEncryptMarkingCodeStream,
} from "@/lib/marking/domain/code-pool";
import { MarkingDomainError } from "@/lib/marking/domain/errors";
import { parseMarkingRuntimeConfig } from "@/lib/marking/config";
import { assertImportAccess } from "@/lib/marking/services/code-pool-service";
import { MarkingKeyring, MarkingKeyringError } from "@/lib/marking/security/keyring";

const ROOT = process.cwd();
const PILOT_GTIN = "04628837736075";
const OTHER_GTIN = makeGtin("0462883773612");

main().catch((error) => {
  console.error("Stage 5 marking-code pool checks failed", error);
  process.exitCode = 1;
});

async function main() {
  await testStreamingImport();
  await testOversizedImport();
  testImportConfiguration();
  await testSourceBoundaries();
  console.log("Stage 5 marking-code import, crypto and API safety checks passed");
}

async function testStreamingImport() {
  const keyring = createKeyring(2);
  const codeOne = syntheticKm(PILOT_GTIN, "SERIAL0000001", "A");
  const codeTwo = syntheticKm(OTHER_GTIN, "SERIAL0000002", "B");
  const invalid = Buffer.from("not-a-marking-code", "ascii");
  const quoted = Buffer.concat([
    Buffer.from("\"", "ascii"),
    codeOne,
    Buffer.from("\"", "ascii"),
  ]);
  const source = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    quoted,
    Buffer.from("\r\n"),
    codeOne,
    Buffer.from("\n"),
    codeTwo,
    Buffer.from("\n"),
    invalid,
  ]);
  const chunks = split(source, [1, 7, 19, 2, 31, 5]);
  const parsed = await parseAndEncryptMarkingCodeStream({
    body: stream(chunks),
    expectedGtin: PILOT_GTIN,
    keyring,
  });

  assert.equal(parsed.rows.length, 4);
  assert.equal(parsed.rows[0].status, "valid");
  assert.equal(parsed.rows[1].status, "duplicate_file");
  assert.equal(parsed.rows[2].status, "gtin_mismatch");
  assert.equal(parsed.rows[3].status, "rejected");
  assert.equal(parsed.rows[0].hmacs?.length, 2);
  assert.equal(parsed.rows[0].fingerprint?.length, 12);
  assert.equal(parsed.rows[0].serial, "SERIAL0000001");

  const encrypted = parsed.rows[0];
  assert.ok(encrypted.ciphertext && encrypted.nonce && encrypted.authTag);
  const decrypted = keyring.decryptBytes({
    algorithm: "aes-256-gcm",
    keyVersion: encrypted.encryptionKeyVersion!,
    ciphertext: encrypted.ciphertext!,
    iv: encrypted.nonce!,
    authTag: encrypted.authTag!,
  });
  try {
    assert.deepEqual(decrypted, codeOne);
  } finally {
    decrypted.fill(0);
  }
  assert.equal(JSON.stringify(parsed).includes(codeOne.toString("binary")), false);

  const unrelated = createKeyring(1);
  assert.throws(
    () => unrelated.decrypt({
      algorithm: "aes-256-gcm",
      keyVersion: encrypted.encryptionKeyVersion!,
      ciphertext: encrypted.ciphertext!,
      iv: encrypted.nonce!,
      authTag: encrypted.authTag!,
    }),
    MarkingKeyringError,
  );
  source.fill(0);
  codeOne.fill(0);
  codeTwo.fill(0);
  invalid.fill(0);
  quoted.fill(0);
}

async function testOversizedImport() {
  const oversized = Buffer.alloc(MARKING_IMPORT_MAX_BYTES + 1, 0x41);
  await assert.rejects(
    parseAndEncryptMarkingCodeStream({
      body: stream([oversized]),
      expectedGtin: PILOT_GTIN,
      keyring: createKeyring(1),
    }),
    (error) => (
      error instanceof MarkingDomainError
      && error.code === "invalid_code_import"
    ),
  );
  oversized.fill(0);
}

function testImportConfiguration() {
  const config = parseMarkingRuntimeConfig({
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_IMPORT_ENABLED: "true",
    GETOMERCH_MARKING_ALLOWED_GTINS: PILOT_GTIN,
    GETOMERCH_MARKING_ALLOWED_ADMIN_IDS: "owner",
    GETOMERCH_MARKING_KEYRING_FILE: "/run/credentials/marking-keyring",
  });
  assertImportAccess(config, "owner", PILOT_GTIN);
  assert.throws(() => assertImportAccess(config, "other", PILOT_GTIN));
  assert.throws(() => assertImportAccess(config, "owner", OTHER_GTIN));
  assert.throws(() => parseMarkingRuntimeConfig({
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_IMPORT_ENABLED: "true",
    GETOMERCH_MARKING_KEYRING_FILE: "/run/credentials/marking-keyring",
  }));
}

async function testSourceBoundaries() {
  const routeFiles = [
    "src/app/api/admin/marking/imports/preview/route.ts",
    "src/app/api/admin/marking/imports/route.ts",
    "src/app/api/admin/marking/imports/[id]/route.ts",
    "src/app/api/admin/marking/imports/[id]/apply/route.ts",
    "src/app/api/admin/marking/pool/route.ts",
    "src/app/api/admin/marking/codes/[id]/quarantine/route.ts",
    "src/app/api/admin/marking/codes/[id]/release/route.ts",
  ];
  for (const file of routeFiles) {
    const source = await readFile(`${ROOT}/${file}`, "utf8");
    assert.match(source, /requireAdminSession|requireMarkingMutationContext/);
  }

  const readModel = await readFile(
    `${ROOT}/src/lib/marking/read-models/repository.ts`,
    "utf8",
  );
  assert.doesNotMatch(readModel, /SELECT\s+\*/i);
  assert.doesNotMatch(
    readModel,
    /code_(?:ciphertext|nonce|auth_tag|hmac)|dedup_hmacs|\bserial\b/i,
  );

  const migration = await readFile(
    `${ROOT}/db/migrations/0009_marking_code_pool.sql`,
    "utf8",
  );
  assert.match(migration, /aes-256-gcm/i);
  assert.match(migration, /security_barrier\s*=\s*true/i);
  assert.match(migration, /scrub_expired_code_imports/i);
  assert.doesNotMatch(
    migration,
    /\b(?:plaintext_code|full_marking_code|raw_marking_code)\b/i,
  );

  const page = await readFile(`${ROOT}/src/app/marking/page.tsx`, "utf8");
  assert.doesNotMatch(
    page,
    /code_(?:ciphertext|nonce|auth_tag|hmac)|dedup_hmacs|crypto_tail/i,
  );

  const scrubScript = await readFile(
    `${ROOT}/scripts/scrub-marking-imports.ts`,
    "utf8",
  );
  assert.match(scrubScript, /scrubExpiredCodeImports/);
  assert.match(scrubScript, /safeErrorForLog/);
  assert.doesNotMatch(scrubScript, /code_(?:ciphertext|nonce|auth_tag|hmac)/i);

  const scrubTimer = await readFile(
    `${ROOT}/ops/systemd/getomerch-marking-import-scrub.timer`,
    "utf8",
  );
  assert.match(scrubTimer, /OnUnitActiveSec=15min/);
  assert.match(scrubTimer, /Persistent=true/);

  const adminCredential = await readFile(
    `${ROOT}/ops/systemd/getomerch-admin-marking-import.conf`,
    "utf8",
  );
  assert.match(adminCredential, /LoadCredential=marking-keyring:/);
}

function createKeyring(versionCount: number) {
  const encryptionKeys: Record<string, string> = {};
  const hmacKeys: Record<string, string> = {};
  for (let version = 1; version <= versionCount; version += 1) {
    encryptionKeys[String(version)] = randomBytes(32).toString("base64");
    hmacKeys[String(version)] = randomBytes(32).toString("base64");
  }
  return new MarkingKeyring({
    currentEncryptionKeyVersion: versionCount,
    encryptionKeys,
    currentHmacKeyVersion: versionCount,
    hmacKeys,
  });
}

function syntheticKm(gtin: string, serial: string, suffix: string) {
  return Buffer.concat([
    Buffer.from(`01${gtin}21${serial}`, "ascii"),
    Buffer.from([0x1d]),
    Buffer.from(`91${suffix}BCD`, "ascii"),
    Buffer.from([0x1d]),
    Buffer.from(`92SIGNATURE-${suffix}-0123456789`, "ascii"),
  ]);
}

function stream(chunks: Buffer[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function split(source: Buffer, sizes: number[]) {
  const chunks: Buffer[] = [];
  let offset = 0;
  let index = 0;
  while (offset < source.length) {
    const size = sizes[index % sizes.length];
    chunks.push(source.subarray(offset, Math.min(source.length, offset + size)));
    offset += size;
    index += 1;
  }
  return chunks;
}

function makeGtin(first13: string) {
  let sum = 0;
  for (let index = 0; index < first13.length; index += 1) {
    sum += Number(first13[index]) * (index % 2 === 0 ? 3 : 1);
  }
  return `${first13}${(10 - (sum % 10)) % 10}`;
}
