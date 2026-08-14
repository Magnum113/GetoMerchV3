#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  MarkingConfigurationError,
  parseMarkingRuntimeConfig,
} from "@/lib/marking/config";
import {
  MarkingKeyring,
  MarkingKeyringError,
  parseMarkingKeyring,
  type EncryptedMarkingValue,
} from "@/lib/marking/security/keyring";
import {
  containsSensitiveMarkingData,
  redactSensitiveData,
  redactText,
  safeErrorForLog,
} from "@/lib/marking/security/redaction";
import { getStageOneMarkingClaimTypes } from "@/lib/marking/worker";
import {
  CORE_JOB_TYPES,
  JOB_TYPES,
  MARKING_JOB_TYPES,
} from "@/lib/jobs/types";

const ROOT = process.cwd();
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".next/cache",
  "node_modules",
  "outputs",
]);
const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

run().catch((error) => {
  console.error("Marking security checks failed.", safeErrorForLog(error));
  process.exitCode = 1;
});

async function run() {
  testConfiguration();
  testRedaction();
  testKeyringAndRecovery();
  testJobIsolation();
  await testRepositoryAndBuildOutput();
  console.log("Marking security checks passed.");
}

function testConfiguration() {
  const defaults = parseMarkingRuntimeConfig({});
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.importEnabled, false);
  assert.equal(defaults.labelsEnabled, false);
  assert.equal(defaults.signerEnabled, false);
  assert.equal(defaults.ozonWriteEnabled, false);
  assert.equal(defaults.crptReadEnabled, false);
  assert.equal(defaults.crptWriteEnabled, false);
  assert.equal(defaults.withdrawalEnabled, false);
  assert.equal(defaults.suzWriteEnabled, false);
  assert.equal(defaults.justInTimeEnabled, false);
  assert.equal(defaults.automationEnabled, false);
  assert.equal(defaults.shippingGateMode, "observe");

  expectConfigurationFailure({ GETOMERCH_MARKING_ENABLED: "maybe" });
  expectConfigurationFailure({ GETOMERCH_MARKING_IMPORT_ENABLED: "true" });
  expectConfigurationFailure({
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_IMPORT_ENABLED: "true",
  });
  expectConfigurationFailure({
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_OZON_WRITE_ENABLED: "true",
  });
  expectConfigurationFailure({
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_OZON_WRITE_ENABLED: "true",
    GETOMERCH_MARKING_ALLOWED_OFFERS: "SYNTHETIC-OFFER-S",
    GETOMERCH_MARKING_KEYRING_FILE: "/run/credentials/marking-keyring",
  });
  expectConfigurationFailure({
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_CRPT_WRITE_ENABLED: "true",
    GETOMERCH_MARKING_ALLOWED_GTINS: "00000000000000",
  });
  expectConfigurationFailure({
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_AUTOMATION_ENABLED: "true",
  });
  expectConfigurationFailure({
    GETOMERCH_MARKING_SHIPPING_GATE_MODE: "enforce",
  });

  const canary = parseMarkingRuntimeConfig({
    GETOMERCH_MARKING_ENABLED: "true",
    GETOMERCH_MARKING_IMPORT_ENABLED: "true",
    GETOMERCH_MARKING_LABELS_ENABLED: "true",
    GETOMERCH_MARKING_SIGNER_ENABLED: "true",
    GETOMERCH_MARKING_OZON_WRITE_ENABLED: "true",
    GETOMERCH_MARKING_CRPT_WRITE_ENABLED: "true",
    GETOMERCH_MARKING_JUST_IN_TIME_ENABLED: "true",
    GETOMERCH_MARKING_AUTOMATION_ENABLED: "true",
    GETOMERCH_MARKING_ALLOWED_GTINS: "00000000000000",
    GETOMERCH_MARKING_ALLOWED_OFFERS: "SYNTHETIC-OFFER-S",
    GETOMERCH_MARKING_ALLOWED_ADMIN_IDS: "owner",
    GETOMERCH_MARKING_KEYRING_FILE: "/run/credentials/marking-keyring",
    GETOMERCH_MARKING_SIGNER_CLIENT_SECRET_FILE: "/run/credentials/signer-client",
    GETOMERCH_MARKING_SIGNER_CLIENTS_FILE: "/run/credentials/signer-clients",
    GETOMERCH_MARKING_SIGNER_CERTIFICATE_FILE: "/run/credentials/signer-certificate",
    GETOMERCH_MARKING_SIGNER_PROVIDER_COMMAND: "/opt/cprocsp/bin/amd64/cryptcp",
    OZON_CLIENT_ID: "synthetic-client",
    OZON_API_KEY: "synthetic-api-key",
  });
  assert.equal(canary.automationEnabled, true);
  assert.deepEqual(canary.allowedOffers, ["SYNTHETIC-OFFER-S"]);
}

function testRedaction() {
  const syntheticKm = buildSyntheticKm();
  const payload = {
    requestId: "synthetic-request",
    nested: {
      cis: syntheticKm,
      normal: `before ${syntheticKm} after`,
    },
    pdfParameters: { width: 58, height: 40 },
  };
  assert.equal(containsSensitiveMarkingData(payload), true);

  const redacted = redactSensitiveData(payload);
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes(syntheticKm), false);
  assert.equal(serialized.includes("[REDACTED]"), true);
  assert.equal(redactText(`failure=${syntheticKm}`).includes(syntheticKm), false);
  const identificationCode = "0104628837736914215Ca'AMGYCM9Tc";
  assert.equal(redactText(`CRPT error for ${identificationCode}.`).includes(identificationCode), false);
  assert.equal(containsSensitiveMarkingData(`CRPT error for ${identificationCode}.`), true);

  const error = new Error(`external failure for ${syntheticKm}`) as Error & {
    code?: string;
  };
  error.code = "external_error";
  const safeError = JSON.stringify(safeErrorForLog(error));
  assert.equal(safeError.includes(syntheticKm), false);
  assert.equal(safeError.includes("external_error"), true);
}

function testKeyringAndRecovery() {
  const encryptionKeyV1 = randomBytes(32);
  const encryptionKeyV2 = randomBytes(32);
  const hmacKeyV1 = randomBytes(32);
  const hmacKeyV2 = randomBytes(32);
  try {
    const serializedV1 = serializeKeyring({
      currentEncryptionKeyVersion: 1,
      encryptionKeys: { 1: encryptionKeyV1 },
      currentHmacKeyVersion: 1,
      hmacKeys: { 1: hmacKeyV1 },
    });
    const ringV1 = parseMarkingKeyring(serializedV1);
    const syntheticKm = buildSyntheticKm();
    const encryptedV1 = ringV1.encrypt(syntheticKm);

    assert.equal(encryptedV1.keyVersion, 1);
    assert.equal(JSON.stringify(encryptedV1).includes(syntheticKm), false);
    assert.equal(ringV1.decrypt(encryptedV1), syntheticKm);
    assert.equal(ringV1.fingerprints(syntheticKm).length, 1);

    const wrongRing = new MarkingKeyring({
      currentEncryptionKeyVersion: 1,
      encryptionKeys: { 1: randomBytes(32).toString("base64") },
      currentHmacKeyVersion: 1,
      hmacKeys: { 1: randomBytes(32).toString("base64") },
    });
    assert.throws(() => wrongRing.decrypt(encryptedV1), MarkingKeyringError);

    const corrupted = corruptCiphertext(encryptedV1);
    assert.throws(() => ringV1.decrypt(corrupted), MarkingKeyringError);

    const serializedV2 = serializeKeyring({
      currentEncryptionKeyVersion: 2,
      encryptionKeys: { 1: encryptionKeyV1, 2: encryptionKeyV2 },
      currentHmacKeyVersion: 2,
      hmacKeys: { 1: hmacKeyV1, 2: hmacKeyV2 },
    });
    const ringV2 = parseMarkingKeyring(serializedV2);
    assert.equal(ringV2.decrypt(encryptedV1), syntheticKm);
    assert.equal(ringV2.encrypt(syntheticKm).keyVersion, 2);
    const rotatedFingerprints = ringV2.fingerprints(syntheticKm);
    assert.deepEqual(rotatedFingerprints.map((item) => item.keyVersion), [2, 1]);

    // Recovery drill: DB backup contains only ciphertext; independently
    // restored keys can decrypt it, while an unrelated keyring cannot.
    const databaseBackup = JSON.stringify({ encryptedCode: encryptedV1 });
    assert.equal(databaseBackup.includes(syntheticKm), false);
    const restoredKeyring = parseMarkingKeyring(serializedV1);
    const restoredRecord = JSON.parse(databaseBackup) as {
      encryptedCode: EncryptedMarkingValue;
    };
    assert.equal(restoredKeyring.decrypt(restoredRecord.encryptedCode), syntheticKm);
    assert.throws(
      () => wrongRing.decrypt(restoredRecord.encryptedCode),
      MarkingKeyringError,
    );
  } finally {
    encryptionKeyV1.fill(0);
    encryptionKeyV2.fill(0);
    hmacKeyV1.fill(0);
    hmacKeyV2.fill(0);
  }
}

function testJobIsolation() {
  assert.equal(MARKING_JOB_TYPES.length, 15);
  assert.equal(new Set(JOB_TYPES).size, JOB_TYPES.length);
  assert.equal(
    MARKING_JOB_TYPES.every((type) => type.startsWith("marking_")),
    true,
  );
  assert.equal(
    CORE_JOB_TYPES.some((type) => type.startsWith("marking_")),
    false,
  );
  assert.deepEqual(getStageOneMarkingClaimTypes(), []);
}

async function testRepositoryAndBuildOutput() {
  const sourceFiles = await collectFiles(ROOT, false);
  const forbiddenPublicName =
    /NEXT_PUBLIC_[A-Z0-9_]*(?:MARKING|CRPT|SUZ)[A-Z0-9_]*/i;
  const privateKeyHeader = /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/;
  const violations: string[] = [];

  for (const file of sourceFiles) {
    const content = await readFile(file, "utf8");
    if (forbiddenPublicName.test(content)) {
      violations.push(`${path.relative(ROOT, file)}: public marking secret name`);
    }
    if (privateKeyHeader.test(content)) {
      violations.push(`${path.relative(ROOT, file)}: private key material`);
    }
  }

  const buildDirectory = path.join(ROOT, ".next");
  if (await exists(buildDirectory)) {
    for (const file of await collectFiles(buildDirectory, true)) {
      const content = await readFile(file, "utf8").catch(() => "");
      if (forbiddenPublicName.test(content)) {
        violations.push(`${path.relative(ROOT, file)}: public marking secret in build`);
      }
      if (privateKeyHeader.test(content)) {
        violations.push(`${path.relative(ROOT, file)}: private key in build`);
      }
    }
  }

  assert.deepEqual(violations, []);
}

function expectConfigurationFailure(env: Record<string, string>) {
  assert.throws(
    () => parseMarkingRuntimeConfig(env),
    MarkingConfigurationError,
  );
}

function buildSyntheticKm() {
  return [
    "01",
    "0".repeat(14),
    "21",
    "SYNTHETIC-SERIAL",
    "91",
    "ABCD",
    "92",
    "X".repeat(44),
  ].join("");
}

function serializeKeyring(input: {
  currentEncryptionKeyVersion: number;
  encryptionKeys: Record<number, Buffer>;
  currentHmacKeyVersion: number;
  hmacKeys: Record<number, Buffer>;
}) {
  return JSON.stringify({
    currentEncryptionKeyVersion: input.currentEncryptionKeyVersion,
    encryptionKeys: Object.fromEntries(
      Object.entries(input.encryptionKeys).map(([version, key]) => [
        version,
        key.toString("base64"),
      ]),
    ),
    currentHmacKeyVersion: input.currentHmacKeyVersion,
    hmacKeys: Object.fromEntries(
      Object.entries(input.hmacKeys).map(([version, key]) => [
        version,
        key.toString("base64"),
      ]),
    ),
  });
}

function corruptCiphertext(value: EncryptedMarkingValue): EncryptedMarkingValue {
  const bytes = Buffer.from(value.ciphertext, "base64");
  bytes[0] ^= 1;
  const ciphertext = bytes.toString("base64");
  bytes.fill(0);
  return { ...value, ciphertext };
}

async function collectFiles(root: string, includeAllExtensions: boolean): Promise<string[]> {
  const output: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    const relative = path.relative(ROOT, absolute);
    if (entry.isDirectory()) {
      if (
        SKIPPED_DIRECTORIES.has(entry.name)
        || SKIPPED_DIRECTORIES.has(relative)
      ) {
        continue;
      }
      output.push(...await collectFiles(absolute, includeAllExtensions));
      continue;
    }
    if (!entry.isFile()) continue;
    if (includeAllExtensions || SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      output.push(absolute);
    }
  }
  return output;
}

async function exists(file: string) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
